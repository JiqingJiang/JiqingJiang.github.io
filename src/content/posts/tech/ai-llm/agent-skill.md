---
title: "Agent Skills 深度解析"
description: "深入剖析 Anthropic 开源的 Agent Skills 标准。为什么我们需要 Skill？它是如何解决上下文污染问题的？以及如何利用它构建可复利的 AI 技能库。"
published: 2026-01-01
category: tools
tags: ["skills"]
---

在 AI Agent 开发中，如何让智能体学会使用新工具而不撑爆上下文窗口？如何让写好的 Prompt 像代码库一样被复用？答案就是 **Agent Skills**。本文基于官方协议文档，梳理了这一技术标准的核心逻辑。

## 1. 什么是 Agent Skill？
简单来说，Agent Skill 是一个**标准化的文件夹结构**，它封装了 AI 完成特定任务所需的所有上下文。

你可以把它理解为 **AI 的“NPM 包”或“VS Code 插件”，或者说是AI 的技能说明书**。它不仅仅是一段 Prompt，而是一个包含了元数据、指令和可执行代码的独立单元。

**核心结构：**
任何符合标准的 Skill 都是一个文件夹，其中必须包含一个 `SKILL.md` 文件：
```text
my-skill/
├── SKILL.md          # 核心定义（元数据 + Prompt）
└── scripts/          # (可选) Python/Bash 脚本，供 AI 调用
```

## 2.为什么需要它？
在传统开发中，我们习惯把所有指令都塞进 System Prompt，但这带来了两个致命问题：
- 上下文污染 (Context Pollution)：Prompt 太长，模型注意力分散，容易产生幻觉。
- 不可维护：Prompt 散落在代码各处，难以像模块一样迭代和复用。

Agent Skills 通过 "按需加载" (Progressive Disclosure) 解决了这个问题：
- Agent 初始状态只知道技能的名字和简介。
- 只有当需要解决具体问题时，Agent 才会动态加载详细的指令和工具。

## 3.工作原理 (The Mechanics)
Agent Skills 的运行遵循 "发现 -> 路由 -> 激活" 的流程。   

1. Discovery (发现)：Agent 启动时，扫描本地所有 Skill 的 YAML 头信息（Name & Description）。
2. Routing (路由)：当用户提问时，Agent 根据语义判断哪个 Skill 的 Description 最匹配。
3. Activation (激活)：Agent 读取该 Skill 的完整内容，将其作为临时的上下文注入给 LLM。

```md
交互流程详解
1.  用户发起请求：用户向 Agent 发送指令（例如：“帮我把这个文件改成 PDF”）。
2.  路由扫描 (Routing)：Agent 遍历扫描本地所有已安装 Skill 的 `description` 字段。
3.  技能匹配：Agent 发现用户的意图与 `format-converter` 技能的描述最匹配。
4.  读取定义：Agent 访问该技能文件夹，读取 `SKILL.md` 的详细内容。
5.  动态注入 (Injection)：系统将 `SKILL.md` 中的具体指令（Instructions）提取出来，动态合并到当前的 System Prompt 中。
6.  任务执行：Agent 获得了处理 PDF 的能力，执行具体操作并将结果返回给用户。
```

## 4.具体示例
这是一个标准的 SKILL.md 文件内容，用于规范 Git 提交信息：

```md
---
name: git-commit-formatter
description: 当用户提供代码变更内容，需要生成符合 Conventional Commits 规范的提交信息时使用。
---

# Git Commit Formatter
你是一名资深开发工程师。请根据用户的代码变更，生成符合 Conventional Commits 规范的提交信息。

## 规则
1. 格式：<type>(<scope>): <subject>
2. types 仅限：feat, fix, docs, style, refactor, test, chore
3. 保持简练，不超过 50 个字符。

## 示例
User: "我修改了 login.py 的密码加密逻辑"
Assistant: "fix(auth): update password encryption logic in login.py"
```

## 5. 如何使用与集成
### A. 场景一：直接使用者
如果你是使用 Claude Code 的用户，使用流程非常标准化：

安装技能： 在终端中通过指令从 GitHub 或本地加载技能包。

```bash
# 安装官方仓库的技能
/plugin install example-skills@anthropic-agent-skills
# 或安装本地自定义技能
/plugin install ./my-custom-skills/code-reviewer
```
触发机制： 你不需要显式输入 /run code-reviewer。只需在对话中用自然语言表达需求：

"帮我看看这段代码有没有安全漏洞。"

Agent 会自动在后台匹配并激活对应的 Review 技能。

### B. 场景二：Agent 开发者 (Integration Architecture)
如果你想开发一个支持 Agent Skills 的应用，你需要实现一个 **“技能运行时环境”** 。核心逻辑包含三个步骤：

1. 发现与索引 (Discovery & Indexing)
    系统启动时，需要遍历技能目录，建立索引。

    - 动作：递归扫描文件夹，读取所有 SKILL.md。
    - 解析：提取 YAML Frontmatter 中的 name 和 description (功能描述)。
    - 产物：构建一个轻量级的技能注册表（Registry List）。

    ```python
    # 伪代码逻辑
    skills_registry = []
    for folder in skill_dir:
        metadata = parse_yaml(folder + "/SKILL.md")
        skills_registry.append({
            "id": metadata.name,
            "desc": metadata.description,
            "path": folder
        })
    ```
2. 语义路由 (Semantic Routing)
    这是最关键的一步。当用户发来消息时，系统需要决定加载哪个 Skill。

    策略：将用户的 Prompt 和 skills_registry 中的 description 一起发给 LLM。

    ```python
    Prompt 示例：   
    "用户正在请求：'{user_query}'。现有工具描述如下：{skills_desc}。请判断是否需要调用工具？如果是，返回工具 ID。"
    ```

3. 动态注入与执行 (Injection & Execution)
    一旦路由确定了目标 Skill，系统进入“加载模式”：

    上下文注入：读取 SKILL.md 的正文（Markdown 指令），将其追加到当前的 System Prompt 中。

    Before: You are a helpful assistant.

    After: You are a helpful assistant. [SYSTEM: ACTIVATE SKILL 'GIT-COMMIT'] You are now a git expert. Follow these rules...

    工具挂载：如果 Skill 包含 scripts/ 目录，需将其中的 Python 脚本自动转换为 LLM API (如 OpenAI Tools 格式) 的 JSON Schema，随请求一起发送。

## 参考文献
本文内容整理自 Agent Skills 官方文档及规范：

1. 官方主页: [Agent Skills Home](https://agentskills.io/home)
2. 核心定义: [What are Skills?](https://agentskills.io/what-are-skills)
3. 技术规范: [The Skill Specification](https://agentskills.io/specification)
4. 集成指南: [Integration Guide](https://agentskills.io/integrate-skills)
5. Claude 支持: [Claude Support Article](https://support.claude.com/en/articles/12512176-what-are-skills)
6. [Agent Skill 从使用到原理，一次讲清 Agent Skill 从使用到原理](https://www.douyin.com/video/7590008747938876706)