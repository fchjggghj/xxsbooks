# 项目记忆

这个文件记录本项目的设计意图、默认行为和维护约定，方便以后交接、继续开发，或让新的自动化助手快速理解项目。

## 项目定位

这是一个本地 GPTS 小说队列工具。

它通过 Chrome CDP 复用已登录的 ChatGPT 浏览器，把本地小说章节按顺序发送到指定 GPTS，并把 GPTS 回复保存为本地 Markdown 文件。

## 默认工作流

项目只保留两段：

1. `chai`：把 `input` 里的原文章节发送给拆大纲 GPTS，输出到 `output/01_chai`。
2. `xie`：把 `output/01_chai` 里的拆文结果发送给正文 GPTS，输出到 `output/02_xie`。

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

运行时状态文件位于书库根目录，不应提交：

```text
书籍/.state/chai/state.json
书籍/.state/xie/state.json
```

当前状态版本是 `4`。`novelConversations` 记录“每本小说对应哪个 GPTS 对话 URL”，`conversationOwners` 防止同阶段两本书认领同一地址。单书任务合并必须保留未选择书籍的状态。

## Chrome 登录状态

自动化浏览器使用：

```text
http://127.0.0.1:9222
C:\chrome-automation
```

`C:\chrome-automation` 是持久登录资料目录。不要随意删除它，否则需要重新登录 ChatGPT。

番茄发布使用另一套“每书作品绑定 + 本机账号注册表”。书籍配置只保存 `accountRef`、作品 ID、排期和质量规则；真实 Profile/CDP 配置位于被忽略的 `config/local/fanqie-accounts.json`。它不与 ChatGPT 的 `C:\chrome-automation` 混用。`fanqie-control.mjs` 默认只预览；只有 `upload --apply` 发布，且发布前必须逐章核对远端已有标题、通过质量与排期门禁并持有独立发布锁。

番茄逐章状态位于 `书籍/.state/fanqie/<作品ID>/state.json`，阶段为 planned/editing/submitting/submitted/confirmed/failed。异常页面自动保存 screenshot/HTML/JSON；`reconcile` 默认只预览，存在不确定提交时拒绝自动应用。

## 关键文件

- `gpts-queue.mjs`：队列状态机和 ChatGPT 页面自动化。
- `start-chrome.ps1`：启动或复用带 CDP 的 Chrome。
- `config-chai.json`：拆大纲阶段配置。
- `config-xie.json`：正文阶段配置。
- `config/books/*.json`：每本书的独立启用状态和阶段章节范围；未配置书籍不会进入队列。
- `lib/task-scope.mjs`：单书选择和章节范围，不负责目录发现。
- `lib/book-catalog.mjs`：书籍配置发现，不负责任务状态。
- `lib/chapter-title.mjs`：从原文读取并强制保留章节原题。
- `lib/conversation-registry.mjs`：会话地址归属校验。
- `scripts/`：可预览、可审计的维护操作；默认不写入。
- `fanqie-control.mjs`：启动绑定 Profile、检查番茄远端章节并按排期失败即停地发布。
- `lib/fanqie-*.mjs`：番茄绑定、章节计划、浏览器操作与独立发布锁。
- `lib/queue/config.mjs`：队列参数与配置加载；`lib/control/status.mjs`：控制器只读状态汇总。入口文件只负责流程编排。
- `ui/` 与 `local-ui.mjs`：本机控制台；番茄页只在用户点击时访问远端，发布需要确认短语和二次弹窗。
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
- 不要重新引入改编大纲、本地拆分或三阶段流程。
- 不要重新引入“按 prompt 数量换对话”的策略；当前固定策略是“每本小说一个独立对话”。
