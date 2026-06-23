# Novel Pipeline

小说流水线系统：下载 → 拆大纲 → 改编 → 写正文

一个基于 AI 的小说二次创作自动化流水线，支持从原始小说下载到正文生成的完整工作流。

## 功能特性

### 核心工作流

1. **书库管理** - 导入和管理多本原始小说
2. **大纲拆解** - 将小说章节拆分为结构化大纲，包含关键事件、因果关系、人物行为
3. **改编方向** - 为每个剧情世界生成改编方向，包含核心冲突、人物设定、基调等
4. **大纲改编** - 根据改编方向对原始大纲进行二次创作
5. **大纲池** - 汇聚所有改编大纲，按主题分类
6. **新书组稿** - 将大纲池中的内容按相似主题组合成新书
7. **正文生成** - 根据改编大纲生成完整的小说正文

### 技术特点

- **双 AI 引擎支持** - 支持 ChatGPT (通过 CDP 自动化) 和 DeepSeek API
- **会话持久化** - 对话 URL 自动保存，重启后恢复上下文
- **智能重试机制** - 失败章节自动重试，第 2 次起等待 5 分钟
- **批次处理** - 剧情世界按 10 章一批不重叠切分
- **质量控制** - 包含写作底线、人味硬约束、GPT 指纹禁令

## 技术栈

| 层级 | 技术 |
|------|------|
| 语言 | TypeScript |
| 前端 | React + Vite + Tailwind CSS v4 |
| 后端 | Node.js + Koa |
| 包管理 | pnpm workspace |
| 测试 | Vitest |
| AI 驱动 | ChatGPT (CDP) + DeepSeek API |

## 项目结构

```
novel-pipeline/
├── packages/
│   ├── shared/          # 共享工具和类型定义
│   ├── runners/         # 核心 Runner（拆大纲/改编/正文生成）
│   ├── server/          # API 服务端
│   ├── web/             # 前端界面
│   └── orchestrator/    # 流水线编排器
├── data/                # 数据目录
│   ├── library/         # 原始小说库
│   ├── 01_5_directions/ # 改编方向
│   ├── 02_5_pool/       # 大纲池
│   └── 03_composed/     # 组稿新书
└── coverage/            # 测试覆盖率报告
```

## 安装

```bash
# 安装依赖
pnpm install

# 构建所有包
pnpm build
```

## 快速开始

### 启动服务

```bash
# 启动后端服务
pnpm start:server

# 访问前端页面
# http://localhost:8787
```

### 开发模式

```bash
# 同时启动前端和后端开发服务器
pnpm dev:all

# 或分别启动
pnpm dev                    # 前端
pnpm dev:server             # 后端
```

## 使用说明

### 流水线命令

```bash
# 运行完整流水线
pnpm pipeline

# 仅拆大纲
pnpm outline

# 仅改编大纲
pnpm adapt

# 仅生成正文
pnpm generate

# 查看状态
pnpm status

# 试运行模式（不实际调用 AI）
pnpm pipeline:dry
pnpm outline:dry
pnpm adapt:dry
pnpm generate:dry
```

### 开发命令

```bash
# 类型检查
pnpm typecheck

# 代码检查
pnpm lint

# 格式化代码
pnpm format

# 运行测试
pnpm test
pnpm test:run
```

## API 接口

| 接口 | 方法 | 描述 |
|------|------|------|
| `/api/health` | GET | 健康检查 |
| `/api/library` | GET/POST | 书库管理 |
| `/api/directions` | GET | 改编方向列表 |
| `/api/pool` | GET | 大纲池 |
| `/api/books/new` | GET | 组稿新书列表 |
| `/api/chrome` | GET/POST | Chrome 控制 |
| `/api/queue` | GET | 任务队列 |
| `/api/logs` | GET | 日志查询 |

## 配置

配置文件位于各 package 的 `config.json`，主要配置项：

- `cdpUrl`: Chrome DevTools Protocol 地址
- `gptUrl`: ChatGPT 页面地址
- `pipelineRoot`: 流水线数据根目录
- `maxChapters`: 最大处理章节数
- `concurrency`: 并发数
- `aiProvider`: AI 提供商 (`chatgpt` 或 `deepseek`)

### Chrome 启动参数

```
chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\chrome-automation
```

## 预置数据

项目包含以下预置数据用于测试：

- **3 本原始小说** - 位于 `data/library/`
- **16 个改编方向** - 位于 `data/01_5_directions/`
- **大纲池** - 位于 `data/02_5_pool/`
- **3 本组稿新书** - 位于 `data/03_composed/`

## 开发规范

- 代码使用 TypeScript 严格模式
- 测试文件命名为 `[module].test.ts`，与源文件同目录
- 日志使用彩色输出
- 文件操作使用原子写入（先写 tmp，再 rename）

## 许可证

MIT License
