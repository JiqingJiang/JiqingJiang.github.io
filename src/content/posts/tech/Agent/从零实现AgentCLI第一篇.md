---
title: "从零实现 Agent CLI"
published: 2026-05-13
tags: ["Agent", "LLM", "ReAct", "工程实践"]
category: Agent
description: "从最小可行 Agent 出发，理解 ReAct 循环的原理，并在动手写代码之前预判四个核心工程问题。"
draft: false
---

> 本文基于我自己写的 Agent CLI 项目 paicli 的实践，所有代码都是真实运行过的。

# 从零实现 Agent CLI

一个最小版本的 Agent 需要哪些东西？

LLM 本质上是无状态的一次性推理引擎：没有记忆，不能行动，每次请求都是一次独立的 HTTP 调用。它不知道请求是谁发的，也不知道之前聊过什么，只负责基于当前 prompt 生成下一次 token。

要让它变成能真正"干活"的 Agent（类似 Claude Code 的 CLI），我们必须补齐它的短板。思路其实很直观：

1. **加循环**：把一次性推理变成多轮持续交互。
2. **加记忆**：用一个列表把历史对话装起来，每次请求时带上，LLM 就拥有了上下文。
3. **加工具**：让 LLM 做决策，本地代码去执行实际动作（读写文件、调 API、跑命令）。
4. **加反馈**：把工具执行结果回灌给 LLM，让它基于新信息继续推理。

这样一个 MVP 版本的 Agent 就成型了。其中最核心的运转逻辑就是大名鼎鼎的 **ReAct 循环**（Reason + Act + Observe）：

```
用户输入
  ↓
LLM 推理（Reason）
  ↓
需要调用工具？──→ 是 ──→ 本地执行工具（Act）
  │                            ↓
  否                      结果回灌（Observe）
  ↓                            ↓
返回最终回复 ←───────────────────┘
```

用代码写出来，核心就是一个 `for` 循环：

```python
def run(self, user_input: str) -> str:
    self._history.append(Message.user(user_input))

    for i in range(MAX_ITERATIONS):
        response = self._llm.chat(
            messages=self._history,
            tools=self._tools.get_tool_definitions(),
        )

        if response.has_tool_calls():
            self._history.append(Message.assistant(content=response.content, tool_calls=response.tool_calls))
            for tc in response.tool_calls:
                result = self._tools.execute_tool(tc.function.name, tc.function.arguments)
                self._history.append(Message.tool_result(tc.id, result))
        else:
            self._history.append(Message.assistant(content=response.content))
            return response.content

    return "❌ 达到最大迭代次数限制，任务未完成"
```

这就是我 paicli 项目中 `agent.py` 的核心逻辑，已经跑通了基础的 ReAct 循环——用户提问 → LLM 决策调工具 → 本地执行 → 结果回灌 → LLM 给出最终回复，整个流程能完整走通。

但写完之后我发现，原理简单和工程可靠是两回事。在把 MVP 变成能日常使用的工具之前，有 4 个工程问题必须提前想清楚。

## 问题 1：ReAct 循环怎么停？
理论上，LLM 是大脑，tool_calls 是手脚。什么时候停，完全取决于模型自己判断"任务完成了"。OpenAI 和 Anthropic 的响应里都有 `stop_reason` / `finish_reason` 字段，模型说停就停。

但问题在于：**模型不一定知道该停。**

可能出现的情况包括：
- 模型调用工具后没拿到有效信息，又用同样的参数重试
- 多个工具交替调用（A→B→A→B），陷入局部最优
- 缺少"已执行历史"的感知，每次推理都像失忆

我目前的做法是最简单粗暴的硬限制：

```python
MAX_ITERATIONS = 10
```

无论模型怎么折腾，最多跑 10 轮就强制退出。这个数字不是拍脑袋的——大部分合理任务 5~7 轮内就能完成，10 轮已经留了余量。

但这只是兜底。更完善的做法还有两层：

- **软检测**：记录最近几步的 `(tool_name, params_hash)`，如果重复出现，说明模型陷入了循环，此时在 prompt 里注入提示让模型换思路。
- **状态注入**：每次循环前，把"已完成的动作清单"压缩成一行摘要塞进 system prompt，让模型知道进度条在哪。

目前 paicli 只实现了硬限制，后面两层还在计划中。

## 问题 2：LLM 怎么知道有哪些工具？它真的会用吗？

"在请求里带上工具定义不就行了？"——这是我一开始的想法，但实际写下来发现没这么简单。

工具定义不仅告诉 LLM "你能用什么"，它本质上也是 Prompt 的一部分——模型在生成 tool_calls 时，schema 定义是它直接看到的上下文。

**反面教材：裸奔的参数定义**

```json
{
  "tools": [{
    "name": "read_file",
    "description": "读取文件",
    "parameters": { "path": "string" }
  }]
}
```

这个定义有两个问题：第一，没有用完整的 JSON Schema（缺少 `type: "object"`、`properties`、`required`），模型可能自由发挥，传一些你根本不接受的参数；第二，description 太模糊，模型不知道什么样的路径是合法的。

**正确的做法**

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "path": { "type": "string", "description": "文件相对路径，例如 'src/main.py'" }
    },
    "required": ["path"],
    "additionalProperties": false
  }
}
```

三个关键点：

1. **`additionalProperties: false`**：禁止模型自由发挥，只接受你定义的字段。
2. **`required`**：明确哪些字段必传，减少参数缺失。
3. **`description` 里写 Few-Shot 示例**：比在 system prompt 里重复强调有效得多，因为离模型决策点越近的提示，权重越高。

OpenAI 后来还推出了 `"strict": true`，底层用有限状态机在 Token 生成阶段做语法剪枝，实现 100% Schema 对齐。但对于兼容多种 LLM 的框架来说，不能依赖特定厂商的特性，所以规范的 JSON Schema 定义才是通用解。

## 问题 3：工具执行失败了，Agent Loop 会怎样？

这是我在写 `ToolRegistry.execute_tool()` 时重点考虑的问题：

```python
def execute_tool(self, name: str, arguments_json: str) -> str:
    tool = self._tools.get(name)
    if tool is None:
        return f"未知工具: {name}"

    try:
        args = json.loads(arguments_json)
        return tool.executor(args)
    except json.JSONDecodeError as e:
        return f"参数解析失败: {e}"
    except Exception as e:
        return f"工具执行失败: {e}"
```

核心原则：**LLM 是概率模型，不是调试器。它需要的是可操作的反馈，而不是堆栈。**

所以即使底层工具抛了异常，也不能把 Python 的 Traceback 直接返回给模型——满屏的 `FileNotFoundError`、`json.decoder.JSONDecodeError` 只会让模型懵圈，要么胡乱编造路径重试，要么直接放弃任务。

目前 paicli 只做了最基础的错误兜底（上面这段代码），把异常翻译成一行中文描述返回给模型。但更完善的做法还需要：

- **区分"可重试"与"不可重试"**：网络抖动、限流（429）是可重试的，用指数退避重试 ≤2 次；参数错误、权限不足、文件不存在是不可重试的，直接返回友好错误，引导模型修正参数。
- **熔断机制**：同一工具连续失败 3 次，自动标记为 unavailable，在后续轮次中跳过。否则模型会一直尝试调用一个注定失败的工具，白白消耗 Token。

## 问题 4：上下文无限增长，Token 烧不起怎么办？

Agent 的"记忆"是对话历史数组。但在 CLI 场景下，每次 ReAct 循环都会新增 2~3 条消息（思考过程 + 工具调用 + 执行结果）。10 轮下来，上下文轻松突破 8000 tokens，成本直线上升。

目前 paicli 的做法很原始——history 无限增长，没有做任何压缩。这也是接下来要解决的重点问题。

这个问题可以分三个阶段解决：

| 阶段 | 策略 | 效果 |
|------|------|------|
| 短期 | **滑动窗口**：只保留最近 N 轮完整消息 | 减少 ~40% |
| 中期 | **摘要压缩**：早期对话用 LLM 压缩为执行摘要 | 再减少 ~30% |
| 长期 | **向量检索**：历史存入向量库，按需检索注入 | 接近恒定成本 |

但压缩不是无脑删，关键取舍是：**什么该留？什么该丢？**

- **保留 Observation（工具结果）**：模型下一步决策高度依赖"看到了什么数据"。丢掉工具结果，模型就等于失忆，会重复调同一个工具。
- **压缩 Thought（思考过程）**：模型的推理链条可以丢弃，用 LLM 重新生成更节省 Token。推理过程的 token 是"过程消耗"，不是"决策依据"。
- **保留 System Constraint（系统约束）**：角色设定、安全规则、输出格式要求永不压缩。这些是行为边界，丢了模型的行为会跑偏。

## 写在最后

回过头看这四个问题，本质上是同一个挑战：**Agent 的"智能"是借来的，可靠性要靠自己工程兜底。**

LLM 负责"智能决策"，但决策的质量依赖你喂给它的上下文质量；工具执行的结果决定了 LLM 下一步的推理方向；循环的退出条件需要你用代码保证——因为模型不知道"适可而止"。

ReAct 循环二十行就能写完，但让它"可靠地跑起来"，是另一回事。这也是 paicli 后续版本要持续解决的问题。
