---
title: "从 Chat Completions 到 Responses：OpenAI 为什么要重做一次 API"
published: 2026-08-02
updated: 2026-08-02
tags: ["Agent", "LLM", "OpenAI", "API 设计"]
category: Agent
description: "从无状态推理、上下文重复传输、Prompt Cache 和 Agent Loop 出发，理解 Chat Completions 为什么曾经合理，又为什么不足以承载今天的 Agent。"
draft: false
---
最近在了解 Chat Completions API 协议时，我一直有一个疑问：

> OpenAI 已经有了广泛使用的 Chat Completions API，为什么还要重新设计一套 Responses API？如果 Responses 更适合多轮对话和 Agent，为什么一开始不直接这样设计？

只比较字段，很容易得到一个表面答案：

```text
Chat Completions 使用 messages
Responses 使用 input 和 output Items
```

可是为什么 OpenAI 为什么愿意承担迁移成本，重新设计一个已经成为事实标准的接口呢？带着这个问题，我写下了这篇文章。

其实真正的变化不只是数据结构，而是大模型应用的工作负载发生了根本改变：

```text
过去：一次请求，生成一段文本
后来：多轮聊天，生成一条助手消息
现在：Agent 持续推理、调用工具、读取结果，再继续推理
```

当模型从“聊天机器人”变成“持续执行任务的 Agent”，原来围绕无状态文本生成设计的接口，在数据传输、上下文管理、缓存复用、推理状态和工具编排上都开始暴露问题。

这篇文章尝试从系统设计出发，回答四个问题：

1. Chat Completions 原来是怎么工作的？
2. 为什么这种设计在当时是合理的？
3. Coding Agent 为什么把它的问题放大了？
4. Responses API 到底改变了什么？

## 一、Chat Completions 的核心：客户端携带全部状态

Chat Completions 的基本接口非常简单：

```json
{
  "model": "gpt-4o",
  "messages": [
    {"role": "system", "content": "你是一个编程助手"},
    {"role": "user", "content": "帮我解释这段代码"}
  ]
}
```

服务端返回：

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "这段代码的作用是……"
      }
    }
  ]
}
```

如果用户继续追问，客户端需要把前面的对话重新放进下一次请求：

```json
{
  "model": "gpt-4o",
  "messages": [
    {"role": "system", "content": "你是一个编程助手"},
    {"role": "user", "content": "帮我解释这段代码"},
    {"role": "assistant", "content": "这段代码的作用是……"},
    {"role": "user", "content": "那它有什么性能问题？"}
  ]
}
```

从 API 的视角看，两次请求彼此独立。服务端不会因为它们来自同一个用户，就天然知道第二次请求应该接着第一次运行。

因此，Chat Completions 的会话状态实际上保存在客户端：

```text
客户端保存 messages
        ↓
每次请求携带完整 messages
        ↓
服务端把当前请求当作一次独立推理
        ↓
返回新的 assistant message
        ↓
客户端把它追加回 messages
```

这是一种典型的无状态 API 设计。

## 二、为什么 OpenAI 一开始采用无状态设计

站在今天的 Agent 场景回看，反复发送历史似乎很浪费。但在早期，这种设计有非常现实的优势。

### 1. 无状态服务容易扩缩容

如果每个请求都携带完整输入，负载均衡器就可以把它交给任意可用的服务实例：

```text
请求 A ──→ 服务实例 1
请求 B ──→ 服务实例 7
请求 C ──→ 服务实例 3
```

API 节点不需要记住某个用户上一次连接了谁，也不需要等待固定节点空闲。

这让系统更容易：

- 横向扩容；
- 做全局负载均衡；
- 在节点故障后重试；
- 升级模型和推理服务；
- 控制数据保留。

### 2. 客户端是会话的唯一事实来源

服务端不保存会话时，开发者可以自由决定：

- 哪些历史消息需要保留；
- 哪些消息应该删除；
- 是否修改 System Prompt；
- 是否从某一轮创建分支；
- 是否将对话迁移到另一家模型提供商。

这是一种简单、透明而且容易理解的契约。

### 3. 早期工作负载没有那么长

Chat Completions 出现时，主流需求仍然是问答、内容生成和短对话。上下文窗口更小，工具调用也没有成为默认能力。

几轮聊天重复传输几 KB 数据，相比模型推理成本并不突出。为了解决一个尚不严重的问题，引入服务端会话、状态持久化、过期回收和故障恢复，反而会让 API 复杂很多。

所以 OpenAI 没有“一开始就设计 Responses”，并不代表早期设计错误。更准确地说：

> Chat Completions 是为聊天时代优化的接口，而 Responses 是在 Agent 工作负载成熟以后产生的接口。

## 三、Agent Loop 改变了问题规模

普通聊天一轮只有一次模型调用，但 Coding Agent 的一次任务可能包含几十次甚至上百次模型与工具之间的往返：

```text
读取文件
   ↓
模型分析
   ↓
调用搜索工具
   ↓
读取搜索结果
   ↓
模型继续分析
   ↓
修改代码
   ↓
运行测试
   ↓
读取报错
   ↓
再次修改
   ↓
……
```

所谓 Agent 连续运行一个小时，并不是一次模型推理持续一个小时，而是很多次短推理和工具执行组成的循环。

如果继续使用 Chat Completions，每一轮都必须重新发送：

- 初始任务；
- System Prompt；
- 工具定义；
- 已经读取的代码；
- 历史 assistant 消息；
- 所有工具调用；
- 所有工具结果；
- 测试输出和错误日志。

历史越长，每轮重复发送的内容越多。

### 重复传输会接近 O(n²)

假设 Agent 每轮增加 d 个 token，一共执行 n 轮。

第 1 轮发送 d，第 2 轮发送 2d，第 3 轮发送 3d，最后一轮发送 nd。

累计传输量约为：

```text
d × (1 + 2 + 3 + ... + n)
= d × n(n + 1) / 2
= O(n²)
```

如果每轮只发送新增内容，累计传输量则接近：

```text
d × n
= O(n)
```

对普通聊天，这个差异可能不明显；对包含大量代码、日志和工具结果的 Agent，差异会迅速扩大。

而且这里至少存在三种不同成本：

| 成本         | 含义                                   |
| ------------ | -------------------------------------- |
| 网络传输     | 客户端是否反复上传完整历史             |
| Prefill 计算 | 模型是否重新计算已有 Prompt 的 KV 张量 |
| 逻辑上下文   | 当前推理实际需要读取多少历史 token     |

这三件事不能混为一谈。

减少网络传输，不代表模型不再需要历史上下文；命中 Prompt Cache，也不代表客户端没有发送那些历史数据。

## 四、Prompt Cache 解决了计算问题，但只解决了一半

当连续请求拥有相同前缀时，模型没有必要每次都从头计算这段前缀。

例如：

```text
第 1 轮：[System Prompt][A]
第 2 轮：[System Prompt][A][B]
第 3 轮：[System Prompt][A][B][C]
```

前面的内容完全相同。模型可以缓存 Attention 层在 prefill 阶段产生的 Key/Value 张量，下一轮只计算新增的后缀。

根据 OpenAI 的 Prompt Caching 文档，请求会根据 Prompt 初始前缀的哈希进行缓存路由，`prompt_cache_key` 还可以帮助具有相同长前缀的请求路由到相同缓存。缓存命中后，服务端可以复用此前计算的 Prompt 前缀，从而降低延迟和输入成本。

但 Prompt Cache 没有解决全部问题。

在 Chat Completions 中，即使服务端最终命中了缓存，客户端仍然要发送完整的 `messages`：

```text
客户端：再次上传完整历史
服务端：发现前缀相同
服务端：复用 KV Cache，减少计算
```

因此 Prompt Cache 主要优化的是模型 prefill，不是客户端到服务端的网络传输。

另外，Prompt Cache 并不是 Responses 独有能力。当前 OpenAI 的 Chat Completions 和 Responses 都支持 Prompt Caching。这也说明：

> 如果 Responses 只是为了解决缓存问题，OpenAI 没有必要重新设计整套接口。

Responses 要解决的是比缓存更大的问题。

## 五、Responses 的第一层改变：从完整历史变成状态引用

Responses API 支持通过 `previous_response_id` 续接前一次响应：

```python
response = client.responses.create(
    model="gpt-5.6",
    input="检查这个项目里为什么测试失败",
)

next_response = client.responses.create(
    model="gpt-5.6",
    previous_response_id=response.id,
    input=[
        {
            "type": "function_call_output",
            "call_id": "call_123",
            "output": "测试失败：AssertionError ...",
        }
    ],
)
```

第二次请求不需要重新发送第一轮的所有输入和输出，只需要发送：

```text
上一轮 Response ID
+ 本轮新增 Items
```

`previous_response_id` 可以理解为服务端上下文的引用。

服务端可以根据这个 ID：

- 找到之前的输入和输出；
- 恢复消息与工具上下文；
- 保留模型的 reasoning Items；
- 尽可能利用已有缓存；
- 必要时从持久化状态恢复。

这让客户端的上行传输从“不断重发完整历史”变成了“提交增量”。

Responses 还可以和 Conversations API 配合，把对话保存为持久对象。开发者也可以选择 `store: false`，继续手动传递完整 Items，保留无状态和零数据保留的能力。

所以 Responses 不是强迫所有应用变成有状态，而是提供三种策略：

```text
previous_response_id：续接最近一次 Response
Conversation：服务端持久化长期会话
手动传递 Items：客户端完全控制上下文
```

## 六、Responses 的第二层改变：从 Message 变成 Item

如果 OpenAI 只想减少重复传输，其实完全可以给 Chat Completions 增加一个 `previous_completion_id`。

但 Agent 的问题不只是历史太长，还包括 Chat Completions 的基本抽象已经不够用了。

Chat Completions 的世界观是：

```text
messages[] → assistant message
```

一次模型调用最终应该得到一条助手消息。工具调用后来被添加到 message 的 `tool_calls` 字段中，拒答、音频、引用等能力也继续附着在 message 上。

但一次 Agent 运行真实产生的是：

```text
reasoning
→ function_call
→ function_call_output
→ reasoning
→ web_search_call
→ message
```

这不是一条消息，而是一串具有不同类型、不同生命周期的行为。

Responses 因此把基本单位改成 Item：

```json
{
  "type": "message",
  "role": "assistant",
  "content": [
    {"type": "output_text", "text": "我找到了问题。"}
  ]
}
```

```json
{
  "type": "function_call",
  "name": "run_tests",
  "call_id": "call_123",
  "arguments": "{\"path\":\"tests/auth\"}"
}
```

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "2 failed, 18 passed"
}
```

```json
{
  "type": "reasoning",
  "summary": []
}
```

Message 只是 Item 的一种。工具调用、工具结果、推理状态都拥有独立类型，不必伪装成聊天消息。

这对 Agent 很重要，因为下一轮需要续接的不只是“用户和助手说过什么”，还包括：

- 模型调用过什么工具；
- 哪个结果对应哪个调用；
- 哪些 reasoning state 需要继续保留；
- 哪个 Item 正在执行、完成或失败；
- 哪些内容可以流式追加。

## 七、Responses 的第三层改变：WebSocket 的连接本地快路径

对于工具调用非常密集的 Coding Agent，OpenAI 进一步提供了 Responses WebSocket mode。

客户端保持一条到 `/v1/responses` 的长连接，每轮只发送：

```text
previous_response_id
+ 新的工具结果
+ 新的用户输入
```

在活跃 WebSocket 连接上，服务端会在连接本地内存中保存最近一个 previous-response state。下一轮续接时可以复用这份状态，避免每轮重新建立连接和恢复最近上下文。

这非常接近“让同一场 Agent Loop 保持在一条执行通道上”的设想：

```text
Agent
  │
  │ 持久 WebSocket
  ▼
connection-local state
  │
  │ previous_response_id + incremental Items
  ▼
推理与工具循环
```

官方文档明确说明，这种模式面向长时间、工具调用密集的工作流；在包含 20 次以上工具调用的测试中，端到端执行时间最多观察到约 40% 的改善。

官方保证的是：

- 使用同一条持久连接；
- 最近一次 Response 状态保存在连接本地内存；
- 可以低延迟续接；
- `store: false` 和 ZDR 也可以使用；
- 连接中断后需要从持久状态恢复，或者重新发送完整上下文。

## 八、Responses 的第四层改变：服务端工具循环

在 Chat Completions 中，自定义工具循环通常由客户端控制：

```text
调用模型
→ 收到 tool_calls
→ 客户端执行工具
→ 拼接 tool message
→ 再次调用模型
```

Responses 仍然支持开发者执行自定义函数，但同时把 Web Search、File Search、Code Interpreter、Computer Use 和远程 MCP 等托管工具放进统一接口。

对服务端托管工具，OpenAI 可以在一次 Response 中完成多次：

```text
模型推理
→ 调用搜索
→ 读取搜索结果
→ 再次推理
→ 调用代码执行
→ 返回最终答案
```

这减少了客户端与服务端之间的往返，也让服务端更容易在一次执行过程中维护工具状态和推理状态。

Responses 返回的不是最后一条 assistant message，而是一组 `output Items`。开发者既可以读取最终的 `output_text`，也可以遍历完整输出，观察其中的工具调用、推理和消息。

## 九、长 Agent 仍然需要 Compaction

`previous_response_id` 减少了传输，并没有让上下文无限增长的问题消失。

即使客户端只发送一个 ID，模型在第 n 轮推理时仍然需要某种形式的历史上下文。随着工具日志、代码片段和失败记录不断积累，逻辑上下文仍然会越来越大。

而且 OpenAI 明确说明：使用 `previous_response_id` 时，链中此前的输入 token 仍然会作为输入 token 计费。

因此，Responses 还需要 Compaction：

```text
长历史
  ↓
提取继续任务所需的机器状态
  ↓
生成更小的 compacted context
  ↓
继续后续 Agent Loop
```

Compaction 解决的是上下文窗口和长期状态治理，不是单纯压缩 HTTP 请求。

到这里可以看到，Responses 并不是靠一个字段解决所有问题，而是通过一组互相配合的机制：

| 机制                     | 主要解决的问题                     |
| ------------------------ | ---------------------------------- |
| Typed Items              | 表达消息、工具、推理等 Agent 行为  |
| `previous_response_id` | 避免客户端每轮上传完整历史         |
| Conversations            | 持久化跨会话、跨设备状态           |
| Prompt Cache             | 减少相同 Prompt 前缀的重复 prefill |
| `prompt_cache_key`     | 提升缓存感知路由与命中率           |
| WebSocket mode           | 为高频工具循环提供连接本地快路径   |
| Hosted tools             | 减少部分工具循环的客户端往返       |
| Compaction               | 控制长期 Agent 的上下文增长        |

## 十、为什么最终需要一个新接口

现在可以回答最初的问题了。

如果问题只有“重复上传历史”，OpenAI 可以继续扩展 Chat Completions：

```json
{
  "previous_completion_id": "chatcmpl_123",
  "messages": [...]
}
```

如果问题只有“重复 prefill”，Prompt Cache 就够了。

如果问题只有“工具调用”，也可以继续给 assistant message 增加字段。

但这些问题同时出现以后，Chat Completions 会变成一个不断打补丁的接口：

```text
Message
├── content
├── tool_calls
├── refusal
├── audio
├── reasoning?
├── hosted_tool_state?
├── background_status?
└── compaction_state?
```

它的核心仍然假设“模型返回一条聊天消息”，而 Agent 真实需要的是“一次有状态、可流式、可调用工具的执行过程”。

因此 Responses 重新定义了核心抽象：

```text
Chat Completions：
Messages → Assistant Message

Responses：
Input Items → Agent Execution → Output Items
```

与此同时，它把上下文续接从客户端反复拼接数组，升级为服务端可以识别和优化的执行链。

这也是为什么 Responses 不是 Chat Completions 2.0 的字段重命名，而是模型服务边界的一次重新划分。

## 十一、为什么不是一开始就这样设计

一个接口不可能脱离时代提前知道所有未来需求。

在 Chat Completions 诞生时：

- 模型主要被当作文本生成器和聊天机器人；
- 上下文较短；
- Agent 工具生态尚未成熟；
- reasoning state 还不是主流接口需求；
- 长时间、多工具循环并非常见工作负载；
- 无状态带来的扩缩容和可移植性收益更重要。

后来 OpenAI 又通过 Assistants API 探索了 Thread、Run、托管工具和持久状态。Responses 在 2025 年发布时，实际上吸收了 Chat Completions 的简单调用方式，也吸收了 Assistants API 在 Agent 场景中的经验。OpenAI 随后计划用 Responses 和 Conversations 承接 Assistants API 的能力。

所以 API 的演进路线更像：

```text
Completions
单段文本补全
    ↓
Chat Completions
消息式多轮对话
    ↓
Assistants
Thread、Run 与托管工具实验
    ↓
Responses
统一的 Agent 执行原语
```

不是 OpenAI 一开始故意设计了一个不完整接口，而是工作负载先从文本生成演进到聊天，再从聊天演进到 Agent。每个阶段暴露的问题，为下一代接口提供了真实经验。

## 十二、Open Responses 又是什么

还需要区分两个名字：

- **OpenAI Responses API**：OpenAI 提供的商业 API；
- **Open Responses**：基于 Responses 数据模型形成的开放、多厂商规范。

Chat Completions 虽然成为事实标准，但不同模型提供商对工具调用、reasoning、流式事件和多模态字段都有自己的扩展。“兼容 OpenAI”经常只意味着最简单的文本请求可以运行。

Open Responses 希望把 Items、工具调用、语义流式事件和 Agent Loop 变成多厂商共同实现的规范，并允许通过命名空间保留提供商特有能力。

不过 Open Responses 标准也不能保证所有提供商都采用相同的会话持久化和缓存方式。它标准化的是客户端可见的协议语义，不是每家厂商内部的推理基础设施。

## 总结

Chat Completions 的设计并不愚蠢。它选择无状态，是为了让早期大模型服务容易扩缩容、负载均衡、故障恢复和跨厂商实现。在以短文本和聊天为主的时代，这种设计非常成功，甚至成为了行业事实标准。

真正改变一切的是 Agent Loop。

当一次任务需要几十次模型与工具之间的往返时，客户端反复发送完整历史会造成接近 O(n²) 的累计上传；Prompt Cache 可以减少重复 prefill，却不能消除网络传输，也不能替代对会话状态的明确管理。

Responses 选择了一条更完整的路线：

```text
用 Items 表达 Agent 行为
+ 用 previous_response_id 引用历史状态
+ 用 Conversations 持久化长期上下文
+ 用 Prompt Cache 做缓存感知路由
+ 用 WebSocket 提供连接本地续接
+ 用 Compaction 控制上下文增长
```

它在“无状态请求的简单性”和“有状态 Agent 的连续性”之间增加了一层可引用、可缓存、可恢复的状态。

如果只用一句话概括：

> Chat Completions 把模型看作一个根据消息生成回复的聊天机器人；Responses 则把模型看作一个能够持续读取状态、推理、调用工具并产生结构化行为的执行器。

这才是 OpenAI 重新设计 Responses API 的根本原因。

## 参考资料

- [OpenAI：Migrate to the Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [OpenAI：Conversation state](https://developers.openai.com/api/docs/guides/conversation-state)
- [OpenAI：Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [OpenAI：Responses WebSocket mode](https://developers.openai.com/api/docs/guides/websocket-mode)
- [OpenAI：Compaction](https://developers.openai.com/api/docs/guides/compaction)
- [Open Responses Specification](https://www.openresponses.org/specification)
