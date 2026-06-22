# script-controller

本项目现在定位为本地脚本控制器：读取素材库章节文件，驱动已登录的浏览器执行端，等待输出稳定后写回本地文件夹。

- 输入：`C:\Users\Administrator\Desktop\novel_pipeline\data\00_raw_chapters\<小说>\章节\第NNN章_xxx.txt`
- 输出：`C:\Users\Administrator\Desktop\novel_pipeline\data\00_raw_chapters\<小说>\改编大纲\第NNN章_xxx.md`
- 队列：按配置筛选章节，生成待执行任务，支持断点续跑、失败重试、跳过、预排队查看。
- 稳定性：有效输出已存在的章节自动跳过；运行锁、守护锁、单章锁、失败标记会避免重复执行。

## 一次性准备

```powershell
cd C:\Users\Administrator\Desktop\novel_pipeline\scripts\gpt-outline-runner
npm install
```

## 每次使用

1. 启动执行浏览器：

```powershell
powershell -ExecutionPolicy Bypass -File .\launch-chrome.ps1
```

首次需要在弹出的浏览器窗口完成目标页面登录。

2. 配置 `config.json`：

- `gptUrl`：历史字段名，现在表示执行端入口链接。
- `novels`：要处理哪些小说，空数组 `[]` 表示全库。
- `chaptersPerConversation`：每个执行会话处理多少章后切换新会话。

3. 先空跑确认计划：

```powershell
npm run dry-run
```

4. 正式执行：

```powershell
npm start
```

保持执行浏览器窗口开着。脚本会按队列提交任务、等待输出、写入文件。随时 `Ctrl+C` 可停；下次会从已写出的章节继续。

## 控制中心网页

启动：

```powershell
npm run web
```

打开 `http://localhost:8787`。

控制中心方向是脚本控制器，不再以聊天网站面板为主：

- 总览：整体进度、速度、ETA、输入输出文件夹、执行端入口。
- 脚本队列：任务列表、预排队明细、执行档案、批量导入、失败重试、输出预览、事件时间线。
- 脚本配置：在线修改素材库、选择规则、执行速度、等待重试、端口等配置。
- 历史日志：查看 `run.log` 和 `daemon.log`。
- 每本进度 / 失败：按书查看完成度、失败原因和重试入口。

顶部常驻按钮负责启动执行浏览器、打开素材库、开始/暂停/继续/停止队列。

## 三段执行端

当前流水线固定为三段：

1. 拆大纲：`https://chatgpt.com/g/g-6a008fa0c5208191baf690ede768a20c-chai-da-gang`
2. 改编大纲：`https://chatgpt.com/g/g-6a31e876bd7c8191a99c41e4d53b3395-gai`
3. 生成正文：`https://chatgpt.com/g/g-69fcd66363e08191b7089e3f1d124aab-zheng-wen`

上下文规则：

- 拆大纲：普通队列执行，可以按任务/批次处理。
- 改编大纲：需要上下文，同一本小说保持同一个会话完成。
- 生成正文：需要上下文，同一本小说保持同一个会话完成。

## 注意

- 执行端可能有账号上限或频率限制，脚本只能检测后等待，不能绕过限制。
- 目标页面改版可能导致输入框、提交按钮或输出读取失效，需要更新 `lib/chatgpt.mjs` 里的选择器。
- 大规模全库执行时间会很长，建议先小批量验证配置和输出质量。

