# 每月三轮、六书投放流水线

项目使用 6 条长期投放线，而不是每月永久创建 18 个互不回收的账号绑定。每条线固定占用一个本机番茄账号；每 10 天评估一次：成绩好的书继续扩写下一段 60 章，成绩不达标的书退役并在同一条线补入素材库新书。这样账号隔离始终成立，也不会在几个月后耗尽 20 个账号。

默认周期为每月 1 日、11 日、21 日启动；下一周期开始日就是本周期成绩决策日。第 3 轮在次月 1 日评估。

## 生命周期

```text
素材库整本 TXT
  -> 自动识别“第N章”，生成首轮 60 个 原文 文件
  -> 拆改编（内部阶段名 chai，同一本书复用独立 GPTS 对话）
  -> 写（内部阶段名 xie，同一本书复用独立 GPTS 对话）
  -> 绑定该投放线的本地番茄账号与作品 ID
  -> 质量/标题/排期/远端作品核对
  -> 顺序发布并逐章确认
  -> 观察成绩
  -> continue：同书目标 60 -> 120 -> 180 ...
     replace：停用旧书 -> 从素材库补新书 -> 首轮重新从 60 章开始
```

`config/campaign.json` 保存可提交的周期、章节增量和成绩策略。运行状态保存在 Git 忽略的 `书籍/.state/campaign/state.json`。

## 当前 6 本登记

首次运行：

```powershell
node control.mjs campaign bootstrap           # 预览
node control.mjs campaign bootstrap --apply   # 登记当前 6 本和账号
node control.mjs campaign status --json
```

初始化优先保留已有番茄绑定，再从存在本机浏览器数据的账号池分配空闲账号。账号只是在投放状态中预留；新作品仍需拿到真实番茄作品 ID 后再写入书籍绑定，系统不会从浏览器标签页猜作品。

## 自动推进

```powershell
node control.mjs campaign tick                 # 只预览安全下一步
node control.mjs campaign tick --apply         # 可自动启动拆改编或写；遇到发布只提示
node control.mjs campaign tick --apply --publish  # 下一步是发布时允许正式调用番茄发布器
```

`tick` 每次只推进一个安全阶段：队列或发布锁被占用时等待；先完成所有待拆改编书，再启动待写书；作品未绑定、成绩未录入、需要决策或发布状态不确定时停止。正式发布仍复用番茄模块的作品身份、标题、质量、排期、锁和逐章确认门禁。

可以用 Windows 任务计划程序定期调用 `campaign tick --apply`。建议先不带 `--publish` 连续运行，等 6 本作品绑定和发布排期全部验证后，再决定是否让定时任务携带 `--publish`。

## 记录成绩与决策

当前默认是人工决策模式，因为有效读者、读完率、追更或收益的合格线尚未确定：

```powershell
node control.mjs campaign metrics --lane 1 --readers 1200 --read-through-rate 32.5 --followers 80 --revenue-cny 120 --note "7月第2轮" --apply
node control.mjs campaign decide --lane 1 --decision continue --reason "有效读者和读完率达标" --apply
node control.mjs campaign decide --lane 2 --decision replace --reason "观察期读完率未达标" --apply
```

观察期未结束会拒绝决策；确有必要时必须显式加 `--override`，决策原因和当期成绩会进入该投放线历史。

如需自动推荐，把 `config/campaign.json` 的 `performance.mode` 改为 `threshold`，填写非空阈值和 `minimumPasses`。在没有业务阈值时保持 `manual`，避免系统擅自淘汰潜力书。

## 淘汰后从素材库补书

先搜索素材，再预览入线：

```powershell
node control.mjs material search --query "快穿 反派" --limit 20
node control.mjs campaign enroll --lane 2 --source main --file "S/0017_小说名【女】71万.txt" --book "改编后的新书名"
node control.mjs campaign enroll --lane 2 --source main --file "S/0017_小说名【女】71万.txt" --book "改编后的新书名" --apply
```

入线会检查素材至少有 60 章，保存来源路径和 SHA-256，创建 `原文/拆分/正文` 目录与独立书籍配置。不会覆盖已有书名。

## 本地面板

运行 `npm run ui`，打开“月度投放”页，可查看 6 条线的章节完成度、账号、周期、番茄确认数和下一步，也可以录入成绩、做续写/淘汰决策、从素材库补书和执行安全下一步。

目前成绩数据由面板或命令录入。番茄后台成绩抓取需要先用真实账号页面校准统计字段和页面契约；在契约未确认前不把页面猜测接入自动淘汰。
