---
title: "OpenAI vs Anthropic SDK 深度对比"
published: 2026-05-13
tags: ["Agent", "LLM", "SDK"]
category: Agent
description: "同一个模型（DeepSeek V4 Flash）、同一个问题、两种 API 格式的完整对比，从设计哲学到工程实践。"
draft: false
---

> 同一个模型（DeepSeek V4 Flash）、同一个问题、两种 API 格式的完整对比。
> 数据来源：真实运行日志，非手写示例。

## 一、整体设计哲学

| 维度 | OpenAI | Anthropic |
|------|--------|-----------|
| 核心抽象 | **消息列表** | **内容块列表** |
| 响应结构 | `choices[0].message` — 单个 message 对象 | `content[]` — 内容块数组，一个响应可以有 text + tool_use 多种类型 |
| 设计思路 | 消息是原子单位，tool_calls 是 message 的附属属性 | 内容块是原子单位，text 和 tool_use 是同一级的兄弟 |

这两家在 API 设计上走的是完全不同的路。OpenAI 把"文本回复"和"工具调用"放在同一个 message 对象的两个字段里（`content` + `tool_calls`），开发者拿到一个 message 对象，想看文字读 `content`，想看工具调用读 `tool_calls`，很直观。

Anthropic 把它们统一为 `content` 数组里不同 `type` 的块。所有内容都是块——不管是文字、工具调用、还是工具结果，地位完全平等。这种设计更"正交"，类型系统更统一，但开发者需要遍历 content 数组按 type 过滤。

谁更好？取决于你写什么层的代码。如果只是简单调用，OpenAI 更直观；如果你在写 Agent 框架，Anthropic 的统一块模型反而更容易做通用处理。

---

## 二、请求构造差异

### 2.1 工具定义

```python
# ── OpenAI 格式 ──
tools = [{
    "type": "function",                    # 外层必须声明 type
    "function": {                          # 套一层 function
        "name": "get_weather",
        "description": "获取天气",
        "parameters": {                    # 字段叫 parameters
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    },
}]

# ── Anthropic 格式 ──
tools = [{
    "name": "get_weather",                 # 直接在顶层
    "description": "获取天气",
    "input_schema": {                      # 字段叫 input_schema
        "type": "object",
        "properties": {"city": {"type": "string"}},
        "required": ["city"],
    },
}]
```

OpenAI 多了一层 `function` 嵌套（因为有 `type: "function"` 预留扩展其他类型，比如 `type: "code_interpreter"`），Anthropic 没有这个外层包装，更简洁。参数 Schema 字段名也不同：OpenAI 叫 `parameters`，Anthropic 叫 `input_schema`，语义一样，命名不同。

### 2.2 消息格式

```python
# ── OpenAI：消息是扁平的 dict ──
messages = [
    {"role": "user", "content": "你好"},
    {"role": "assistant", "content": "你好！"},
]

# ── Anthropic：content 可以是字符串，也可以是内容块数组 ──
messages = [
    {"role": "user", "content": "你好"},          # 简单场景：字符串
    {"role": "assistant", "content": [             # 复杂场景：内容块数组
        {"type": "text", "text": "你好！"},
        {"type": "tool_use", "id": "...", "name": "...", "input": {...}},
    ]},
]
```

Anthropic 的 content 支持两种类型（str 或 list[Block]），这意味着序列化/反序列化时要额外处理类型判断。OpenAI 的 content 永远是字符串，tool_calls 是独立字段，类型更确定。

### 2.3 System Prompt

```python
# OpenAI：system 是消息列表里的一条消息
messages = [
    {"role": "system", "content": "你是助手"},
    {"role": "user", "content": "你好"},
]

# Anthropic：system 是顶级参数，不在 messages 里
client.messages.create(
    system="你是助手",
    messages=[{"role": "user", "content": "你好"}],
)
```

Anthropic 的 system 不参与 messages 的顺序管理，更不容易出错（不会把 system 消息误插到中间）。OpenAI 的方式更灵活（可以在对话中间插入 system 消息），但也更容易误操作。

---

## 三、响应解析差异

### 3.1 真实响应对比

以下是同一个问题（"用一句话介绍你自己"）的两种格式的真实返回数据：

```json
// OpenAI 响应
{
  "choices": [{
    "finish_reason": "stop",
    "message": {
      "role": "assistant",
      "content": "我是一名人造智能助手...",
      "tool_calls": null
    }
  }],
  "usage": { "prompt_tokens": 8, "completion_tokens": 25, "total_tokens": 33 }
}

// Anthropic 响应
{
  "role": "assistant",
  "stop_reason": "end_turn",
  "content": [
    {"type": "text", "text": "我是你身边的AI伙伴..."}
  ],
  "usage": { "input_tokens": 8, "output_tokens": 20 }
}
```

### 3.2 工具调用的响应对比

同样的问题（"北京今天天气怎么样"），LLM 决定调用工具：

```json
// OpenAI：tool_calls 是 message 的附属字段
{
  "choices": [{
    "finish_reason": "tool_calls",
    "message": {
      "content": "让我查一下北京今天的天气情况。",
      "tool_calls": [{
        "id": "call_00_8WcIl14wEDOeacZ0n8xL9829",
        "type": "function",
        "function": {
          "name": "get_weather",
          "arguments": "{\"city\": \"北京\"}"   // ← JSON 字符串
        }
      }]
    }
  }]
}

// Anthropic：tool_use 是 content 数组中的一个块
{
  "stop_reason": "tool_use",
  "content": [
    {"type": "text", "text": "让我查一下北京的天气情况。"},
    {"type": "tool_use", "id": "call_00_DnX2SEF9esVcv3HRBefj1699",
     "name": "get_weather", "input": {"city": "北京"}}   // ← 已解析的 dict
  ]
}
```

### 3.3 关键差异速查

| 字段 | OpenAI | Anthropic |
|------|--------|-----------|
| 文本内容 | `choices[0].message.content` | `content[i]` where `type == "text"` |
| 工具调用 | `choices[0].message.tool_calls[]` | `content[i]` where `type == "tool_use"` |
| **工具参数** | `function.arguments`（**JSON 字符串**） | `input`（**已解析的 dict**） |
| 结束原因 | `finish_reason: "tool_calls"` | `stop_reason: "tool_use"` |
| Token 输入 | `usage.prompt_tokens` | `usage.input_tokens` |
| Token 输出 | `usage.completion_tokens` | `usage.output_tokens` |

**最容易踩的坑**：工具参数的类型差异。OpenAI 的 `arguments` 是 JSON 字符串，需要 `json.loads()` 才能用。Anthropic 的 `input` 已经是解析好的 dict。这个差异意味着如果你在做 Agent 框架的抽象层，必须统一处理——要么都序列化为字符串，要么都解析为 dict。

另一个设计差异：OpenAI 用 `choices` 数组（设计上是支持多个候选回复的），但实际几乎永远只有一个 choice。Anthropic 没有 choices 层，`content` 直接在顶层。多 choice 的能力 OpenAI 至今也没真正开放。

---

## 四、工具结果回传（最关键的差异）

这是构建 Agent 框架时最重要的部分——工具执行完，怎么把结果告诉 LLM。两家的做法差异很大。

### 4.1 OpenAI 的回传方式

```python
# 1. 把 assistant 消息（含 tool_calls）加入 messages
messages.append({
    "role": "assistant",
    "content": "让我查一下天气",
    "tool_calls": [{
        "id": "call_00_xxx",
        "type": "function",
        "function": {"name": "get_weather", "arguments": '{"city": "北京"}'},
    }],
})

# 2. 每个工具结果作为独立消息加入
messages.append({
    "role": "tool",                        # ← role 是 "tool"
    "tool_call_id": "call_00_xxx",         # ← 用 tool_call_id 配对
    "content": "北京：晴天，25°C",
})
```

### 4.2 Anthropic 的回传方式

```python
# 1. 把 assistant 的完整响应加入 messages
messages.append({
    "role": "assistant",
    "content": [                            # ← content 是块数组
        {"type": "text", "text": "让我查一下天气"},
        {"type": "tool_use", "id": "call_00_xxx", "name": "get_weather", "input": {"city": "北京"}},
    ],
})

# 2. 所有工具结果打包成一条 user 消息
messages.append({
    "role": "user",                         # ← role 是 "user"！不是 "tool"
    "content": [                            # ← content 是 tool_result 数组
        {
            "type": "tool_result",          # ← 类型标记
            "tool_use_id": "call_00_xxx",   # ← 用 tool_use_id 配对
            "content": "北京：晴天，25°C",
        },
    ],
})
```

### 4.3 回传结构对比

```
OpenAI（每个工具结果一条消息）：           Anthropic（所有结果打包一条消息）：
messages:                                messages:
  [0] role=user                            [0] role=user
  [1] role=assistant + tool_calls          [1] role=assistant + content blocks
  [2] role=tool, id=call_00_aaa            [2] role=user, content=[
  [3] role=tool, id=call_00_bbb                  {tool_result, tool_use_id=call_00_aaa},
                                                 {tool_result, tool_use_id=call_00_bbb},
                                               ]
```

三个值得注意的差异：

**第一，role 不同。** Anthropic 用 `role: user` 而不是 `role: tool`。这是因为 Anthropic 的设计哲学是"消息只有三种角色：user / assistant / system"。工具结果本质上是由用户侧（Agent 系统）提交的，所以归为 user。OpenAI 专门发明了 `tool` 角色，语义更精确但增加了角色种类。

**第二，打包策略影响并行执行设计。** OpenAI 每个工具结果一条消息，可以逐个执行、逐个回传，天然支持流式工具执行。Anthropic 所有结果打包一条，必须等所有工具执行完才能回传。如果你的 Agent 框架要同时支持两种 API，这个差异会直接影响你并行执行模块的设计。

**第三，ID 配对字段名不同。** OpenAI 用 `tool_call_id`，Anthropic 用 `tool_use_id`，语义完全一样——都是唯一标识符，用于把工具调用和结果配对。

---

## 五、多次工具调用 & 并行

两种 API 都支持 LLM 在一次响应中返回多个工具调用（比如同时读 3 个文件），也支持多轮工具调用（第 1 轮调完工具，第 2 轮 LLM 可能继续调）。

```json
// OpenAI：tool_calls 数组
"tool_calls": [
    {"id": "call_001", "function": {"name": "read_file", "arguments": '{"path":"a.py"}'}},
    {"id": "call_002", "function": {"name": "read_file", "arguments": '{"path":"b.py"}'}},
    {"id": "call_003", "function": {"name": "read_file", "arguments": '{"path":"c.py"}'}}
]

// Anthropic：content 数组中的 tool_use 块
"content": [
    {"type": "text", "text": "我来读取这三个文件"},
    {"type": "tool_use", "id": "call_001", "name": "read_file", "input": {"path": "a.py"}},
    {"type": "tool_use", "id": "call_002", "name": "read_file", "input": {"path": "b.py"}},
    {"type": "tool_use", "id": "call_003", "name": "read_file", "input": {"path": "c.py"}}
]
```

一个有趣的细节：Anthropic 可以在 tool_use 块之间穿插 text 块（先说一句话，再调两个工具，再说一句话）。OpenAI 的 tool_calls 是一个数组，文本和工具调用是分离的两个字段，没有这种穿插能力。

关于多轮调用，消息列表会持续增长：

```
轮次  messages 长度增长
1     user → assistant(tool_calls) → tool/tool_result   = 3 条
2     → assistant(tool_calls) → tool/tool_result        = 5 条
3     → assistant(content)                               = 6 条（最终回复）
```

直到 LLM 不再返回工具调用。这也是为什么 Agent 框架需要上下文压缩——Token 消耗在工具调用场景下增长极快。

---

## 六、Usage / Token 计费差异

| 字段 | OpenAI | Anthropic |
|------|--------|-----------|
| 输入 token | `usage.prompt_tokens` | `usage.input_tokens` |
| 输出 token | `usage.completion_tokens` | `usage.output_tokens` |
| 总计 | `usage.total_tokens` | 无（需自行计算） |
| 缓存命中 | `usage.prompt_cache_hit_tokens` | `usage.cache_read_input_tokens` |
| 缓存写入 | 无 | `usage.cache_creation_input_tokens` |

从真实日志可以看到缓存的实际效果——同一个工具定义在第二轮请求中命中了缓存：

```
第 1 轮（OpenAI）:  prompt_tokens: 282, cached_tokens: 256
第 2 轮（OpenAI）:  prompt_tokens: 354, cached_tokens: 256  ← 工具定义被缓存
```

缓存命中的 token 单价更低，如果你在做 Agent 框架的成本监控，需要统一抽象 usage 的解析逻辑。

---

## 七、SDK 对象 vs 原始 dict

| | OpenAI SDK | Anthropic SDK |
|--|-----------|---------------|
| 响应对象 | `ChatCompletion`（Pydantic model） | `Message`（Pydantic model） |
| 访问方式 | `response.choices[0].message.tool_calls` | `response.content[0].type` |
| 转为 dict | `response.model_dump()` | `response.model_dump()` |
| 消息回传 | 可以直接 append SDK 对象的 `model_dump()` | 需要注意 content 中的 Block 对象 |

一个常见的坑：Anthropic 的 `content` 里的 `TextBlock` / `ToolUseBlock` 是 Pydantic 对象不是 dict，直接 append 到 messages 可能导致序列化问题。需要显式转为 dict 或者让 SDK 自己处理。

---

## 八、对 Agent 框架设计的启示

如果你的 Agent 框架要同时支持两种 API，抽象层至少要统一这些东西：

```
需要统一的          OpenAI 的叫法          Anthropic 的叫法
─────────────────────────────────────────────────────────
工具定义 schema     parameters             input_schema
工具调用 ID 字段    tool_call_id           tool_use_id
工具参数类型        JSON 字符串            已解析的 dict
工具结果 role       "tool"                 "user"
工具结果打包方式    每个结果一条消息        所有结果一条消息
结束标志            finish_reason          stop_reason
文本内容位置        message.content        content[i].text
工具调用位置        message.tool_calls     content[i] (type=tool_use)
```

一个设计良好的 Protocol 层会让上层 Agent 代码完全无感——Agent 只说"调工具"、"拿结果"、"回传"，不关心底层是 `tool_call_id` 还是 `tool_use_id`，是 `arguments` 字符串还是 `input` dict。

这也验证了一个重要的认知：API 格式本身不是模型能力决定的，是服务层的设计选择。同一个 DeepSeek V4 Flash 可以同时暴露 OpenAI 和 Anthropic 两种接口格式，你换的不是模型，而是 API 格式，框架要做的是无感切换。

---

## 附录

### 附录 A：完整测试代码

以下是用 DeepSeek V4 Flash 同时跑两种 SDK 的完整测试脚本，覆盖三个场景：纯文本对话、工具调用（第一轮）、完整 ReAct 两轮（工具调用 → 结果回传 → 最终回复）。

<details>
<summary>OpenAI SDK 测试代码</summary>

```python title="test_OpenAI_SDK.py"
"""测试 OpenAI SDK 完整交互流程（含工具结果回传）。"""
import os
import json
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI

ROOT = Path(__file__).parent.parent
load_dotenv(ROOT / ".env")

LOG_DIR = ROOT / "logs" / "sdk"
LOG_DIR.mkdir(parents=True, exist_ok=True)

client = OpenAI(
    api_key=os.getenv("DEEPSEEK_API_KEY"),
    base_url="https://api.deepseek.com/v1",
)

MODEL = "deepseek-chat"

tools = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "获取指定城市的天气",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string", "description": "城市名"}},
            "required": ["city"],
        },
    },
}]


def mock_execute_tool(name: str, args: dict) -> str:
    if name == "get_weather":
        return f"{args.get('city', '未知')}：晴天，25°C，微风"
    return f"未知工具: {name}"


results = {}

# ── 场景 A：纯文本 ──
r = client.chat.completions.create(
    model=MODEL,
    max_tokens=256,
    messages=[{"role": "user", "content": "用一句话介绍你自己"}],
)
results["A_纯文本"] = r.model_dump()

# ── 场景 B：工具调用（只看第一轮）──
r = client.chat.completions.create(
    model=MODEL,
    max_tokens=256,
    tools=tools,
    messages=[{"role": "user", "content": "北京今天天气怎么样"}],
)
results["B_工具调用"] = r.model_dump()

# ── 场景 C：完整 ReAct 两轮 ──
messages = [{"role": "user", "content": "北京今天天气怎么样"}]
r1 = client.chat.completions.create(model=MODEL, max_tokens=256, tools=tools, messages=messages)
msg1 = r1.choices[0].message

# 回传：先 append assistant 消息，再逐个 append tool 结果
messages.append(msg1.model_dump())
for tc in msg1.tool_calls:
    args = json.loads(tc.function.arguments)
    result = mock_execute_tool(tc.function.name, args)
    messages.append({
        "role": "tool",
        "tool_call_id": tc.id,
        "content": result,
    })

# 第 2 轮：把工具结果发给 LLM
r2 = client.chat.completions.create(model=MODEL, max_tokens=256, tools=tools, messages=messages)
results["C_完整两轮"] = {
    "第1轮_工具调用": r1.model_dump(),
    "回传的messages": messages,
    "第2轮_最终回复": r2.model_dump(),
}

# ── 写入日志 ──
date_str = datetime.now().strftime("%Y-%m-%d")
log_file = LOG_DIR / f"{date_str}-openai-response.json"
log_file.write_text(json.dumps(results, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
```

</details>

<details>
<summary>Anthropic SDK 测试代码</summary>

```python title="test_Anthropic_SDK.py"
"""测试 Anthropic SDK 完整交互流程（含工具结果回传）。"""
import os
import json
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
from anthropic import Anthropic

ROOT = Path(__file__).parent.parent
load_dotenv(ROOT / ".env")

LOG_DIR = ROOT / "logs" / "sdk"
LOG_DIR.mkdir(parents=True, exist_ok=True)

client = Anthropic(
    api_key=os.getenv("DEEPSEEK_API_KEY"),
    base_url="https://api.deepseek.com/anthropic",
)

MODEL = "deepseek-chat"

tools = [{
    "name": "get_weather",
    "description": "获取指定城市的天气",
    "input_schema": {
        "type": "object",
        "properties": {"city": {"type": "string", "description": "城市名"}},
        "required": ["city"],
    },
}]


def mock_execute_tool(name: str, args: dict) -> str:
    if name == "get_weather":
        return f"{args.get('city', '未知')}：晴天，25°C，微风"
    return f"未知工具: {name}"


results = {}

# ── 场景 A：纯文本 ──
r = client.messages.create(
    model=MODEL,
    max_tokens=256,
    messages=[{"role": "user", "content": "用一句话介绍你自己"}],
)
results["A_纯文本"] = r.model_dump()

# ── 场景 B：工具调用（只看第一轮）──
r = client.messages.create(
    model=MODEL,
    max_tokens=256,
    tools=tools,
    messages=[{"role": "user", "content": "北京今天天气怎么样"}],
)
results["B_工具调用"] = r.model_dump()

# ── 场景 C：完整 ReAct 两轮 ──
messages = [{"role": "user", "content": "北京今天天气怎么样"}]
r1 = client.messages.create(model=MODEL, max_tokens=256, tools=tools, messages=messages)

# 回传：先 append assistant 消息（content 块数组），再打包所有 tool_result
messages.append({"role": "assistant", "content": r1.content})
tool_results = []
for block in r1.content:
    if block.type == "tool_use":
        result = mock_execute_tool(block.name, block.input)
        tool_results.append({
            "type": "tool_result",
            "tool_use_id": block.id,
            "content": result,
        })
messages.append({"role": "user", "content": tool_results})

# 第 2 轮：把工具结果发给 LLM
r2 = client.messages.create(model=MODEL, max_tokens=256, tools=tools, messages=messages)
results["C_完整两轮"] = {
    "第1轮_工具调用": r1.model_dump(),
    "回传的messages": str(messages),
    "第2轮_最终回复": r2.model_dump(),
}

# ── 写入日志 ──
date_str = datetime.now().strftime("%Y-%m-%d")
log_file = LOG_DIR / f"{date_str}-anthropic-response.json"
log_file.write_text(json.dumps(results, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
```

</details>

### 附录 B：完整响应日志

以下是三个场景的完整 API 响应日志（已精简无关字段）。注意对比两种格式在结构上的差异，尤其是工具调用场景下的响应结构。

<details>
<summary>OpenAI 完整响应日志</summary>

```json title="openai-response.json"
{
  "A_纯文本": {
    "id": "f38b2f23-16a1-48b9-837e-4c2238a6432c",
    "choices": [{
      "finish_reason": "stop",
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "我是一名人造智能助手，旨在通过实时信息检索和多语言支持，为用户提供高效、准确且友好的帮助。",
        "tool_calls": null
      }
    }],
    "model": "deepseek-v4-flash",
    "usage": {
      "prompt_tokens": 8,
      "completion_tokens": 25,
      "total_tokens": 33
    }
  },
  "B_工具调用": {
    "id": "279e0d46-ca7e-4495-806b-e3d7449aa465",
    "choices": [{
      "finish_reason": "tool_calls",
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "让我查一下北京今天的天气情况。",
        "tool_calls": [{
          "id": "call_00_8WcIl14wEDOeacZ0n8xL9829",
          "type": "function",
          "function": {
            "name": "get_weather",
            "arguments": "{\"city\": \"北京\"}"
          }
        }]
      }
    }],
    "model": "deepseek-v4-flash",
    "usage": {
      "prompt_tokens": 282,
      "completion_tokens": 52,
      "total_tokens": 334
    }
  },
  "C_完整两轮": {
    "第1轮_工具调用": {
      "choices": [{
        "finish_reason": "tool_calls",
        "message": {
          "content": "让我查询一下北京今天的天气情况。",
          "tool_calls": [{
            "id": "call_00_Sh0T5t8PXiCWHA6Gcr3w7264",
            "function": {
              "name": "get_weather",
              "arguments": "{\"city\": \"北京\"}"
            }
          }]
        }
      }]
    },
    "回传的messages": [
      {"role": "user", "content": "北京今天天气怎么样"},
      {
        "role": "assistant",
        "tool_calls": [{
          "id": "call_00_Sh0T5t8PXiCWHA6Gcr3w7264",
          "function": {"name": "get_weather", "arguments": "{\"city\": \"北京\"}"}
        }]
      },
      {
        "role": "tool",
        "tool_call_id": "call_00_Sh0T5t8PXiCWHA6Gcr3w7264",
        "content": "北京：晴天，25°C，微风"
      }
    ],
    "第2轮_最终回复": {
      "choices": [{
        "finish_reason": "stop",
        "message": {
          "content": "北京今天天气很好！具体情况如下：\n\n- **天气状况**：晴天\n- **气温**：25°C\n- **风力**：微风",
          "tool_calls": null
        }
      }],
      "usage": {
        "prompt_tokens": 354,
        "completion_tokens": 69,
        "total_tokens": 423
      }
    }
  }
}
```

</details>

<details>
<summary>Anthropic 完整响应日志</summary>

```json title="anthropic-response.json"
{
  "A_纯文本": {
    "id": "b12f46f3-b005-4b75-9a3e-b3cc98001d2e",
    "role": "assistant",
    "stop_reason": "end_turn",
    "content": [
      {"type": "text", "text": "我是你身边的AI伙伴，随时准备用精准又温暖的语言为你答疑解惑、碰撞灵感。"}
    ],
    "model": "deepseek-v4-flash",
    "usage": {
      "input_tokens": 8,
      "output_tokens": 20
    }
  },
  "B_工具调用": {
    "id": "2e6c9b04-dea3-461a-b4c9-e68a7b8254da",
    "role": "assistant",
    "stop_reason": "tool_use",
    "content": [
      {"type": "text", "text": "让我查一下北京的天气情况。"},
      {
        "type": "tool_use",
        "id": "call_00_DnX2SEF9esVcv3HRBefj1699",
        "name": "get_weather",
        "input": {"city": "北京"}
      }
    ],
    "model": "deepseek-v4-flash",
    "usage": {
      "input_tokens": 26,
      "output_tokens": 51
    }
  },
  "C_完整两轮": {
    "第1轮_工具调用": {
      "role": "assistant",
      "stop_reason": "tool_use",
      "content": [
        {"type": "text", "text": "让我查一下北京的天气情况。"},
        {
          "type": "tool_use",
          "id": "call_00_ORUjAw43qGE5D9xUlpTI2193",
          "name": "get_weather",
          "input": {"city": "北京"}
        }
      ]
    },
    "回传的messages": [
      {"role": "user", "content": "北京今天天气怎么样"},
      {
        "role": "assistant",
        "content": [
          {"type": "text", "text": "让我查一下北京的天气情况。"},
          {"type": "tool_use", "id": "call_00_ORUjAw43qGE5D9xUlpTI2193", "name": "get_weather", "input": {"city": "北京"}}
        ]
      },
      {
        "role": "user",
        "content": [
          {"type": "tool_result", "tool_use_id": "call_00_ORUjAw43qGE5D9xUlpTI2193", "content": "北京：晴天，25°C，微风"}
        ]
      }
    ],
    "第2轮_最终回复": {
      "role": "assistant",
      "stop_reason": "end_turn",
      "content": [
        {"type": "text", "text": "北京今天天气不错！具体情况如下：\n- 天气状况：晴天\n- 温度：25°C\n- 风力：微风"}
      ],
      "usage": {
        "input_tokens": 97,
        "output_tokens": 53
      }
    }
  }
}
```

</details>
