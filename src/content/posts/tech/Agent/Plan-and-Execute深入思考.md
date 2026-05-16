---
title: 'Plan-and-Execute Agent：从"知道"到"理解"'
published: 2026-05-16
tags: ["Agent", "Plan-Execute", "DAG"]
category: Agent
description: '学完 Plan-and-Execute 之后，我能说出大致的思想和实现，但如果再往深挖一层，追问具体的设计理由、实现细节，我就卡壳。这篇文章是我尝试把模糊的理解变成清晰认知的过程——用一个真实任务走完全部代码，把每个"为什么这样做"都讲透。'
draft: false
---
# Plan-and-Execute Agent：从"知道"到"理解"

> 学完 Plan-and-Execute 之后，我能说出大致的思想和实现，但如果再往深挖一层，追问具体的设计理由、实现细节，我就卡壳。这篇文章是我尝试把模糊的理解变成清晰认知的过程——用一个真实任务走完全部代码，把每个"为什么这样做"都讲透。

## 我的困惑

学了两遍 Plan-and-Execute，我发现自己处于一种"似懂非懂"的状态：

- 我知道整体是"先规划后执行"，但具体数据怎么在模块之间流转，说不清
- 我知道拓扑排序和两遍扫描，但为什么要这样设计，说不清
- 我知道有 replan 机制，但 50% 这个阈值的完整理由链，说不清
- 我知道每个 Task 执行要调 LLM，但为什么需要循环、循环里到底发生了什么，说不清
- 我知道最终要返回结果，但为什么取叶子节点，说不清

根本原因：**我在跟着 Java 版代码实现，缺少对设计决策背后"为什么"的思考。** 下面的内容是我尝试补上这一课的记录。

## 用一个真实任务走完全部代码

用户输入：**"读取 config.json，分析里面的数据库配置，然后写一份分析报告到 report.txt"**

我用这个任务，从第一行代码走到最后一行，把每一步发生了什么、为什么这样设计，都展开讲清楚。

### 第一步：为什么分离规划与执行

代码入口：

```python
def run(self, goal: str) -> str:
    return self._run_with_plan(goal)
```

注意：这里**没有判断复杂度**。旧版本有一个 `_should_plan()` 方法，靠关键词计数决定走规划还是走简单模式，但最新版删掉了。为什么？

两个原因。第一，判断不准——用户说"帮我看看这个文件"只有 4 个字，但可能需要多步操作；用户说"创建一个 Spring Boot 项目"只有一个关键词，但其实是复杂任务。第二，职责混乱——"用什么模式"是用户的事，不是 Agent 的事，应该由 CLI 层的 `/plan` 命令来决定。

**面试答法**：ReAct 是边推理边执行，碰到复杂任务会出现两个结构性缺陷——上下文窗口爆炸导致遗忘目标，以及无法利用独立步骤的并行性。Plan-Execute 通过先拆解再执行解决这两个问题。代价是多一次规划调用，且规划质量决定上限。

### 第二步：为什么用 LLM 拆任务而不用规则

```python
def create_plan(self, goal: str) -> ExecutionPlan:
    messages = [
        Message.system(PLANNING_PROMPT),
        Message.user(f"请为以下任务制定执行计划：\n{goal}"),
    ]
    response = self._llm.chat(messages)   # 注意：没有传 tools
    return self._parse_plan(goal, response.content or "")
```

为什么不能写 if-else 来拆任务？因为用户的输入是自然语言——"帮我读一下 main.py 然后分析结构再写个总结文件"，这种话你写规则拆不开。只有 LLM 能理解语义，判断哪些步骤是独立的、哪些有先后。

但 LLM 输出不稳定，所以 PLANNING_PROMPT 做了三件事来约束：

1. **限定任务类型**（只有 FILE_READ / FILE_WRITE / COMMAND / ANALYSIS / VERIFICATION 五种），不让 LLM 自由发挥
2. **给定 JSON schema**，要求按固定格式输出
3. **规定"只输出 JSON"**，减少废话干扰解析

还有一个细节：**这里调 LLM 没有传 tools 参数**。规划是纯文本生成，不需要调用工具。

LLM 返回的 JSON：

```json
{
    "summary": "读取配置文件并分析数据库配置",
    "tasks": [
        {"id": "task_1", "description": "读取 config.json 文件", "type": "FILE_READ", "dependencies": []},
        {"id": "task_2", "description": "分析数据库配置信息", "type": "ANALYSIS", "dependencies": ["task_1"]},
        {"id": "task_3", "description": "写分析报告到 report.txt", "type": "FILE_WRITE", "dependencies": ["task_2"]}
    ]
}
```

### 第三步：两遍扫描——为什么是容错设计

`_parse_plan()` 拿到 JSON 后，不是一遍搞定，而是分两遍：

**第一遍：创建所有 Task 对象**

```python
id_mapping: dict[str, str] = {}
for i, task_node in enumerate(tasks_data, 1):
    original_id = task_node.get("id", f"task_{i}")   # LLM 给的 id
    new_id = f"task_{i}"                              # 统一映射
    id_mapping[original_id] = new_id

    plan.add_task(Task(id=new_id, description=..., type=...))
```

为什么需要 id_mapping？LLM 给的 id 不可控，可能是 `read_config`、`step1`、`分析任务`，需要统一映射成 `task_1, task_2`。而且 LLM 可能在 dependencies 里写的 id 和实际的 id 对不上，映射表来对齐。

走完第一遍，三个 Task 对象都建好了，但 dependencies 和 dependents 都是空的。

**第二遍：处理依赖关系**

```python
for i, task_node in enumerate(tasks_data, 1):
    for dep_id in task_node.get("dependencies", []):
        mapped = id_mapping.get(dep_id, dep_id)
        if plan.get_task(mapped) is not None:
            task.dependencies.append(mapped)
            dep_task = plan.get_task(mapped)
            dep_task.dependents.append(new_id)
```

为什么不能一遍搞定？因为 LLM 可能写出前向引用——`task_2 依赖 task_3`，而 task_3 在 JSON 里排在 task_2 后面。遍历到 task_2 时 task_3 还没创建，依赖关系就连不上。第一遍先全部创建，第二遍再连边，不管 LLM 怎么排都能正确解析。

**两遍扫描本质上是容错设计**：不是假设 LLM 的输出一定按顺序排列，而是不管它怎么排都能处理。如果直接在遇到前向引用时报错，用户体验很差——LLM 稍微调整一下顺序就好了，但你让用户重新跑一遍。

走完第二遍的内存状态：

```
task_1: dependencies=[],          dependents=["task_2"]
task_2: dependencies=["task_1"],  dependents=["task_3"]
task_3: dependencies=["task_2"],  dependents=[]
```

这就是一个 DAG（有向无环图）的双向邻接表。

### 第四步：拓扑排序——为什么保证执行顺序

```python
if not plan.compute_execution_order():
    raise ValueError("计划中存在循环依赖")
```

拓扑排序用的是 DFS + 两个集合（visiting 和 visited），走一遍具体过程：

```
处理 task_1:
  visiting = {task_1}
  task_1 没有依赖 → 不递归
  visiting 移除 task_1, visited 加入 task_1
  execution_order = [task_1]

处理 task_2:
  visiting = {task_2}
  依赖 task_1 → task_1 已在 visited → 跳过
  visiting 移除 task_2, visited 加入 task_2
  execution_order = [task_1, task_2]

处理 task_3:
  visiting = {task_3}
  依赖 task_2 → task_2 已在 visited → 跳过
  visiting 移除 task_3, visited 加入 task_3
  execution_order = [task_1, task_2, task_3]
```

两个集合各司其职：

- `visiting`：当前 DFS 路径上的节点，用来**检测环**——如果同一个节点在递归栈里出现两次，就是环
- `visited`：所有已处理完的节点，用来**避免重复处理**

时间复杂度 O(V+E)，每个节点访问一次，每条依赖边检查一次。

### 第五步：执行计划——逐个跑 Task

```python
def _execute_plan(self, goal, plan):
    for task_id in plan.execution_order:        # [task_1, task_2, task_3]
        task = plan.get_task(task_id)

        tasks_map = {t.id: t for t in plan.all_tasks}
        if not task.is_executable(tasks_map):   # 所有依赖都 COMPLETED 了吗？
            task.mark_skipped()
            continue

        task.mark_started()
        result = self._execute_task(goal, plan, task)
        task.mark_completed(result)
```

`is_executable()` 的判断逻辑：自己必须是 PENDING + 所有依赖必须 COMPLETED。如果依赖是 FAILED 或 SKIPPED，当前任务永远不会变可执行，最终也被跳过。

#### 执行 task_1（FILE_READ：读取 config.json）

`_execute_task()` 现在有一个 ReAct 循环（MAX_TASK_ITERATIONS = 5），这是最新版本的关键改进。

先构建上下文：

```python
prompt = EXECUTION_PROMPT.format(type="FILE_READ", desc="读取 config.json 文件")
messages = [
    Message.system(prompt),
    Message.user(self._build_task_context(goal, plan, task)),
]
```

`_build_task_context` 生成的 user message：

```
总目标：读取 config.json，分析数据库配置，然后写一份分析报告到 report.txt
当前任务：读取 config.json 文件
依赖任务：无
请执行此任务。
```

进入循环：

```
第 1 轮：
  LLM 返回 → tool_calls: [{name: "read_file", args: {"path": "config.json"}}]
  → messages.append(assistant(tool_calls))    # 记录 LLM 的决策
  → 执行 read_file → result = "文件内容:\n{\"db\": {\"host\": \"localhost\"...}}"
  → all_results.append(result)                # 累积结果
  → messages.append(tool_result(tc.id, result))  # 结果回灌给 LLM

第 2 轮：
  LLM 看到文件内容了，不需要再调工具
  → has_tool_calls() == False
  → return response.content    // "已成功读取 config.json"
```

**为什么一个任务需要多轮？** 如果只调一次 LLM，LLM 调了 read_file 拿到内容就返回了——它没有机会基于文件内容做任何后续操作。加了循环之后，第一轮读文件 → 结果回灌 messages → 第二轮 LLM 看到内容，给出确认或继续操作。

`messages` 和 `all_results` 各自的作用：

- `messages`：当前任务的对话历史，让 LLM 在多轮之间保持上下文连续性
- `all_results`：所有工具调用的结果累积器，即使循环跑满了 5 次上限，也能把已收集的结果返回

为什么上限是 5？大多数任务 2-3 轮就够了，设太高浪费 Token 和时间，设太低复杂任务完不成。5 是安全余量。

#### 执行 task_2（ANALYSIS：分析数据库配置）

`_build_task_context` 这回有依赖了：

```
总目标：读取 config.json，分析数据库配置，然后写一份分析报告到 report.txt
当前任务：分析数据库配置信息
依赖任务结果：
- task_1 / 读取 config.json 文件 / 状态=COMPLETED
  文件内容:\n{"db": {"host": "localhost"...}}
请执行此任务。如果是ANALYSIS类型，请基于以上上下文直接给出结果。
```

关键点：task_1 的 result 被塞进了上下文。LLM 能直接看到文件内容，不需要再调 read_file 工具。

```
第 1 轮：
  LLM 返回 → content: "数据库配置分析：host 为 localhost，端口 3306..."
  → has_tool_calls() == False
  → return response.content
```

**这就是 ANALYSIS 类型不需要工具的原因**：上下文里已经有所需信息了，LLM 直接分析输出。EXECUTION_PROMPT 里有一句"如果是ANALYSIS或VERIFICATION类型任务，请直接输出分析结果"，就是这个作用。

#### 执行 task_3（FILE_WRITE：写分析报告）

和 task_1 类似，LLM 调 write_file 工具，结果回灌，下一轮确认写入成功后返回。

### 第六步：为什么取叶子节点作为最终结果

所有任务执行完后：

```python
def _build_final_result(plan):
    leaf_results = [t.result for t in plan.all_tasks if not t.dependents and t.result]
```

遍历所有任务找叶子节点（没有 dependents 的任务）：

- task_1: dependents=["task_2"] → 不是叶子
- task_2: dependents=["task_3"] → 不是叶子
- task_3: dependents=[] → **是叶子**

为什么只返回叶子节点？因为中间任务的结果已经被后续任务消费了。用户不需要看到 task_1 的"文件内容是 ABC"，也不需要看到 task_2 的"分析结论是 XYZ"——task_3 的"已成功写入报告"就是最终产出。取叶子节点就是在说"只给用户看最终结果，中间过程已经消费掉了"。

兜底逻辑（`reversed(plan.all_tasks)`）是防万一：如果所有任务都有 dependents（理论上不应该发生），就取最后一个有结果的。

### 第七步：失败重规划——50% 阈值的成本收益

```python
except Exception as e:
    task.mark_failed(str(e))
    if plan.progress < 0.5:
        replanned = self._planner.replan(plan, str(e))
        return self._execute_plan(goal, replanned)
    final_parts.append(f"任务 {task_id} 失败: {e}")
```

`plan.progress` = 已完成任务数 / 总任务数。50% 是"半程线"。

为什么不是 20% 或 80%？

- 如果阈值 20%（只完成不到 20% 才 replan）：太激进了，完成 25% 时规划已经明显有问题了但不 replan，浪费后续执行
- 如果阈值 80%（完成不到 80% 都 replan）：太保守了，完成 70% 时 replan 等于丢弃了之前几十次 LLM 调用的成果，Token 白白浪费
- **50% 是折中**：完成不到一半说明规划本身有问题，值得重来；超过一半说明大部分任务是对的，带伤跑完比重来更划算

`replan()` 做了什么？把失败原因和已完成任务的描述喂给 LLM，重新调一次 `create_plan()`。本质上是用新的上下文重新走一遍"规划 → 解析 → 排序 → 执行"的完整流程。

## 全景图

把上面的流程压缩成一张数据流图，这就是 Plan-and-Execute 的完整设计全景：

```
用户: "读取 config.json，分析数据库配置，写报告到 report.txt"
  │
  ▼
Planner.create_plan(goal)
  │
  ├─ 调 LLM（不带工具，纯文本生成）→ 拿回 JSON 字符串
  │
  ├─ _parse_plan():
  │   ├─ 第一遍：建 Task 对象 + id_mapping（容错：不管 LLM 怎么排都能建出来）
  │   ├─ 第二遍：连 dependencies + dependents（双向邻接表）
  │   └─ compute_execution_order() → DFS 拓扑排序（visiting 检测环，visited 防重复）
  │
  ▼
ExecutionPlan {
  execution_order: [task_1, task_2, task_3]
  task_1: type=FILE_READ,  deps=[],        result=null
  task_2: type=ANALYSIS,   deps=[task_1],  result=null
  task_3: type=FILE_WRITE, deps=[task_2],  result=null
}
  │
  ▼
_execute_plan() 逐个执行:
  │
  ├─ task_1 (FILE_READ):
  │   _execute_task():
  │     build context → 调 LLM(带工具) → read_file → 结果回灌 messages → 再调 LLM → 完成
  │   task_1.result = "文件内容..."
  │
  ├─ task_2 (ANALYSIS):
  │   _execute_task():
  │     build context（塞了 task_1.result）→ 调 LLM → 直接输出分析 → 完成
  │   task_2.result = "分析：数据库配置..."
  │
  ├─ task_3 (FILE_WRITE):
  │   _execute_task():
  │     build context（塞了 task_2.result）→ 调 LLM(带工具) → write_file → 结果回灌 → 完成
  │   task_3.result = "已写入报告"
  │
  ▼
_build_final_result():
  找叶子节点（没有 dependents 的任务）→ task_3
  返回 task_3.result 给用户
```

## 八个设计决策的完整总结

| 设计决策               | 为什么这样做                                       | 不这样做的后果                                   |
| ---------------------- | -------------------------------------------------- | ------------------------------------------------ |
| 分离规划与执行         | ReAct 对复杂任务会遗忘目标、无法并行               | 多一次 LLM 调用的成本                            |
| 用 LLM 拆任务          | 自然语言的任务分解需要语义理解，规则搞不定         | 输出不稳定，需要 schema 约束                     |
| 两遍扫描解析           | 前向引用——task_2 可能依赖还没创建的 task_3       | 一遍扫描会丢失依赖关系                           |
| 拓扑排序               | 保证执行顺序正确，同时检测循环依赖                 | 环依赖导致无限循环                               |
| Task 内 ReAct 循环     | 单个任务可能需要多轮工具调用（读文件→分析→确认） | 只调一次 LLM 的话，工具执行完没有机会做后续操作  |
| replan 阈值 50%        | 完成不到一半说明规划有问题，超过一半带伤跑完更划算 | 阈值太高浪费 Token，太低会错过需要 replan 的时机 |
| 取叶子节点作为最终结果 | 中间任务的结果已被后续消费，用户只关心最终产出     | 返回中间过程信息，干扰用户理解                   |
| 删掉 _should_plan      | 判断不准 + 职责不在 Agent（模式选择归 CLI 层）     | Agent 职责不清晰                                 |
| 最小上下文策略         | 只塞直接依赖的 result，省 Token                    | 可能丢失间接依赖的信息                           |

---

## 附录

### 附录 A：plan_execute_agent.py（最新版）

<details>
<summary>plan_execute_agent.py（158 行）</summary>

```python
"""Plan-and-Execute Agent — 先规划后执行。"""
from __future__ import annotations

from paicli.llm.client import LlmClient, Message
from paicli.llm import debug_logger
from paicli.plan.planner import Planner
from paicli.plan.task import Task, TaskStatus
from paicli.tool.registry import ToolRegistry

EXECUTION_PROMPT = """你是一个任务执行专家。请根据当前任务和上下文，选择合适的工具或生成回复。

当前任务类型：{type}
任务描述：{desc}

可用工具：
1. read_file - 读取文件内容，参数：{{"path": "文件路径"}}
2. write_file - 写入文件内容，参数：{{"path": "文件路径", "content": "内容"}}
3. execute_command - 执行命令，参数：{{"command": "命令"}}
4. create_project - 创建项目，参数：{{"name": "名称", "type": "java|python|node"}}

如果是ANALYSIS或VERIFICATION类型任务，请直接输出分析结果，不需要调用工具。

请用中文回复。"""

MAX_TASK_ITERATIONS = 5


class PlanExecuteAgent:
    """Plan-and-Execute Agent — 复杂任务分解后执行。"""

    def __init__(self, llm_client: LlmClient) -> None:
        self._llm = llm_client
        self._tools = ToolRegistry()
        self._planner = Planner(llm_client)

    def run(self, goal: str) -> str:
        """运行任务：规划 → 执行。"""
        try:
            return self._run_with_plan(goal)
        except Exception as e:
            debug_logger.generate_html_report()
            return f"❌ 执行失败: {e}"

    def _run_with_plan(self, goal: str) -> str:
        plan = self._planner.create_plan(goal)
        return self._execute_plan(goal, plan)

    def _execute_plan(self, goal: str, plan) -> str:
        print(plan.visualize())
        print("🚀 开始执行计划...\n")

        plan.mark_started()
        final_parts: list[str] = []

        for task_id in plan.execution_order:
            task = plan.get_task(task_id)
            if task is None:
                continue

            tasks_map = {t.id: t for t in plan.all_tasks}
            if not task.is_executable(tasks_map):
                print(f"⏭️ 跳过任务（依赖未完成）: {task_id}")
                task.mark_skipped()
                continue

            print(f"▶️ 执行任务: {task.description}")
            task.mark_started()

            try:
                result = self._execute_task(goal, plan, task)
                task.mark_completed(result)
                preview = result[:100] + ("..." if len(result) > 100 else "")
                print(f"✅ 完成: {preview}\n")

            except Exception as e:
                task.mark_failed(str(e))
                print(f"❌ 失败: {e}\n")

                if plan.progress < 0.5:
                    print("🔄 尝试重新规划...\n")
                    replanned = self._planner.replan(plan, str(e))
                    return self._execute_plan(goal, replanned)
                final_parts.append(f"任务 {task_id} 失败: {e}")

        if not final_parts:
            final_parts.append(self._build_final_result(plan))

        if plan.has_failed:
            plan.mark_failed()
            debug_logger.generate_html_report()
            return "⚠️ 计划部分完成，有任务失败。\n" + "\n".join(final_parts)

        plan.mark_completed()
        debug_logger.generate_html_report()
        return "✅ 计划执行完成！\n" + "\n".join(final_parts)

    def _execute_task(self, goal: str, plan, task: Task) -> str:
        """执行单个任务：多轮工具调用循环（类似 ReAct）。"""
        prompt = EXECUTION_PROMPT.format(type=task.type.value, desc=task.description)
        messages: list[Message] = [
            Message.system(prompt),
            Message.user(self._build_task_context(goal, plan, task)),
        ]

        all_results: list[str] = []

        for iteration in range(MAX_TASK_ITERATIONS):
            response = self._llm.chat(messages, tools=self._tools.get_tool_definitions())

            if not response.has_tool_calls():
                if all_results and not (response.content or "").strip():
                    return "\n".join(all_results).strip()
                return response.content or ""

            messages.append(Message.assistant(content=response.content, tool_calls=response.tool_calls))

            for tc in response.tool_calls:
                tool_name = tc.function.name
                print(f"   🔧 调用工具: {tool_name}")
                result = self._tools.execute_tool(tc.function.name, tc.function.arguments)
                debug_logger.log_tool_result(self._llm._call_id, tc.function.name, tc.function.arguments, result)
                all_results.append(result)
                messages.append(Message.tool_result(tc.id, result))

        return "\n".join(all_results).strip()

    @staticmethod
    def _build_task_context(goal: str, plan, task: Task) -> str:
        parts = [f"总目标：{goal}", f"当前任务：{task.description}"]
        if task.dependencies:
            parts.append("依赖任务结果：")
            for dep_id in task.dependencies:
                dep = plan.get_task(dep_id)
                if dep is None:
                    continue
                parts.append(f"- {dep.id} / {dep.description} / 状态={dep.status.value}")
                if dep.result:
                    parts.append(dep.result)
        else:
            parts.append("依赖任务：无")
        parts.append("请执行此任务。如果是ANALYSIS或VERIFICATION类型，请基于以上上下文直接给出结果。")
        return "\n".join(parts)

    @staticmethod
    def _build_final_result(plan) -> str:
        leaf_results = [
            t.result for t in plan.all_tasks
            if not t.dependents and t.result
        ]
        if leaf_results:
            return "\n".join(leaf_results)
        last = next((t.result for t in reversed(plan.all_tasks) if t.result), None)
        return last or ""
```

</details>

### 附录 B：planner.py

<details>
<summary>planner.py（137 行）</summary>

```python
"""规划器 — 使用 LLM 将复杂任务分解为执行计划。"""
from __future__ import annotations

import json
import re
import time

from paicli.llm.client import LlmClient, Message
from paicli.plan.task import Task, TaskType
from paicli.plan.execution_plan import ExecutionPlan

PLANNING_PROMPT = """你是一个任务规划专家。请将用户的复杂任务分解为一系列可执行的子任务。

可用任务类型：
- FILE_READ: 读取文件内容
- FILE_WRITE: 写入文件内容
- COMMAND: 执行Shell命令
- ANALYSIS: 分析结果并做出决策
- VERIFICATION: 验证结果是否正确

请按以下JSON格式输出执行计划：
{
    "summary": "任务摘要",
    "tasks": [
        {
            "id": "task_1",
            "description": "任务描述",
            "type": "FILE_READ",
            "dependencies": []
        },
        {
            "id": "task_2",
            "description": "任务描述",
            "type": "FILE_WRITE",
            "dependencies": ["task_1"]
        }
    ]
}

规则：
1. 每个任务必须有唯一的id（如 task_1, task_2）
2. dependencies列出依赖的任务id
3. 任务应该按执行顺序排列
4. 任务描述要具体明确
5. 复杂任务拆分为5-10个子任务

只输出JSON，不要有其他内容。"""


class Planner:
    """使用 LLM 将复杂任务分解为 ExecutionPlan。"""

    def __init__(self, llm_client: LlmClient) -> None:
        self._llm = llm_client

    def create_plan(self, goal: str) -> ExecutionPlan:
        print(f"📋 正在规划任务: {goal}\n")
        messages = [
            Message.system(PLANNING_PROMPT),
            Message.user(f"请为以下任务制定执行计划：\n{goal}"),
        ]
        response = self._llm.chat(messages)
        return self._parse_plan(goal, response.content or "")

    def replan(self, failed_plan: ExecutionPlan, failure_reason: str) -> ExecutionPlan:
        print(f"🔄 重新规划，原因: {failure_reason}\n")
        context_parts = [
            f"原任务: {failed_plan.goal}",
            f"失败原因: {failure_reason}",
            "已完成的任务:",
        ]
        for task in failed_plan.all_tasks:
            if task.status == TaskStatus.COMPLETED:
                context_parts.append(f"- {task.id}: {task.description}")
        context_parts.append("\n请制定新的执行计划，避开之前的问题。")
        return self.create_plan("\n".join(context_parts))

    def _parse_plan(self, goal: str, plan_json: str) -> ExecutionPlan:
        cleaned = re.sub(r"```json\s*", "", plan_json)
        cleaned = re.sub(r"```\s*", "", cleaned).strip()

        data = json.loads(cleaned)
        summary = data.get("summary", "")
        tasks_data = data.get("tasks", [])

        plan = ExecutionPlan(f"plan_{int(time.time() * 1000)}", goal)
        plan.summary = summary

        # 第一遍：创建任务（不处理依赖，因为可能有前向引用）
        id_mapping: dict[str, str] = {}
        for i, task_node in enumerate(tasks_data, 1):
            original_id = task_node.get("id", f"task_{i}")
            new_id = f"task_{i}"
            id_mapping[original_id] = new_id

            description = task_node.get("description", "")
            type_str = task_node.get("type", "ANALYSIS")
            task_type = self._parse_task_type(type_str)

            plan.add_task(Task(id=new_id, description=description, type=task_type))

        # 第二遍：处理依赖关系
        for i, task_node in enumerate(tasks_data, 1):
            new_id = f"task_{i}"
            task = plan.get_task(new_id)
            if task is None:
                continue

            for dep_id in task_node.get("dependencies", []):
                mapped = id_mapping.get(dep_id, dep_id)
                if plan.get_task(mapped) is not None:
                    task.dependencies.append(mapped)
                    dep_task = plan.get_task(mapped)
                    if dep_task is not None and new_id not in dep_task.dependents:
                        dep_task.dependents.append(new_id)

        if not plan.compute_execution_order():
            raise ValueError("计划中存在循环依赖")

        return plan

    @staticmethod
    def _parse_task_type(type_str: str) -> TaskType:
        try:
            return TaskType(type_str.upper())
        except ValueError:
            return TaskType.ANALYSIS
```

</details>

### 附录 C：task.py

<details>
<summary>task.py（77 行）</summary>

```python
"""任务节点 — 表示一个可执行的任务单元。"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum


class TaskType(Enum):
    PLANNING = "PLANNING"
    FILE_READ = "FILE_READ"
    FILE_WRITE = "FILE_WRITE"
    COMMAND = "COMMAND"
    ANALYSIS = "ANALYSIS"
    VERIFICATION = "VERIFICATION"


class TaskStatus(Enum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    SKIPPED = "SKIPPED"


@dataclass
class Task:
    """一个可执行的任务单元，带依赖关系和状态追踪。"""
    id: str
    description: str
    type: TaskType
    status: TaskStatus = TaskStatus.PENDING
    result: str | None = None
    error: str | None = None
    dependencies: list[str] = field(default_factory=list)
    dependents: list[str] = field(default_factory=list)
    start_time: float = 0.0
    end_time: float = 0.0

    def mark_started(self) -> None:
        self.status = TaskStatus.RUNNING
        self.start_time = time.time()

    def mark_completed(self, result: str) -> None:
        self.status = TaskStatus.COMPLETED
        self.result = result
        self.end_time = time.time()

    def mark_failed(self, error: str) -> None:
        self.status = TaskStatus.FAILED
        self.error = error
        self.end_time = time.time()

    def mark_skipped(self) -> None:
        self.status = TaskStatus.SKIPPED
        self.end_time = time.time()

    @property
    def duration_ms(self) -> float:
        if self.start_time == 0:
            return 0.0
        end = self.end_time or time.time()
        return (end - self.start_time) * 1000

    def is_executable(self, all_tasks: dict[str, Task]) -> bool:
        if self.status != TaskStatus.PENDING:
            return False
        for dep_id in self.dependencies:
            dep = all_tasks.get(dep_id)
            if dep is None or dep.status != TaskStatus.COMPLETED:
                return False
        return True

    def __str__(self) -> str:
        return f"Task[{self.id}: {self.description}] ({self.status.value})"
```

</details>

### 附录 D：execution_plan.py

<details>
<summary>execution_plan.py（157 行）</summary>

```python
"""执行计划 — 包含一组有依赖关系的任务，支持拓扑排序与可视化。"""
from __future__ import annotations

import time
from enum import Enum

from paicli.plan.task import Task, TaskStatus


class PlanStatus(Enum):
    CREATED = "CREATED"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


class ExecutionPlan:
    """执行计划：管理一组带依赖关系的任务，拓扑排序决定执行顺序。"""

    def __init__(self, plan_id: str, goal: str) -> None:
        self.id = plan_id
        self.goal = goal
        self.summary: str = ""
        self.status = PlanStatus.CREATED
        self._tasks: dict[str, Task] = {}
        self._execution_order: list[str] = []
        self.start_time: float = 0.0
        self.end_time: float = 0.0

    def add_task(self, task: Task) -> None:
        self._tasks[task.id] = task
        for dep_id in task.dependencies:
            dep = self._tasks.get(dep_id)
            if dep is not None and task.id not in dep.dependents:
                dep.dependents.append(task.id)

    def get_task(self, task_id: str) -> Task | None:
        return self._tasks.get(task_id)

    @property
    def all_tasks(self) -> list[Task]:
        return list(self._tasks.values())

    @property
    def root_tasks(self) -> list[Task]:
        return [t for t in self._tasks.values() if not t.dependencies]

    @property
    def executable_tasks(self) -> list[Task]:
        tasks_map = {t.id: t for t in self._tasks.values()}
        return [t for t in self._tasks.values() if t.is_executable(tasks_map)]

    def compute_execution_order(self) -> bool:
        self._execution_order.clear()
        visited: set[str] = set()
        visiting: set[str] = set()

        for task in self._tasks.values():
            if task.id not in visited:
                if not self._topological_sort(task, visited, visiting):
                    return False
        return True

    def _topological_sort(self, task: Task, visited: set[str], visiting: set[str]) -> bool:
        if task.id in visiting:
            return False
        if task.id in visited:
            return True

        visiting.add(task.id)
        for dep_id in task.dependencies:
            dep = self._tasks.get(dep_id)
            if dep is not None:
                if not self._topological_sort(dep, visited, visiting):
                    return False

        visiting.discard(task.id)
        visited.add(task.id)
        self._execution_order.append(task.id)
        return True

    @property
    def execution_order(self) -> list[str]:
        if not self._execution_order:
            self.compute_execution_order()
        return list(self._execution_order)

    @property
    def progress(self) -> float:
        if not self._tasks:
            return 1.0
        completed = sum(1 for t in self._tasks.values() if t.status == TaskStatus.COMPLETED)
        return completed / len(self._tasks)

    @property
    def is_all_completed(self) -> bool:
        return all(t.status == TaskStatus.COMPLETED for t in self._tasks.values())

    @property
    def has_failed(self) -> bool:
        return any(t.status == TaskStatus.FAILED for t in self._tasks.values())

    def mark_started(self) -> None:
        self.status = PlanStatus.RUNNING
        self.start_time = time.time()

    def mark_completed(self) -> None:
        self.status = PlanStatus.COMPLETED
        self.end_time = time.time()

    def mark_failed(self) -> None:
        self.status = PlanStatus.FAILED
        self.end_time = time.time()

    _STATUS_ICONS = {
        TaskStatus.PENDING: "⏳",
        TaskStatus.RUNNING: "▶️",
        TaskStatus.COMPLETED: "✅",
        TaskStatus.FAILED: "❌",
        TaskStatus.SKIPPED: "⏭️",
    }

    def visualize(self) -> str:
        lines: list[str] = []
        lines.append("╔══════════════════════════════════════════════════════════╗")
        goal_display = self.goal if len(self.goal) <= 46 else self.goal[:43] + "..."
        lines.append(f"║  执行计划: {goal_display:<46}║")
        lines.append("╠══════════════════════════════════════════════════════════╣")

        for i, task_id in enumerate(self.execution_order, 1):
            task = self._tasks[task_id]
            icon = self._STATUS_ICONS.get(task.status, "?")
            deps = "无" if not task.dependencies else ",".join(task.dependencies)
            desc = task.description if len(task.description) <= 50 else task.description[:47] + "..."
            lines.append(f"║  {i}. {icon} {task.id:<20} [{task.type.value:<10}] 依赖: {deps:<10}║")
            lines.append(f"║     {desc}")

        lines.append("╚══════════════════════════════════════════════════════════╝")
        lines.append(f"   进度: {self.progress * 100:.0f}% | 状态: {self.status.value}")
        return "\n".join(lines)

    def __str__(self) -> str:
        return f"ExecutionPlan[{self.id}: {self.goal}] ({len(self._tasks)} tasks, {self.status.value})"
```

</details>
