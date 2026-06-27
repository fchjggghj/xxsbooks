# 项目记忆

这个文件记录本项目的设计意图、默认行为和维护约定，方便以后交接、继续开发，或让新的自动化助手快速理解项目。

## 项目定位

这是一个本地 GPTS 小说队列工具。

它通过 Chrome CDP 复用已登录的 ChatGPT 浏览器，把本地小说章节按顺序发送到指定 GPTS，并把 GPTS 回复保存为本地 Markdown 文件。

## 默认工作流

项目分两段：

1. `dagang`：把 `input` 里的原文章节发送给拆大纲 GPTS，输出到 `output/01_dagang`。
2. `zhengwen`：把 `output/01_dagang` 里的大纲发送给正文 GPTS，输出到 `output/02_zhengwen`。

常用命令：

```powershell
npm run chrome
npm run pipeline:dry
npm run pipeline
```

## 输入约定

推荐结构：

```text
input/
  小说名/
    001.txt
    002.txt
    003.txt
```

每个 `input` 下的顶层文件夹会被视为一本小说。根目录单文件也兼容，但只建议测试使用。

## 队列语义

- 默认每章一个 prompt。
- 每本小说在每个阶段使用一个独立 GPTS 对话。
- 切换到下一本小说时，才打开或复用下一本小说自己的 GPTS 对话。
- 同一本小说内必须按章节顺序处理。
- 上一章成功输出后，才允许发送下一章。
- 任意章节失败时，队列停在当前章节，不跳过、不继续下一章、不进入下一本。
- 重试优先使用 `edit-and-resend`，即编辑失败的用户消息并重新发送。

## 状态文件

运行时会在 `output` 里生成状态文件，不应提交：

```text
output/01_dagang/state.json
output/02_zhengwen/state.json
```

当前状态版本是 `3`，核心字段是 `novelConversations`，用于记录“每本小说对应哪个 GPTS 对话 URL”。

## Chrome 登录状态

自动化浏览器使用：

```text
http://127.0.0.1:9222
C:\chrome-automation
```

`C:\chrome-automation` 是持久登录资料目录。不要随意删除它，否则需要重新登录 ChatGPT。

## 关键文件

- `gpts-queue.mjs`：队列状态机和 ChatGPT 页面自动化。
- `start-chrome.ps1`：启动或复用带 CDP 的 Chrome。
- `config-dagang.json`：拆大纲阶段配置。
- `config-zhengwen.json`：正文阶段配置。
- `README.md`：给使用者看的说明书。
- `PROJECT_MEMORY.md`：给维护者和后续自动化助手看的项目记忆。

## 发布前检查

发布仓库前确认：

- `input` 里没有真实小说。
- `output` 里没有生成结果、状态文件和日志。
- `config-*.json` 里的 GPTS 地址是否允许别人使用。
- `node_modules` 没有提交。
- `C:\chrome-automation` 不属于仓库，不需要提交。

## 维护注意

- 清理运行产物时只清理 `input`/`output` 内容，不要碰脚本和配置。
- 如果 ChatGPT 页面结构变化，优先检查 `gpts-queue.mjs` 里的输入框、发送按钮、编辑按钮选择器。
- 保持严格顺序队列，不要实现“失败后跳过继续”的逻辑。
- 不要重新引入“按 prompt 数量换对话”的策略；当前固定策略是“每本小说一个独立对话”。
