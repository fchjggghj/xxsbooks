# GPTS 小说三章批处理队列工具

这是一个本地批量队列工具，用 Chrome 自动化把小说章节发送给 ChatGPT GPTS，并把回复保存到本地文件。

当前项目采用“三个 GPTS 步骤 + 一个本地拆分步骤”的流程：

1. `拆大纲 GPTS`：每次输入 3 个连续原文章节，输出 3 个原章节细纲。
2. `改编大纲 GPTS`：每次输入上一批 3 个原章节细纲，改编并重排成 2 个新章节大纲。
3. `本地拆分`：把改编 GPTS 输出的 2 个新章节大纲拆成 2 个单章大纲文件。
4. `正文 GPTS`：逐个输入单章新大纲，每次只生成 1 章正文。

文件流：

```text
input
  -> output/01_dagang
  -> output/02_adapt
  -> output/02_adapt_chapters
  -> output/03_zhengwen
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

## 运行

预览队列：

```powershell
npm run pipeline:dry
```

完整运行：

```powershell
npm run pipeline
```

分步运行：

```powershell
npm run dagang
npm run adapt
npm run split-adapt
npm run zhengwen
```

## 当前关键配置

- `config-dagang.json`
  - `chaptersPerPrompt: 3`
  - `promptTemplate` 已内联统一前缀：`【严格按照提示词执行，注意上下文】`
  - 每次发送 3 个连续原文章节。
  - 输出到 `output/01_dagang`。

- `config-adapt.json`
  - `promptTemplate` 已内联统一前缀：`【严格按照提示词执行，注意上下文】`
  - 每次读取 1 个拆大纲批次文件。
  - 让改编 GPTS 把 3 个原章节细纲重排成 2 个新章节大纲。
  - 输出到 `output/02_adapt`。

- `scripts/split-adapt-chapters.mjs`
  - 读取 `output/02_adapt`。
  - 按 `### 新第1章：...`、`### 新第2章：...` 拆分。
  - 输出单章大纲到 `output/02_adapt_chapters`。

- `config-zhengwen.json`
  - `promptTemplate` 已内联统一前缀：`【严格按照提示词执行，注意上下文】`
  - 读取 `output/02_adapt_chapters`。
  - 每次只生成 1 章正文。
  - 输出到 `output/03_zhengwen`。

## 失败恢复

队列严格顺序执行。某一步失败后，修复问题并重新运行同一个命令，会从失败章节继续。

如果确认要重新生成已存在输出，可以使用对应的 `:force` 脚本，例如：

```powershell
npm run zhengwen:force
```

如果改编大纲重新生成过，建议重新运行：

```powershell
npm run split-adapt
```

这个脚本会重建 `output/02_adapt_chapters`，避免旧拆分文件混进正文队列。

## 提示词

本仓库不再保留 `prompts/` 目录。每次发送给 GPTS 的统一前缀已经直接写入各阶段 `config-*.json` 的 `promptTemplate`。
