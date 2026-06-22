# novel_pipeline

> 架构升级（2026-06-21）：全部代码已从 .mjs 迁移到 TypeScript（严格模式）。
> 采用 pnpm workspace monorepo 结构，5 个包全部通过 typecheck/build/lint/test。
> 旧 .mjs 文件保留在 `scripts/` 下作为参考，不再使用。

小说四步流水线：**下载 → 拆大纲 → 改编 → 写正文**。

---

## 架构

```
novel_pipeline/
├── packages/
│   ├── shared/        # 共享类型、工具、ChatGPT 连接（playwright-core CDP）
│   ├── web/           # React 19 + Vite 6 + Tailwind v4 + shadcn/ui 前端
│   ├── server/        # Node.js 内置模块零依赖后端 API（http/fs/path/crypto）
│   ├── runners/       # 拆大纲 + 改编大纲执行器
│   └── orchestrator/  # 全流程编排器
├── 程序/
│   ├── scripts/       # 配置、日志、守护脚本、旧 .mjs 参考
│   ├── docs/          # 文档
│   └── legacy/        # 旧素材备份
├── data/              # 小说数据与成品
├── package.json       # monorepo 根配置
├── tsconfig.json      # 严格模式 TS 配置
├── eslint.config.mjs  # ESLint 9 flat config
├── vitest.config.ts   # Vitest 2 测试配置
├── 一键启动.cmd        # 傻瓜化入口
├── 开始.cmd           # 快速入口
└── 说明书.txt         # 用户说明书
```

## 快速开始

```bash
# 安装依赖
pnpm install

# 构建全部包
pnpm build

# 拆大纲（dry-run 只看计划）
pnpm outline:dry
pnpm outline

# 改编大纲
pnpm adapt:dry
pnpm adapt

# 全流程编排
pnpm pipeline:dry
pnpm pipeline

# 看进度
pnpm status

# 启动 Web UI（开发模式，前后端热更新）
pnpm dev:all

# 启动后端服务（生产模式）
pnpm start:server
# 打开 http://localhost:8787
```

## 开发命令

```bash
pnpm typecheck      # 全部包类型检查
pnpm lint           # ESLint 检查
pnpm lint:fix       # ESLint 自动修复
pnpm format         # Prettier 格式化
pnpm format:check   # Prettier 检查
pnpm test:run       # Vitest 单元测试
pnpm clean          # 清理 dist 和缓存
```

## 核心特性

### 拆大纲（outline-runner）
- 扫描素材库，按选择规则过滤（每本前 N 章，按弧边界）
- 配置热更新：每批前 `refreshLive()` 读最新 config.json
- 工作池：N 个 worker 各占一个标签页
- 批量发送：`chaptersPerRequest=5`，用 `=====CHAPTER-k=====` 标记
- `splitBatch`：按标记切回 N 段，标记数≠N 整批作废重发
- 逐章兜底 `sendSingle`
- 运行锁 `.run.lock` + 智能暂停（连续失败 N 次）
- 支持 `--dry-run` 参数

### 改编大纲（adapt-runner）
- 重叠批次策略：首批 6 章保留 5 章，后续 7 章保留 5 章（重叠上下文）
- 最后一批自动保留全部章节（避免末尾丢失）
- 对话 URL 持久化：`.conversation_url` 文件
- 原子文件写入：tmp + rename 模式
- 支持 `--dry-run` 参数

### 编排器（orchestrator）
- 按 `pipelineStages` 配置顺序执行各阶段
- 阶段门：解析 `__PENDING__` 标记，0 待处理才进入下一阶段
- 支持 `--dry-run` 跳过实际运行

### 后端服务（server）
- Node.js 内置模块零依赖（http/fs/path/crypto/child_process）
- API 端点：`/api/state`、`/api/scan`、`/api/config`、`/api/control`、`/api/logs`、`/api/queue`
- 静态文件服务 `packages/web/dist`
- 通过 CDP 连接已登录的 Chrome（playwright-core）

### 前端（web）
- React 19 + Vite 6 + Tailwind v4 beta + shadcn/ui
- TanStack Query 5 数据获取 + zustand 5 状态管理
- recharts 2 图表
- 页面：Dashboard、Books、Queue、Logs、Config

## 配置

配置文件：`程序/scripts/gpt-outline-runner/config.json`

关键字段：
- `libraryRoot`：素材库根目录
- `gptUrl`：拆大纲 GPT 入口 URL
- `concurrency`：并发标签页数
- `chaptersPerRequest`：每请求章数（批量发送）
- `pipelineStages`：流水线阶段配置
- `adaptGptUrl`：改编 GPT 入口 URL
- `overlapBatchSize`/`overlapBatchSizeNext`/`overlapKeepCount`：重叠批次参数

## 守护脚本

```powershell
# 启动守护（PowerShell）
powershell -ExecutionPolicy Bypass -File 程序\scripts\run-pipeline-forever.ps1

# 或用 Windows 计划任务
Start-ScheduledTask -TaskName GptOutlineRunner
Stop-ScheduledTask -TaskName GptOutlineRunner

# 优雅停止：在 程序\scripts\gpt-outline-runner\ 下创建 STOP 空文件
```

## 执行端入口（自定义 GPT）

1. 拆大纲：https://chatgpt.com/g/g-6a008fa0c5208191baf690ede768a20c-chai-da-gang
2. 改编：https://chatgpt.com/g/g-6a31e876bd7c8191a99c41e4d53b3395-gai
3. 正文：https://chatgpt.com/g/g-69fcd66363e08191b7089e3f1d124aab-zheng-wen

## 目录结构（数据）

`data/00_raw_chapters/<小说名>/`：
- `章节/`（.txt）—— 输入源
- `拆大纲/`（.md）—— 拆大纲输出

顶层扁平目录：
- `data/01_broken_outlines/` —— 拆大纲成品快照
- `data/02_adapted/` —— 改编大纲输出
- `data/03_final_text/` —— 正文输出

## 旧代码参考

`程序/scripts/` 下的 `.mjs` 文件是迁移前的原始 JavaScript 实现，保留作为参考：
- `gpt-outline-runner/run.mjs` → `packages/runners/src/outline-runner.ts`
- `gpt-adapt-runner/run.mjs` → `packages/runners/src/adapt-runner.ts`
- `pipeline.mjs` → `packages/orchestrator/src/index.ts`
- `status.mjs` → `packages/orchestrator/src/status.ts`
- `gpt-outline-runner/server.mjs` → `packages/server/src/`

**不要再使用这些 .mjs 文件**，所有功能已迁移到 TypeScript。
