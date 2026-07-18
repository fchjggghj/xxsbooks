# 番茄小说自动发布

每本小说在自己的 `config/books/*.json` 中绑定番茄作品和 `accountRef`。真实 Chrome Profile 路径保存在被 Git 忽略的 `config/local/fanqie-accounts.json`，不保存账号密码，也不把 Cookie 写入项目。

## 日常使用

当前只有一个启用绑定时可以省略 `--book`：

```powershell
npm run fanqie:chrome
npm run fanqie:local-status
npm run fanqie:status
npm run fanqie:upload
```

`status` 会打开一个专用自动化标签页，只读取番茄章节列表，并逐章核对本地标题。`upload` 默认同样只是预览计划。确认书名、作品 ID、远端章数、待传章节和排期都正确后，才执行：

```powershell
npm run fanqie:upload -- --apply
```

也可以统一从主控制器调用：

```powershell
node control.mjs fanqie local-status --json
node control.mjs fanqie status --book "书名" --json
```

多本书时明确指定：

```powershell
npm run fanqie:status -- --book "书名"
npm run fanqie:upload -- --book "书名" --from 61 --to 64 --apply
```

`--from` 不能跳过番茄端下一章。任何标题不一致、远端章数超过本地、登录态失效、作品不匹配或提交后校验失败都会立即停止。

## 发布状态与恢复

正式发布会把每章记录为：

```text
planned -> editing -> submitting -> submitted -> confirmed
```

状态位于 `书籍/.state/fanqie/<作品ID>/state.json`。如果提交后浏览器或页面异常，使用：

```powershell
npm run fanqie:reconcile
npm run fanqie:reconcile -- --apply
```

预览会比较远端章节 ID、审核状态和发布时间。只有不存在“不确定提交”“本地已确认但远端缺失”等人工核对问题时，才允许 `--apply` 回填状态。

页面失败时会在 `书籍/.state/fanqie/<作品ID>/failures/` 保存截图、HTML 和 JSON 诊断信息。JSONL 日志达到 5MB 后保留三份轮转日志。

## 发布前质量门禁

每本书可在 `fanqie.quality` 调整正文字数上下限、标题最大长度和定时发布最小提前分钟数。预检还会阻止重复标题、Markdown 标题前缀、过去排期，并提示疑似 AI 助手话术或重复标题残留。AI 使用声明仍必须由 `aiUsed` 明确配置。

新建作品默认参加当前可用征文，书籍绑定以 `contestParticipation: true` 记录该选择。AI 声明不跟随征文默认值：每本书必须根据实际创作过程明确设置 `aiUsed`，GPTS 流程产出的正文应设为 `true`。

## 封面、简介和标签

六本书的中央营销资料位于 `config/fanqie-marketing.json`。它同时绑定本地书名、账号引用、作品 ID、后台书名、作者名、封面、主角、分类标签和简介；账号、作品 ID 或后台书名任一不匹配时，远端修改会停止。

先预览单本修改：

```powershell
npm run fanqie:marketing -- --book "书名"
```

确认后才应用到绑定账号：

```powershell
npm run fanqie:marketing -- --book "书名" --apply
```

作品资料修改同样使用账号级发布锁。提交前会逐项回读标签、主角名和简介，并保存编辑页证据。提交后有两种成功状态：`visible` 表示新资料已经显示；`pending_review` 表示平台已锁定“修改”按钮或出现成功提示，资料正在审核。审核锁定期间不得重复提交。

把封面和书籍信息复制到每本书的 `正文` 目录：

```powershell
npm run fanqie:marketing-sync
```

该命令只写入 `番茄封面.png` 和 `番茄书籍信息.md`，不会改写章节文件。

## 首次绑定

绑定命令默认只打印预览，不修改配置。它可以从已有 `.lnk` 快捷方式读取 `--user-data-dir` 和 `--profile-directory`：

```powershell
npm run fanqie:bind -- `
  --book "书名" `
  --account-ref account-01 `
  --shortcut "C:\路径\番茄账号.lnk" `
  --work-id 1234567890 `
  --work-title "番茄后台作品名" `
  --contest-participation true `
  --ai-used true `
  --first-chapter 5 `
  --first-date 2026-07-19 `
  --chapters-per-day 4 `
  --time 00:00
```

核对输出后在末尾加 `--apply`。命令会把作品信息写入书籍配置，把本机 Profile 写入 `config/local/fanqie-accounts.json`。也可以用 `--profile-dir "C:\绝对路径" --profile-name Default` 代替快捷方式。

`firstChapter` 表示从哪一章开始使用该排期。若设为 5，番茄端必须已经存在并匹配前 4 章；程序不会替前置章节猜测发布时间。

## 登录态与安全

- `fanqie:chrome` 只启动绑定的专用 Profile 和专用 CDP 端口，不会结束任何 Chrome 进程。
- 如果同一 Profile 已在普通 Chrome 中打开，CDP 可能无法启用。只关闭这个番茄账号窗口后重试，不要结束其他账号窗口。
- 登录过期时，在弹出的专用 Chrome 窗口中手工重新登录，再运行 `fanqie:status`。
- 发布器会自动处理新手引导，以及“我知道了”“下次再说”“关闭”等白名单安全弹窗；发布确认、内容检测、AI 声明等关键弹窗不做通用关闭，仍按明确配置执行。正文写入后还会核对编辑器中的实际文本，弹窗遮挡导致写入失败时会清除安全遮挡并重试一次。
- AI 使用情况由配置中的 `aiUsed` 明确声明；发布器不会自行猜测或改变。
- 应用发布时按账号使用 `书籍/.state/fanqie/.publish.<accountRef>.lock.json` 防止同账号并发；不同账号可安全并行。逐章结果追加到 `书籍/.state/fanqie/run.log`。

## 本地控制台

```powershell
npm run ui
```

打开控制台的“番茄发布”页，可以查看本地绑定和质量结果、启动专用 Chrome、手工执行远端预检、预览上传与 reconcile。页面不会自动连接番茄。

状态回填和发布分别要求输入 `RECONCILE 书名`、`PUBLISH 书名`，并再次确认浏览器弹窗。即使绕过前端，服务端仍会校验相同确认文字。
