# GPTS 小说两阶段队列工具

> 当前版本采用“阶段配置 + 单书配置 + 单章任务 + 会话归属注册”的隔离结构。完整边界和操作方式见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

常用的单书命令：

```powershell
node control.mjs start chai --book "书名"
node control.mjs start xie --book "书名"
```

正文完成后可把每本书绑定到独立的本地 Chrome 番茄登录态。番茄发布默认只预览，完整说明见 [docs/FANQIE_PUBLISH.md](docs/FANQIE_PUBLISH.md)：

```powershell
npm run fanqie:chrome
npm run fanqie:status
npm run fanqie:upload             # 只预览
npm run fanqie:upload -- --apply  # 明确确认后才发布
```

本地控制台也已提供番茄专区：

```powershell
npm run ui
```

账号的真实 Profile 路径放在被 Git 忽略的 `config/local/fanqie-accounts.json`；书籍配置只保存可迁移的 `accountRef`。发布过程带逐章持久化状态、质量门禁、reconcile 和失败截图留证。

独立 Chrome 账号目录和大型素材库可以作为“本机外部资源”接入，不复制登录态或整库正文。完整说明见 [docs/EXTERNAL_RESOURCES.md](docs/EXTERNAL_RESOURCES.md)：

```powershell
node control.mjs resources import --fanqie-root "C:\Users\Administrator\Desktop\番茄账号-独立Chrome" --material-root "D:\素材库" --apply
node control.mjs material index --apply
node control.mjs material search --query "快穿 反派"
```

写正文时，章节标题固定取同章 `原文` 文件首行；提示词和落盘阶段都会校验，GPT不能自行改题。

这是一个本地批量队列工具，用 Chrome 自动化把小说章节发送给 ChatGPT GPTS，并把回复保存到本地文件。

当前项目按「书」组织，每本书自包含三个子目录，两阶段流程在书内部流转：

1. `chai`：把某本书 `原文/` 里的章节发送给拆大纲 GPTS，输出到同一本书的 `拆分/`。
2. `xie`：把某本书 `拆分/` 里的拆文结果发送给正文 GPTS，输出到同一本书的 `正文/`。

两个阶段都固定为“一次一章、逐章顺序处理”。`chaptersPerPrompt` 必须为 `1`；如果配置误改成多章，程序会在发送前直接报错，避免多章混发或回复拆分错位。

文件流（每本书独立）：

```text
书籍/书名/原文   ->  书籍/书名/拆分   ->  书籍/书名/正文
```

## 对话地址隔离（重要）

GPTS 是 ChatGPT 的定制助手（地址形如 `chatgpt.com/g/g-xxxx`）。每打开一次会生成一个独立对话，有自己的准确地址（形如 `chatgpt.com/c/xxxx`）。

- 同一本书的多章节必须发到**同一个对话地址**，保持上下文连续。
- 不同书之间**绝对不能跨地址**串话。
- 每本书在 `chai` 阶段有一个对话地址、在 `xie` 阶段有另一个对话地址，各自独立记录在该阶段的状态文件里，互不干扰。
- 队列只使用自己新建的专属标签页，并在退出时关闭该标签页，不复用手工打开的历史会话标签页。

这套隔离由 `state.novelConversations[书名]` 实现，队列会自动记住每本书对应的对话地址并复用，无需手动管理。

## 安装

需要 Node.js 20 或更高版本，以及 Google Chrome。

```powershell
npm install
```

## 启动 Chrome

```powershell
npm run chrome
```

它会使用：

```text
CDP: http://127.0.0.1:9222
Profile: C:\chrome-automation
```

第一次使用时，在打开的 Chrome 里登录 ChatGPT。之后不要删除 `C:\chrome-automation`，登录状态会复用。

## 书目录结构

每本书在 `书籍/` 下一个独立目录，内含三个子目录：

```text
书籍/
  书名A/
    原文/          <- chai 阶段读取
      001.txt
      002.txt
      003.txt
    拆分/          <- chai 输出 / xie 读取
      001.md
      002.md
      003.md
    正文/          <- xie 输出
      001.md
      002.md
      003.md
  书名B/
    原文/
    拆分/
    正文/
```

每个 `书籍/` 下的顶层目录就是一本书，书名即目录名。文件名建议用补零编号，保证章节顺序稳定。状态文件与日志集中放在 `书籍/.state/`，不污染各书目录：

```text
书籍/.state/
  chai/state.json, run.log, control-chai.log
  xie/state.json, run.log, control-xie.log
  .gpts-queue.lock.json
```

## Codex 控制（推荐）

Codex 使用项目根目录的 `control.mjs` 控制队列。查看状态不会启动 Chrome、修改状态文件或发送内容：

```powershell
node control.mjs status --json
```

控制命令：

```powershell
node control.mjs start chai
node control.mjs resume chai
node control.mjs start xie
node control.mjs resume xie
node control.mjs stop
```

`xie` 只有在 `chai` 全部完成后才能开始。`start` 和 `resume` 受单实例锁保护，不会允许两个队列同时操作 Chrome 和状态文件。

检查状态文件与实际输出是否一致：

```powershell
node control.mjs reconcile chai
node control.mjs reconcile xie
```

以上命令只报告差异。只有明确确认要修复时才执行写操作：

```powershell
node control.mjs reconcile chai --apply
node control.mjs reconcile xie --apply
```

`force`、重置状态和 `reconcile --apply` 都可能改写进度，Codex 不会自动执行。每次控制操作前后都会先后检查 `node control.mjs status --json`。

你可以直接对 Codex 说“查看进度”“继续拆”“开始写”“停止”或“修复状态”。项目级规则见 `AGENTS.md`，控制 skill 位于 `.agents/skills/xxsbooks-control/`。

## 底层运行命令

仍可直接运行原始发送器：

```powershell
npm run chai
npm run xie
npm run pipeline
```

`npm run pipeline:dry`、`npm run chai:dry` 和 `npm run xie:dry` 现在是只读的发送队列预览，但不包含控制器健康信息，不能代替 `status --json`。带 `--reset-state` 的命令仍会修改状态。

## 当前关键配置

- `config-chai.json`
  - GPTS：`https://chatgpt.com/g/g-6a008fa0c5208191baf690ede768a20c-chai-da-gang`
  - 读取每本书的 `原文/`，输出到同书的 `拆分/`
  - `promptTemplate`：`【严格按照提示词执行，注意上下文】` + 当前内容

- `config-xie.json`
  - GPTS：`https://chatgpt.com/g/g-69fcd66363e08191b7089e3f1d124aab-zheng-wen`
  - 读取每本书的 `拆分/`，输出到同书的 `正文/`
  - `promptTemplate`：`【严格按照提示词执行，注意上下文】` + 当前内容

## 失败恢复

队列严格顺序执行。某一步失败后，修复问题并重新运行同一个命令，会从失败章节继续。

任务只有在页面确认新增了用户消息后才会记为“已发送”，并立即保存实际会话地址；因此程序在发送前中断时不会误走“编辑并重发”，发送后中断时也能回到正确会话继续。

如果确认要重新生成已存在输出，可以使用对应的 `:force` 脚本，例如：

```powershell
npm run xie:force
```

本仓库不再保留 `prompts/` 目录，也不再保留改编大纲或本地拆分阶段。
