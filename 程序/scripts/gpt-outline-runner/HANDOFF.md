# 项目交接文档（HANDOFF）

> 新窗口/新会话读这一个文件就能接上全部上下文。最后更新：本次会话结束时。

---

## 现状校正（2026-06-20，以代码为准，优先于下方所有历史记录）

下方 §1–§15 是历史开发记录，部分与当前代码**不一致**。实测核对后的真相：

- **只有「拆大纲」单段在用、能跑。** `run.mjs` 只做拆大纲（`章节`→`拆大纲`），**不读** `--stage` /
  `config.json.currentStage` / `pipelineStages`。dry-run 只打印 `__PENDING__`，**不打印 `__FAILED__`**。
- **三段式 / 编排器 / 下载接入并未打通**：根 `程序\scripts\pipeline.mjs` 会按 `run.mjs --stage` 调用并解析
  `__FAILED__`，二者 run.mjs 都不支持 → 编排器在第一道阶段门就停。`step1/2/3_*.py`、`run_all.py` 是
  **占位脚本**（只打印 placeholder）。`改编`/`正文` 从未运行，`data\02_adapted`、`data\03_final_text` 为空。
- **本文件没有 §16 / §17。** 其它文档（旧 `程序\README.md`、`docs\对话记录与开发日志.md`）引用的
  「HANDOFF 第16/17节 三段式 / 下载接入」**不存在**——那是没落地的设想。
- **配置即用户决定**：`config.json` `autoRunNextStage:false`、`nextStageHoldReason`=「拆大纲完成后只移动到
  新项目，不进行改编大纲或生成正文」。即：当前阶段就是只拆大纲，不要去跑改编/正文。
- **登录态保护**：自动化 Chrome 的登录资料固定保存在 `C:\chrome-automation`。不要删除、替换或清理这个目录；
  控制台、守护脚本和 `launch-chrome.ps1` 都必须继续使用 `--user-data-dir=C:\chrome-automation`，否则下次会要求重新登录。
  已有保护脚本 `protect-chrome-profile.ps1`，并注册计划任务 `NovelPipelineProtectChromeProfile` 在登录时自动重加保护；
  保护方式只阻止删除 profile 根目录，不继承到内部文件，避免影响 Chrome 正常更新 cookie/cache。
- **完成判定**：每本 `拆大纲\第NNN章.md` **或** 镜像 `data\01_broken_outlines\<本>\…`（`movedDoneOutputDir`，
  仅只读兜底）任一 ≥800B 即算完成。`01_broken_outlines` 是约 4430 个 .md 的**成品快照**（不是空目录，
  当前 run.mjs 不写它）。
- **进度数字**：拆大纲 ≈3869/3994 完成、125 待处理（截至 2026-06-20）。
- 详见根 `程序\README.md` 的「现在能用 / 未实现 占位 / 已知问题」。

阅读下方历史时，凡涉及「三段式 run.mjs / activeStage / applyStage / novelWorker / 编排器 / 自动下载
已验证」的描述，按本节修正理解——那些是设想或半成品，不是当前代码行为。

---

## 0. 一句话
做一个**本地脚本**，把本地小说章节逐章发给 ChatGPT 网页上的**自定义 GPT「拆大纲」**，抓回大纲，写回每本小说的 `改编大纲` 文件夹。目的：**学快穿结构 / 攒素材**。

---

## 1. 最终目标
用户想**学会自己写快穿小说**（也兼做素材库）。所以要把大量快穿小说**逐章拆成详细大纲**，沉淀下来研究结构。
- 自定义 GPT 链接：`https://chatgpt.com/g/g-6a008fa0c5208191baf690ede768a20c-chai-da-gang`（标题「ChatGPT - 拆大纲」）
- 提示词已内置在该 GPT 里（每章拆成 8–10 条高密度大纲、中文输出）。所以**发送时只发章节正文，不加前缀**。

---

## 2. 素材库数据（C:\Users\Administrator\Desktop\novel_pipeline\data\00_raw_chapters）
- **1207 本**小说，**全库 562,429 章**。
- 每本结构 100% 一致：
  - `章节\` ← 一章一个 txt（**输入源**），如 `第001章_古代白眼狼书生1.txt`
  - `改编大纲\` ← **输出目标**（全部为空，等着写）
  - `按故事合并\` ← 章节按「世界/弧」合并的文件（快穿每个单元一个世界）
  - 根目录还有：合并版整本 txt、`目录.txt`
- **在读人数**写在文件夹名里：`…【在读：25.1万人在读】`。**只有 380 本有在读数据，827 本没有（68%）**。
- **弧边界可从章节文件名重建**：世界名变化 + 内部编号归 1。例：`第027章_古代白眼狼书生27` → `第028章_吸姐鬼弟弟 1`。所以不依赖 `按故事合并` 也能识别世界边界。

---

## 3. 为什么是现在这个方案（决策历程，避免走回头路）
1. 最初想用**浏览器扩展**（隔壁项目 `Ophel-Atlas-Prompt-Queue`）→ **扩展/油猴脚本都在浏览器沙箱里，无法写本地任意磁盘文件夹**（`改编大纲`）。死路。
2. 正确解法：**脚本跑在浏览器外面、驱动浏览器** → 选了 **Playwright(playwright-core) 通过 CDP 连接用户真实已登录的 Chrome**。既能用免费 GPTs 网页，又有完整磁盘读写权。← **本项目就是这个**。
3. **API 才是 56 万章规模的真正正解**（批处理、几天、约几百美元用 mini 级模型、无沙箱无配额墙）。用户当前选网页方式，API 作为后续选项**保留**。

---

## 4. 已建好的东西（本项目 gpt-outline-runner）
```
gpt-outline-runner\
├── run.mjs            主流程：每本独占对话→每N章换对话→本书完自动下一本；断点续传
├── lib\files.mjs      列小说/章节、自然排序、断点(输出已存在则跳过)、读写、buildPlan
├── lib\select.mjs     选择逻辑：在读分档 + N=200 + 弧边界(不打断世界)
├── lib\chatgpt.mjs    浏览器交互（选择器移植自扩展，已实战验证）
├── config.json        所有配置
├── launch-chrome.ps1  用调试端口启动独立 Chrome
└── README.md          使用说明
```
- 已 `npm install`（只装了 playwright-core，不下载浏览器）。

---

## 5. 选择规则（config.json → "selection"）
- **在读 ≥ 5万**（87 本）→ 全书拆
- **在读 < 5万**（293 本）→ 前 200 章（**按弧边界**取整）
- **无在读数据**（827 本）→ 前 200 章（**按弧边界**取整）
- `roundToArc: true` = 不打断世界剧情（永远不切半个世界）
- **全库套规则后选中 = 231,720 章**（已用真实数据校验，分档本数 87/293/827 准确）。

---

## 6. 当前状态 & 已验证 ✅
- **端到端跑通过**：实测对 0001 跑了**前 3 章**，全部成功，质量好（大纲完整忠实、信息密度高）。
- 输出已写到 `…\0001…\改编大纲\第00X章_….md`。
- **输出格式**：用户选了**方案A**——纯文本、内容完整、分段清晰，**但没有 `##` 和 `1. 2.` 编号**（因为抓的是渲染后 innerText，markdown 标记会丢）。用户接受这个格式。若以后要原始 markdown，改 `lib/chatgpt.mjs` 的 `getLastAssistantText` 走「复制」按钮。
- 实测速度：**约 30 秒/章**（不撞配额墙时）。
- 当前 `config.json`：`novels: ["0001…"]`、`maxChapters: 3`（安全阀，试跑用）。

---

## 7. 怎么运行
```powershell
# 1. 启动调试 Chrome（已有独立配置目录 C:\chrome-automation，已登录过）
cd C:\Users\Administrator\Desktop\novel_pipeline\scripts\gpt-outline-runner
powershell -ExecutionPolicy Bypass -File .\launch-chrome.ps1
#    脚本靠它连接(端口9222)。别关这个窗口。

# 2. 只看计划（只读，不开浏览器不写文件）
npm run dry-run

# 3. 正式跑（会续传：已写出的章节自动跳过）
npm start
```
- **跑全库**：把 `config.json` 的 `novels` 改成 `[]`、`maxChapters` 改 `0`。
- **跑指定几本**：`novels` 填文件夹名数组。

---

## 7.5 硬核自动化：开机自动跑 + 崩溃自动重启（2026-06-18 搭好）
目标：把全库分档计划（约 23 万章）**尽量全部拆完**，无需人工守着。
- **`run-forever.ps1`**：守护脚本。① 保证调试 Chrome(9222)在线，不在就自动拉起；② 反复跑 `node run.mjs`，崩了/断了 30 秒后自动重开（断点续传不重复）；③ 每轮先看 `__PENDING__`（run.mjs 打印的 ASCII 待处理数），为 0 判定全部完成自动退出；④ 大事件写 `daemon.log`，逐章写 `run.log`。
- **计划任务 `GptOutlineRunner`**：登录即启动（重启电脑登录后自动恢复）、无时长上限、单实例、失败自动重启。
- **控制命令**：
  - 优雅停止：`New-Item -ItemType File "<proj>\STOP"`（跑完当前章退出；删 STOP 再 `Start-ScheduledTask` 恢复）
  - 立即停止：`Stop-ScheduledTask -TaskName GptOutlineRunner` + 杀 `run.mjs` node 进程
  - 手动开始：`Start-ScheduledTask -TaskName GptOutlineRunner`
  - 彻底卸载：`Unregister-ScheduledTask -TaskName GptOutlineRunner -Confirm:$false`
- **看进度**：`run.log`（当前轮逐章）、`daemon.log`（重启/完成等）。
- **仍需人管的两件事**：机器别睡眠/关机；ChatGPT 登录态过期需人工去 Chrome 重新登录（守护检测不了「已登出」，只会空转重试）。

## 8. 关键现实 / 坑（必读）
- **配额墙绕不过**：ChatGPT 账号有消息上限，撞到只能等。脚本会检测并暂停 `rateLimitWaitMs`(默认30分) 再试，但没法让它发更快。
- **规模**：选中 23 万章，网页方式是**数月级别**。真要全跑完 → 上 **API 批处理**。
- **反自动化 / ToS 灰区**：自动操作 ChatGPT 网页有账号风险，自行评估。
- **选择器会变**：ChatGPT 改版可能导致找不到输入框/发送键/抓不到回复 → 改 `lib/chatgpt.mjs` 里的选择器。
- **不打断世界剧情**：是基本原则。换对话、N=200 切点都只在世界(弧)边界。

---

## 9. 删除决定 & 一个异常（重要）
- **2026-06-18 重大变更：已永久删除 <5万 在读 + 无在读 的 1120 本（编号 0088–1208），素材库现仅剩 87 本头部（≥5万，编号 0001–0087）。** 删除前已核：不丢任何已生成大纲、保留区完整、0011 内嵌套的 0012 在保留区不受影响。删除清单见项目根 `_to_delete.txt`。
- 项目规模由此从「全库 231,720 章」收缩为「87 本约 41,046 章（全书拆）」。`config.json` 的 `novels:[]` 现自然只扫这 87 本。
- （历史）此前曾决定不删任何文件；本次用户改主意，明确要求删 5万以下、确认用永久删除。
- **一处真实异常**：`0011_我靠装可怜…` 文件夹里**嵌了一整本放错位置的小说** `0012_…职业嫂子`（自带 `章节` 和真实章节，是 0002 的副本）。**全库就这一处**。批量操作时要保护它别误删，留给用户手动处理（移出去/删，用户定）。

---

## 10. 待决定 / 下一步
1. **跑哪些**：先跑头部 ≥5万 的几本？还是直接全库（`novels:[]`, `maxChapters:0`）？
2. **是否转 API**：56 万/23 万章的真正正解。要的话需新建一个 API 脚本（读章节→调模型→写改编大纲），约几百美元(mini级)、几天跑完。
3. **学结构的更优做法**（之前建议、未实施）：对头部书用 `按故事合并`**弧级** + 换一套**「拆结构骨架」提示词**（节拍表：世界设定/原主起点/冲突/爽点/打脸/收尾/钩子），再做一遍汇总成「快穿写作模板」。比逐章压缩更打中「学会写」。

---

## 11. 相关：隔壁的浏览器扩展项目
`C:\Users\Administrator\Desktop\Ophel-Atlas-Prompt-Queue`（ChatGPT 提示词队列扩展）。本会话早期给它加过两个功能并构建通过：
- **每 N 条自动开新对话续发**（含按书边界换对话）
- **选择文件夹批量导入**（webkitdirectory，只导文本）
这条路后来因「无法写本地磁盘」被放弃，转到了本 Playwright 项目。扩展代码里那套 ChatGPT DOM 选择器很有价值，本项目的 `lib/chatgpt.mjs` 就是从它移植的。

---

## 附：给新窗口 Claude 的开场提示（可直接粘贴）
> 我在继续 `gpt-outline-runner` 项目（把本地快穿小说章节逐章发给 ChatGPT 自定义GPT「拆大纲」、抓大纲写回 `改编大纲`）。请先读项目根目录的 `HANDOFF.md` 了解全部背景、已完成的工作、选择规则和待决定项，然后我们继续。

---

## 12. 2026-06-18 17:03 续跑修复记录
- 接手时计划任务仍在运行，但 `run.log` 从 16:54 后大量出现 `Target page, context or browser has been closed`。原因是 Chrome/页面关闭后，`run.mjs` 的单章 `catch` 继续吞错并扫后续章节，造成大量无效失败日志。
- 已先停止 `GptOutlineRunner` 和残留 `node run.mjs`，修复 `run.mjs`：
  - 新增 `isBrowserClosedError()`：识别页面/浏览器/CDP 连接关闭后直接抛出，让 `run-forever.ps1` 退出本轮并重启。
  - 新增 `isTransientPageError()`：对 `Execution context was destroyed` 等偶发导航错误，重开会话并重试当前章一次。
  - 对“超时且没拿到回复”的章节，也先重开会话重试一次，仍为空才记失败。
- 验证：`node --check run.mjs` 通过；`npm run dry-run` 通过，当前 `__PENDING__=231463`，0002 从第 052 章继续。
- 已重新 `Start-ScheduledTask -TaskName GptOutlineRunner`。17:02 守护任务拉起 Chrome 并 `RUN_START`；17:03 已确认 0002 第 052、053 章成功写入。

## 13. 2026-06-19 控制中心网页（新增，已从纯监控升级为全功能控制台）
**零依赖本地控制台**：监控 + 在线改配置 + 队列预览 + 全部进程控制。跑批时另开终端 `npm run web`（或 `launch-web.ps1`），浏览器 http://localhost:8787（只绑 127.0.0.1）。
- **后端 `server.mjs`**：Node 内置 `http` + 复用 `lib/files.mjs`/`lib/select.mjs`，进度口径与 `run.mjs` 一致。全库扫描 60s 缓存 + 后台刷新，不拖慢 runner。API：
  - 只读：`/api/state`、`/api/log?which=run|daemon`、`/api/books`、`/api/book?name=`、`/api/failures`、`/api/plan`（队列预览=dry-run，含队列头500项+各书待处理）、`/api/chrome`（探测 CDP 是否在线）、`/api/browse?path=`（文件夹浏览器，列子目录/驱动器）、`/api/outline?path=`（沙箱.md）、`/api/chapter?path=`（沙箱.txt，预览要发送的正文）、`GET /api/config`。
  - 写：`POST /api/config`（校验+备份 config.bak.json+热重载 cfg+清缓存）、`POST /api/control`（动作：stop/resume/startTask/stopTask/launchChrome/rescan/dryRun/retry/retryAll/openFolder）。
- **前端 `web/index.html`**：单页 vanilla JS，3s 轮询。顶部状态栏(Chrome/守护/Runner 灯+配额墙告警)+控制中心按钮条；5 标签页：总览 / 队列预览 / 配置(分组表单+📁文件夹浏览+原始JSON，全部 config 项可改) / 历史日志 / 每本进度·失败(热力图+看大纲+重试/重试全部)。
- **启动器 `launch-web.ps1`**；`.claude/launch.json` 供 Claude Preview 托管。端口 env `WEB_PORT` 或 config `webPort`。
- **已修的坑**：① `/api/config` 的 GET 分支最初没判 method，把 POST 也吞了→配置保存假成功不写盘；已加 `req.method==='GET'`。② `readBody` 加 `req.setEncoding('utf8')`，防多字节中文跨 TCP 分块被截断。③ 真实 UI 用 fetch(UTF-8) 存配置不损坏中文；**注意：别用 PowerShell `Invoke-RestMethod` POST 中文配置去测，它发送非 UTF-8 会把 config.json 里的中文写成 `?`**（踩过，已还原）。
- 已端到端实测（浏览器截图+eval）：总览/队列/配置/日志/每本进度全渲染正常；配置存取往返中文完好+非法配置 400+自动备份；路径沙箱拒绝库外文件。实况：87 本 41046 章，已完成 ~1745，失败 0，35s/章。
- 备注：网页**没**接进计划任务自启（按需手动起）；要常驻可加到 `run-forever.ps1` 或单独建任务。

## 14. 2026-06-19 重大调整：每本300章 + 并发3 + 启用扩展 + 界面傻瓜化
（注：本会话后另有人把 server.mjs 扩到 1022 行、index.html 扩到 829 行，加了「提示词队列/GPTS档案/健康检查」整套；run.mjs/lib 的核心仍是原novel管线。）
- **每本只取前 300 章**：`config.json` 新增 `selection.firstNPerNovel:300`，`lib/select.mjs` 的 `selectForNovel` 改成：该值>0 时对所有书取前 N 章（`pickFirstN`，`roundToArc`仍开=不切断快穿世界），无视旧分档。规则选中 41046→**21260**。已生成的>300章大纲**保留**。dry-run 已验证。
- **并发加速**：`config.json` 新增 `concurrency:3`。`lib/chatgpt.mjs` 加 `getPages(cfg,n)` 拿 n 个标签页；`run.mjs` 主流程重写为**工作池**：扁平待处理队列 + N 个 worker 各占一个标签页、共享游标取章（文件锁防跨进程重复）；撞墙各自等待、browser-closed 置 fatal 中止本轮让守护重启。**实测 maxChapters=3 时 3 标签页并行 5 章全成 0 失败、约 3 倍速**。调并发改 `concurrency`（1=不并发）。
- **启用扩展**：去掉 3 处 `--disable-extensions`（`launch-chrome.ps1`/`run-forever.ps1` EnsureChrome/`server.mjs` launchChrome）。**坑**：ChatGPTKeep 的自动刷新正是之前丢章元凶——要在扩展设置里**关掉自动刷新**只留保活；改扩展后需重启调试 Chrome 才生效。详见 [[keepchatgpt-gotcha]]。
- **界面傻瓜化**（`web/index.html`）：英文加中文括注（Chrome/Runner/STOP/idle/bytes/阶段名等）；每个按钮旁注入小「?」点开看说明（`HELP` 注册表 + `initHelp()` 按 id 注入 + 点击气泡）；基础配置表单新增「每本取前几章」「并发标签页数」两项可视化调；修了警告横幅引用已删按钮名的措辞。
- 当前状态：已停旧任务→改配置→实测并发→`Start-ScheduledTask` 恢复。19:01 守护新一轮 PENDING=19747、3 标签页开跑。

## 15. 2026-06-20 批量发送（少撞限制）+ 并发回1 + 删到16本
- **素材库又删到 16 本**（0001–0016，用户主动删的）。每本前 300 章 → 规则选中约 3994 章。
- **一次 5 章合 1 个提示**（`config.json` 加 `chaptersPerRequest:5`）：请求数砍到 1/5，少撞时间/次数限制。`run.mjs` 工作池改成「按书+每5章切批」：`buildBatchPrompt` 用 `=====CHAPTER-k=====` 标记让 GPT 逐章输出，`splitBatch` 按标记切回 N 段（标记数≠N 就整批作废重发，绝不写错位），每段校验 usable 后分别落盘。切分失败/被拒/瞬时错误 → `sendSingle` **逐章兜底**（老的一章一发，最稳），保证不写错位、能最终完成。**实测 maxChapters=10 跑出 20 章全成、0 失败、零切分失败**（GPT 很听话地按标记分段）。批量后每章大纲略短（约 850–1100 字 vs 单发 1200–1700）。
- **并发回到 1**（`concurrency:1`，用户要最稳）。配合批量，请求频率已很低。
- **坑（重要）**：8787 面板若用**旧的、没刷新的页面**点「保存配置」，会用旧表单重构 config.json、把直接改文件加的新字段（firstNPerNovel/concurrency/chaptersPerRequest）冲掉！已踩过并修复。改完 config.json 后若面板在跑，要么重启面板 server.mjs（让内存 cfg 刷新）、要么让用户 Ctrl+F5 刷新页面再操作。基础配置表单已补上「每本取前几章/并发标签页数/每请求章数」三项。
- 扩展：已去掉 `--disable-extensions` 并重启过调试 Chrome（命令行已确认无该参数），用户可在该窗口装 Tampermonkey+KeepChatGPT；记得关 KeepChatGPT 自动刷新。详见 [[keepchatgpt-gotcha]]。
