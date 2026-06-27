# GPTS 小说队列工具

这是一个本地批量队列工具，用 Chrome 自动化把小说章节按顺序发送给 ChatGPT GPTS，并把回复保存到本地文件。

默认流程分两段：

1. `拆大纲 GPTS`：`input` 原文章节 -> `output/01_dagang`
2. `正文 GPTS`：`output/01_dagang` 大纲 -> `output/02_zhengwen`

## 适合谁

适合需要批量处理多本小说的人，尤其是这种固定流程：

- 一本小说有多个章节。
- 每章按顺序发送给 GPTS。
- 上一章成功输出后，才允许发送下一章。
- 当前章节失败时，停在当前章节，不跳过、不乱序。
- 每本小说使用独立 GPTS 对话，避免不同小说上下文混在一起。

## 安装

需要 Node.js 20 或更高版本，以及 Google Chrome。

```powershell
npm install
```

## 启动 Chrome 自动化环境

先启动专用 Chrome：

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

推荐格式是：每本小说一个文件夹，每章一个文件。

```text
input/
  小说A/
    001.txt
    002.txt
    003.txt
  小说B/
    001.txt
    002.txt
```

文件名建议用补零编号，例如 `001.txt`、`002.txt`，这样排序最稳定。

根目录下的单个 `.txt` 也能跑，但只建议测试用。正式批量处理请使用小说文件夹。

## 运行

预览队列，不发送给 GPTS：

```powershell
npm run pipeline:dry
```

完整运行两段流程：

```powershell
npm run pipeline
```

也可以分开跑：

```powershell
npm run dagang
npm run zhengwen
```

## 默认队列规则

当前固定策略：

```json
{
  "chaptersPerPrompt": 1,
  "conversationScope": "novel",
  "retryMode": "edit-and-resend",
  "maxRetries": 2
}
```

含义：

- `chaptersPerPrompt: 1`：每章一个 prompt。
- `conversationScope: "novel"`：每本小说一个独立 GPTS 对话。
- `retryMode: "edit-and-resend"`：失败后优先编辑当前失败消息并重新发送。
- `maxRetries: 2`：当前章节最多自动重试 2 次。

不会按 prompt 数量换对话。只有进入下一本小说时，才会打开新的 GPTS 对话。

## 失败恢复

队列是严格顺序执行的：

```text
小说A/001.txt -> 成功
小说A/002.txt -> 成功
小说A/003.txt -> 失败，停止
小说A/004.txt -> 不会发送
小说B/001.txt -> 不会发送
```

修复问题后重新运行同一个命令，会从失败章节继续。

状态文件保存在：

```text
output/01_dagang/state.json
output/02_zhengwen/state.json
```

日志保存在：

```text
output/01_dagang/run.log
output/02_zhengwen/run.log
```

这些都是运行产物，不建议提交到仓库。

## 配置 GPTS

两个阶段的 GPTS 地址在这里：

```text
config-dagang.json
config-zhengwen.json
```

如果你要换成自己的 GPTS，改里面的 `gptUrl` 即可。

## 输出目录

拆大纲输出：

```text
output/01_dagang/小说A/001.md
```

正文输出：

```text
output/02_zhengwen/小说A/001.md
```

## 常用命令

```powershell
npm run chrome        # 启动/复用自动化 Chrome
npm run pipeline:dry  # 预览两段队列
npm run pipeline      # 运行拆大纲 + 正文
npm run dagang        # 只跑拆大纲
npm run zhengwen      # 只跑正文
npm run check         # 检查脚本语法
```

## 发布仓库前

建议确认：

- `input` 里没有真实小说。
- `output` 里没有生成结果、状态文件、日志。
- `config-*.json` 里的 GPTS 地址是否允许别人使用。
- Chrome 登录目录 `C:\chrome-automation` 不属于仓库，不需要提交。
