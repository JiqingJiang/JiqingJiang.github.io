---
title: "Agent Skills 实践"
description: "实战案例：构建博客自动提交助手"
published: 2026-01-01
category: tools
tags: ["skills"]
---

# 实战案例：构建博客自动提交助手

为了演示如何将理论转化为生产力，我们来构建一个名为 `blog-publisher` 的本地 Skill。

**目标**：当我写完博客后，只需对 Agent 说“帮我提交”，它就能自动生成符合规范的 Commit Message 并推送到远程仓库。

## 1 目录结构设计
首先，我们需要在本地建立一个符合协议的仓库结构。Claude Code 对插件的目录层级有严格要求：

```text
my-agent-skills/               # [Marketplace] 根目录
├── .claude-plugin/            # [配置中心] 必须包含
│   └── marketplace.json       # 核心清单文件
└── blog-publisher/            # [Skill] 具体技能包
    └── SKILL.md               # 技能定义
```

## 2 核心配置文件 (marketplace.json)
文件路径：my-agent-skills/.claude-plugin/marketplace.json

```json
{
  "name": "my-local-marketplace",
  "owner": {
    "name": "developer",        // 必填：即使是本地库也不能省略
    "email": "dev@local.com"    // 必填
  },
  "metadata": {
    "description": "我的个人效率工具库",
    "version": "1.0.0"
  },
  "plugins": [
    {
      "name": "blog-tools",     // 插件包名称，安装时用这个名字
      "description": "博客自动化工具集",
      "source": "./",
      "skills": [
        "./blog-publisher"      // 指向具体的文件夹名
      ]
    }
  ]
}
```

## 3 编写技能定义 (SKILL.md)
我们在 blog-publisher 目录下创建 SKILL.md，将 git 规范硬编码进去。

```md
---
name: blog-publisher
description: 专用于astro博客文章发布的自动化助手。当用户完成博客写作需要提交时，使用此技能来生成规范的提交信息并推送到远程仓库。
---

# Blog Publisher Instructions

你是一名严谨的 DevOps 工程师，专门负责博客内容的版本管理。你的目标是确保所有博客更新都以标准化的方式提交到 Git 仓库。

## 核心流程

当用户请求提交博客时，请严格遵循以下步骤：

1.  **环境检查**：
    * 运行 `git status` 查看当前变更。
    * 如果是新增文件，确认是否为 markdown (`.md`) 或 Astro 相关文件。

2.  **生成提交信息 (Commit Message)**：
    * 分析变更文件的内容（例如读取文件头部的 title）。
    * **严格**遵循以下 Conventional Commits 格式：
        * 新增文章：`feat(post): 添加《文章标题》文章`
        * 修改文章：`docs(post): 更新《文章标题》内容`
        * 配置调整：`chore(config): 修改 Astro 配置文件`
    * **注意**：提交信息必须简洁明了。

3.  **执行提交**：
    * 向用户展示你生成的 Commit Message，并简短告知将要执行的命令。
    * 执行 `git add .` (或指定文件)。
    * 执行 `git commit -m "你的提交信息"`。
    * 执行 `git push`。

4.  **验证**：
    * 检查 push 命令的返回结果，确保没有报错。

## Guidelines

* **安全性**：如果在 `git status` 中发现 `.env` 或包含密钥的文件，**立即停止**并警告用户。
* **自动化**：尽量调用终端工具自动完成，不要让用户手动操作，除非遇到冲突。
* **语气**：专业、干练。执行成功后，可以祝贺用户又积累了一篇知识。

## Examples

User: "我写完了《Agent原理》这篇博客，帮我提交一下"
Assistant: 
Step 1: Checked status. Found `src/pages/posts/agent-theory.md`.
Step 2: Generated message: `feat(post): 添加《Agent原理》文章`
Step 3: Executing git commands...
[Output] Push success.
```
## 4 安装与运行
配置完成后，在 Claude Code (CLI) 中执行以下命令进行注册：

添加本地仓库：

```shell
# 添加本地仓库：
/plugin marketplace add /你的绝对路径/my-agent-skills
# 安装插件：
/plugin install blog-tools@my-local-marketplace
```

效果演示： 
现在，你只需在终端输入：
```
"刚写完关于 Agent 的文章，帮我提交一下"，Agent 就会自动根据你定义的规则，完成剩下的所有 Git 操作。