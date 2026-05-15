---
title: "Plan-and-Execute Agent：先规划后执行"
published: 2026-05-15
tags: ["Agent", "LLM", "ReAct", "Plan-Execute", "DAG"]
category: Agent
description: "在 ReAct Agent 的基础上实现 Plan-and-Execute 模式，用 LLM 拆解复杂任务、DAG 管理依赖、拓扑排序编排执行顺序。写完之后的体感却让我发现了更深层的问题。"
draft: false
---

> 本文基于 paicli 项目的实践，记录从 ReAct Agent 到 Plan-and-Execute Agent 的实现过程、踩过的坑，以及这些坑引出的架构思考。

# Plan-and-Execute Agent：先规划后执行

## 起因

ReAct Agent 写完之后，简单任务能跑通了，但碰到"先读这个文件，分析一下结构，然后创建一个新文件，最后跑一下测试确认"这种多步骤任务，Agent 就开始迷路了——做到第二步忘了第一步的结果，做完测试忘了原始目标是什么。

ReAct 的本质是"走一步看一步"，每一步的决策只基于当前的上下文窗口。任务一复杂，上下文一长，模型就容易丢失全局视野。

于是我决定给 PaiCLI 加上 **Plan-and-Execute** 模式——和 ReAct 同层级的另一种 Agent 策略，核心思想是：**先让 LLM 把任务拆解清楚，再按顺序逐个执行。**

## 整体设计

Plan-and-Execute 的流程用一张图就能说清楚：

```
用户说了一句话
     │
     ▼
  ┌──────────┐    简单    ┌──────────┐
  │判断复杂度  │ ────────→ │直接 ReAct │
  └────┬─────┘           └──────────┘
       │ 复杂
       ▼
  ┌──────────┐
  │ Planner  │ ← 调 LLM，拿到 JSON 任务列表
  └────┬─────┘
       ▼
  ┌──────────────┐
  │ExecutionPlan │ ← 拓扑排序，决定执行顺序
  └────┬─────────┘
       ▼
  按顺序逐个执行 Task ← 每个任务再调一次 LLM
```

实现拆成三个角色、一个算法：

| 角色 | 一句话 | 类比 |
|------|--------|------|
| **Task** | 一个待办事项，有状态和依赖 | 便签条 |
| **ExecutionPlan** | 一组便签条，按拓扑序排好 | 看板 |
| **Planner** | 调 LLM 把目标拆成便签条 | 项目经理 |

一个算法：**拓扑排序**——用 DFS + 两个集合（visiting 检测环、visited 防重复）保证执行顺序正确。

## 实现过程

### 第一步：让 AI 帮我加了规划与执行功能

前面的文章里提到过，我已经封装好了 LLMClient、ChatResponse、Tool、ToolRegistry 这些基础设施。于是让 AI 帮我在这个基础上加 Plan-and-Execute 功能。

AI 很快搞出来了四个文件：

```
plan/
├── task.py            → Task 数据模型
├── execution_plan.py  → DAG 编排引擎
├── planner.py         → LLM 规划器
agent/
├── plan_execute_agent.py  → 总调度
```

代码看着人畜无害，结构清晰，让我逐个看看它做了什么。

### 第二步：理解每个模块做了什么

#### Task — 便签条

最简单的数据模型，一个 dataclass：

```python
@dataclass
class Task:
    id: str
    description: str
    type: TaskType                    # FILE_READ / FILE_WRITE / COMMAND / ANALYSIS / VERIFICATION
    status: TaskStatus = TaskStatus.PENDING
    result: str | None = None
    error: str | None = None
    dependencies: list[str] = field(default_factory=list)   # 我依赖谁
    dependents: list[str] = field(default_factory=list)     # 谁依赖我
```

两个列表形成了 DAG 的双向边。为什么需要 `dependents`？可以从 `dependencies` 反推，但每次都要遍历全部任务。有了 `dependents` 就能 O(1) 查到谁依赖我——空间换时间，DAG 里叫邻接表的双向表示。

关键方法是 `is_executable()`：自己必须是 PENDING + 所有依赖必须 COMPLETED，否则不能执行。

#### ExecutionPlan — 看板

管理一组 Task，核心是**拓扑排序**：

```python
def _topological_sort(self, task, visited, visiting):
    if task.id in visiting:
        return False              # 环！当前路径上又碰到了
    if task.id in visited:
        return True               # 已经处理过了

    visiting.add(task.id)         # 标记"正在处理"
    for dep_id in task.dependencies:       # 先递归处理所有依赖
        dep = self._tasks.get(dep_id)
        if dep is not None:
            if not self._topological_sort(dep, visited, visiting):
                return False

    visiting.discard(task.id)     # 处理完了，移出"正在处理"
    visited.add(task.id)          # 标记"已完成"
    self._execution_order.append(task.id)  # 加入结果序列
    return True
```

用具体例子走一遍。假设有四个任务：

```
task_1 (无依赖)
task_2 (依赖 task_1)
task_3 (依赖 task_1)
task_4 (依赖 task_2, task_3)
```

从 task_1 开始 DFS：没有依赖，直接加入结果序列。从 task_2 开始：依赖 task_1，task_1 已处理，跳过，加入 task_2。task_3 同理。task_4 的两个依赖都已处理，加入。最终顺序：`[task_1, task_2, task_3, task_4]`。

两个集合各司其职：`visiting` 是当前 DFS 路径上的节点，用来检测环；`visited` 是所有已处理完的节点，用来避免重复处理。

#### Planner — 项目经理

调一次 LLM，拿到一个 JSON 字符串，解析成 ExecutionPlan。最值得说的是 `_parse_plan()` 的**两遍扫描**：

LLM 返回的 JSON 长这样：

```json
{
    "tasks": [
        {"id": "task_1", "description": "读取配置文件", "type": "FILE_READ", "dependencies": []},
        {"id": "task_2", "description": "创建项目", "type": "COMMAND", "dependencies": ["task_1"]},
        {"id": "task_3", "description": "分析结果", "type": "ANALYSIS", "dependencies": ["task_2"]}
    ]
}
```

为什么不能一遍搞定？假设 LLM 输出 `task_2 依赖 task_3`（前向引用），遍历到 task_2 时 task_3 还没创建，`plan.get_task("task_3")` 返回 None，依赖关系就丢了。所以第一遍先把所有 Task 对象建出来，同时建一个 id 映射表（LLM 给的 id 不可控，可能是 `read_config`、`step1`，需要统一映射成 `task_1, task_2`），第二遍再处理依赖关系。

#### PlanExecuteAgent — 总调度

整个执行流程串起来就六步：

```
① 判断复杂度（关键词计数 ≥ 3？）
② Planner 拿 goal 调 LLM → 拿回 JSON 字符串
③ _parse_plan() 两遍扫描：建 Task + id 映射 → 连依赖边
④ 拓扑排序 → 有环报错，没环得到 execution_order
⑤ 按 execution_order 逐个执行：封装 prompt → 调 LLM → 拿结果
⑥ 取叶子节点结果 → 返回给用户
```

有一个亮点设计：**失败重规划**。某个 Task 执行抛异常时，检查全局完成度，如果进度不到 50% 就自动 replan——把失败原因和已完成任务喂给 LLM，重新生成计划。超过 50% 就不重来，带伤返回，因为 replan 的成本（重新调 LLM）已经不值得了。

## 真实体感：问题比想象的多

代码看着挺好，真的让它去执行一个东西吧，极其不稳定。下面是使用过程中明显能发现的问题：

### 1. Agent 随机停

同一个任务，有时输入后 Agent 执行了一个 listdir 工具，莫名其妙就退出这一轮次了，任务都还没完成。但再执行一次又正常了，正常得像之前没有发生过。

**根因**：`_run_simple()` 只调了一次 LLM，没有循环。如果工具执行完还需要再分析、再调工具，它做不到。

```python
def _run_simple(self, user_input: str) -> str:
    messages = [Message.system("你是一个智能编程助手..."), Message.user(user_input)]
    response = self._llm.chat(messages, tools=...)
    if response.has_tool_calls():
        # 执行工具，返回结果——然后呢？没有然后了
        return "\n".join(results)
    return response.content or ""
```

### 2. 轮数不一致

同样的任务同样的输入，有时 2 轮成功，有时 5 轮过度探索。LLM 本身是非确定性的（temperature > 0），加上 prompt 里没有明确的终止条件，模型自己想一出是一出。

### 3. 上下文遗忘

`_run_simple` 每次调用都新建 messages 列表，没有任何历史记忆。LLM 看不到之前的对话，当然会遗忘目标。Plan-Execute 的 `_execute_task` 也一样——每个任务的 prompt 是独立构建的，只塞了直接依赖的 result，没有完整的对话历史。

### 4. 每次都执行 listdir

LLM 不记得之前已经探索过目录了。没有文件系统状态缓存，每次都从头开始。

### 5. 遵循差

System prompt 太弱，缺乏对模型行为的约束。

### 6. 上下文爆炸

涉及读写文件时，文件内容全量塞进 messages，没有任何压缩或截断。外面 Agent 循环执行三次，里面每次循环五六轮，MAX_ROUNDS = 10 很快就不够用。

## Debug 过程

面对这一堆问题，我一开始确实不知道怎么解决。只能去查 LLM 交互过程中的所有传入信息——让 Agent 把每个轮次的请求、响应、工具调用、工具结果全放在 JSON 日志里，方便事后查看。

很快发现，但凡稍微执行四五个轮次，尤其涉及文件读写，那上下文是真的又臭又长。然后让 AI 搞了个脚本，把日志 JSON 可视化成 Web 页面，区分工具调用、System Prompt、请求响应等，每个轮次标记一下，能折叠。Debug 看日志的感觉稍微好了一点。

这时候我才真正体会到：**Agent 的代码不好写。** 主要的难度在于，Agent 代码不像传统代码拥有高度确定性。代码看着确实能跑，但多跑两次，过程就不一致、不稳定。上下文长的时候找问题真累——它的问题不是编译错误、异常这种，全是运行时能跑但需要肉眼去看逻辑的东西。发现问题之后改 bug 也不容易，因为要改就是逻辑层面、设计层面的事情。

## 从问题出发的深层思考

以上六个问题，按根因归类其实是三个根本原因：

| 根因 | 导致的问题 |
|------|-----------|
| 没有循环 | 随机停、轮数不一致 |
| 上下文一次性的 | 遗忘用户目的、每次都 listdir |
| 没有上下文管理 | 上下文爆炸 |

核心就三件事：**加循环、维护历史、管好上下文窗口。** 这三个是所有 Agent 系统的基础设施，跟用 ReAct 还是 Plan-Execute 无关。

但顺着这些问题深挖下去，我产生了更多的思考。

### 思考一：任务拆得好不好，全看 System Prompt

Plan-Execute 整个链路的质量天花板就是 Planner 的那一次 LLM 调用。Prompt 写得差，拆出来的任务就有问题——漏了关键步骤、依赖关系搞错、粒度不合理（太大或太碎）。

而且我在使用的时候，看不到 LLM 设定的 Task 列表是否合理。未来应该加一个**人工确认环节**：LLM 生成 Plan 后展示给用户，用户确认或修改后再执行。如果用户给了修改意见，就把反馈喂给 LLM 重新规划。也就是 **Human-in-the-Loop** 设计。

### 思考二：每个 Task 的上下文该怎么构造

LLM 是无状态的，Task 的效果受限于它的上下文。当前代码只塞了直接依赖的 result，但不同类型的任务需要不同的上下文策略：

- `FILE_READ` 类型：塞目标文件路径就够了，不需要前置上下文
- `ANALYSIS` 类型：需要把所有前置结果都塞进来
- `VERIFICATION` 类型：需要原始目标 + 待验证的产出

一刀切地构造上下文是不够的，应该按任务类型定制。

### 思考三：每个 Task 应该是一个 ReAct 循环

现在的 `_execute_task()` 只调一次 LLM，如果工具执行完还需要继续分析，它做不到。每个 Task 应该是一个完整的微型 Agent——有自己的循环、历史、终止条件。其实就是 **SubAgent** 的概念。

### 思考四：Task 能不能并行

看这个 DAG：

```
task_1 (读文件A)
task_2 (读文件B)    ← task_1 和 task_2 没有依赖关系
task_3 (合并分析)   ← 依赖 task_1 和 task_2
```

task_1 和 task_2 完全可以并行执行，当前代码却是串行的。改造思路是每轮取所有 `executable_tasks`（当前所有依赖已完成的任务），并行跑，跑完更新状态，再取下一批。

### 思考五：评测怎么测

Plan-and-Execute 要测三个层级：

| 层级 | 测什么 | 怎么测 |
|------|--------|--------|
| **规划质量** | 拆的任务是否合理、依赖是否正确 | 给固定 goal，检查 LLM 返回的 JSON 结构 |
| **执行质量** | 每个 Task 是否能独立完成 | 构造固定 Plan，逐个跑 Task，看结果 |
| **端到端** | 最终结果是否符合用户预期 | 准备 benchmark 任务集，跑完整流程 |

最关键的是规划质量——如果拆错了，后面全错。可以准备 10 个典型任务，手动写好标准 Plan 作为 ground truth，让 LLM 生成的 Plan 和标准 Plan 对比。

### 思考六：Task 全放内存会不会丢

会。进程挂了就全丢了，长时间任务跑一半中断无法恢复。

放文件系统的好处：持久化（进程中断可恢复）、共享（不同 Task/SubAgent 可以读同一个中间文件）、调试（直接查看中间状态）。

生产系统的做法是**混合**：内存里维护运行时状态，同时持久化到文件系统做 checkpoint。每个 Task 完成后写一次 checkpoint，进程重启后从最近的 checkpoint 恢复。

## 总结：Plan-Execute 的真实瓶颈

回过头看这次实践，Plan-Execute 的思想很简单——先规划后执行，但实现之后发现，**规划只是第一步，真正难的是执行层和基础设施**：

| 瓶颈 | 根因 | 改进方向 |
|------|------|----------|
| 任务拆不好 | 依赖单次 LLM 调用 + Prompt 质量 | 多轮规划 + Human-in-the-Loop |
| Task 执行不稳定 | 每个 Task 只调一次 LLM，没有循环 | Task 内部加 ReAct 循环（SubAgent） |
| 上下文不够 | 只塞直接依赖的 result | 按任务类型定制上下文策略 |
| 串行执行慢 | 没有利用独立任务的并行性 | 按轮次并行执行 executable_tasks |
| 无法恢复 | 全在内存 | checkpoint 持久化 |
| 难以评测 | 没有分层评测体系 | 规划质量 / 执行质量 / 端到端三层评测 |

Plan-Execute 不是 ReAct 的升级替代，而是同层级的另一种策略。ReAct 灵活但容易迷路，Plan-Execute 有全局视野但依赖规划质量。真正能打的 Agent 系统，应该是两者的结合：用 Plan-Execute 做全局编排，用 ReAct 做局部执行。

这些思考，至少对我来说，比代码本身更有价值。

---

## 附录

### 附录 A：task.py — Task 数据模型

<details>
<summary>task.py（77 行）</summary>

```python title="src/paicli/plan/task.py"
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
        """所有依赖都已完成才能执行。"""
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

### 附录 B：execution_plan.py — DAG 编排引擎

<details>
<summary>execution_plan.py（157 行）</summary>

```python title="src/paicli/plan/execution_plan.py"
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
        """计算拓扑排序。返回 False 表示有环。"""
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

### 附录 C：planner.py — LLM 规划器

<details>
<summary>planner.py（137 行）</summary>

```python title="src/paicli/plan/planner.py"
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
        """为复杂任务创建执行计划。"""
        print(f"📋 正在规划任务: {goal}\n")

        messages = [
            Message.system(PLANNING_PROMPT),
            Message.user(f"请为以下任务制定执行计划：\n{goal}"),
        ]

        response = self._llm.chat(messages)
        return self._parse_plan(goal, response.content or "")

    def replan(self, failed_plan: ExecutionPlan, failure_reason: str) -> ExecutionPlan:
        """根据执行结果重新规划。"""
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
        """解析 LLM 生成的计划 JSON。"""
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

### 附录 D：plan_execute_agent.py — 总调度

<details>
<summary>plan_execute_agent.py（180 行）</summary>

```python title="src/paicli/agent/plan_execute_agent.py"
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

_ACTION_KEYWORDS = ("创建", "写", "读", "执行", "编译", "运行", "修改", "删除", "然后", "接着", "再", "最后")


class PlanExecuteAgent:
    """Plan-and-Execute Agent — 自动判断是否需要规划，复杂任务分解后执行。"""

    def __init__(self, llm_client: LlmClient) -> None:
        self._llm = llm_client
        self._tools = ToolRegistry()
        self._planner = Planner(llm_client)

    def run(self, user_input: str) -> str:
        """运行任务，自动判断走规划还是直接执行。"""
        try:
            if self._should_plan(user_input):
                return self._run_with_plan(user_input)
            return self._run_simple(user_input)
        except Exception as e:
            debug_logger.generate_html_report()
            return f"❌ 执行失败: {e}"

    @staticmethod
    def _should_plan(input_text: str) -> bool:
        action_count = sum(1 for kw in _ACTION_KEYWORDS if kw in input_text)
        return action_count >= 3 or len(input_text) > 50

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
        """执行单个任务：调 LLM → 如有工具调用则执行。"""
        prompt = EXECUTION_PROMPT.format(type=task.type.value, desc=task.description)
        messages = [
            Message.system(prompt),
            Message.user(self._build_task_context(goal, plan, task)),
        ]

        response = self._llm.chat(messages, tools=self._tools.get_tool_definitions())

        if response.has_tool_calls():
            results: list[str] = []
            for tc in response.tool_calls:
                print(f"   🔧 调用工具: {tc.function.name}")
                result = self._tools.execute_tool(tc.function.name, tc.function.arguments)
                debug_logger.log_tool_result(self._llm._call_id, tc.function.name, tc.function.arguments, result)
                results.append(result)
            return "\n".join(results)

        return response.content or ""

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

    def _run_simple(self, user_input: str) -> str:
        print("💡 简单任务，直接执行...\n")

        messages = [
            Message.system("你是一个智能编程助手，可以调用工具完成任务。"),
            Message.user(user_input),
        ]
        response = self._llm.chat(messages, tools=self._tools.get_tool_definitions())

        if response.has_tool_calls():
            results: list[str] = []
            for tc in response.tool_calls:
                result = self._tools.execute_tool(tc.function.name, tc.function.arguments)
                debug_logger.log_tool_result(self._llm._call_id, tc.function.name, tc.function.arguments, result)
                results.append(result)
            debug_logger.generate_html_report()
            return "\n".join(results)

        debug_logger.generate_html_report()
        return response.content or ""
```

</details>
