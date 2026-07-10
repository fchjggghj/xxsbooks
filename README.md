# GPTS 小说两阶段队列工具

这是一个本地批量队列工具，用 Chrome 自动化把小说章节发送给 ChatGPT GPTS，并把回复保存到本地文件。

当前项目只保留两阶段流程：

1. `chai`：把 `input` 里的原文章节发送给拆大纲 GPTS，输出到 `output/01_chai`。
2. `xie`：把 `output/01_chai` 里的拆文结果发送给正文 GPTS，输出到 `output/02_xie`。

文件流：

```text
input
  -> output/01_chai
  -> output/02_xie
```

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

## 输入目录

推荐格式：

```text
input/
  小世界A/
    001.txt
    002.txt
    003.txt
  小世界B/
    001.txt
    002.txt
```

每个顶层文件夹会被当作一个独立小世界/小说对话处理。文件名建议用补零编号，保证章节顺序稳定。

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
  - 读取 `input`
  - 输出到 `output/01_chai`
  - `promptTemplate`：`【严格按照提示词执行，注意上下文】` + 当前内容

- `config-xie.json`
  - GPTS：`https://chatgpt.com/g/g-69fcd66363e08191b7089e3f1d124aab-zheng-wen`
  - 读取 `output/01_chai`
  - 输出到 `output/02_xie`
  - `promptTemplate`：`【严格按照提示词执行，注意上下文】` + 当前内容

## 失败恢复

队列严格顺序执行。某一步失败后，修复问题并重新运行同一个命令，会从失败章节继续。

如果确认要重新生成已存在输出，可以使用对应的 `:force` 脚本，例如：

```powershell
npm run xie:force
```

本仓库不再保留 `prompts/` 目录，也不再保留改编大纲或本地拆分阶段。
