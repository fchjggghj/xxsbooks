# XXSBooks 模块与隔离规则

## 模块边界

- 阶段配置：`config-chai.json` 与 `config-xie.json`，只保存该阶段的GPT、提示词、超时和目录规则。
- 书籍配置：`config/books/*.json`，每本书单独控制启用状态和 chai/xie 章节范围。`bookCatalogMode=explicit` 时，未配置的新书不会自动进入任务。
- 任务状态：`书籍/.state/chai/` 与 `书籍/.state/xie/` 分阶段保存；任务ID始终带书名，单书运行不会覆盖其他书状态。
- 会话注册：每个阶段内，一个 ChatGPT `/c/` 地址只能归属一本书；chai/xie 状态文件本身也完全分离。发送前检查归属，地址冲突立即停止。
- 标题规则：xie 从同章 `原文` 首行读取标题；提示词注入一次，回复落盘时再校正一次。
- 文本提取：只读取回答中的 Markdown 正文，保留段落换行，不抓“编辑”等界面控件。
- 维护脚本：放在 `scripts/`；预览和应用明确分开，默认不写文件。
- 队列配置：`lib/queue/config.mjs` 独立负责参数、默认值、路径规范化和配置约束；`gpts-queue.mjs` 只编排任务与浏览器执行。
- 控制器状态：`lib/control/status.mjs` 独立负责进程、锁、CDP 和阶段摘要；`control.mjs` 负责命令路由和写操作。
- 番茄作品配置：书籍配置保存可迁移的 `accountRef`、作品 ID、排期和质量规则；`config/local/fanqie-accounts.json` 保存本机 Profile 与 CDP 端口且不入库。
- 番茄执行：`fanqie-service` 组合配置、远端核对、状态日志和浏览器适配；逐章状态写入 `书籍/.state/fanqie/<作品ID>/`，页面失败留下可审计证据。
- 本地控制台：番茄本地状态可以安全加载；远端访问只由用户点击触发，apply 同时受确认短语、服务端校验和发布锁保护。
- 月度投放：`campaign-control.mjs` 在现有队列之上维护 6 条投放线、三轮周期、账号占用、素材来源、章节目标、成绩与续写/淘汰历史；状态位于 `书籍/.state/campaign/`。
- 安全推进：`campaign tick` 只在全局队列锁和番茄发布锁空闲时选择下一阶段；作品绑定、成绩与决策仍是明确门禁。

## 推荐操作

单独处理一本书：

```powershell
node control.mjs start chai --book "书名"
node control.mjs status --json
node control.mjs start xie --book "书名"
```

同一命令可以重复传入 `--book` 选择多本书。未选择书籍的任务和会话映射保持不变。

新增书籍先预览配置，再应用：

```powershell
node scripts/create-book-config.mjs "新书名" --chapters 60
node scripts/create-book-config.mjs "新书名" --chapters 60 --apply
```

恢复或核对原始标题：

```powershell
npm run titles:preview
npm run titles:apply
```

`force`、重置状态和重新发送均属于一次性操作，不写入公共阶段配置。历史书籍的跳过、重启和新会话指令也不得长期留在配置中。
