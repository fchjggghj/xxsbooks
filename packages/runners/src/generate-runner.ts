/**
 * 生成正文主流程（TypeScript 版）
 *
 * 把改编后的大纲（02_adapted）逐章生成为正文（03_final_text）。
 *
 * 核心功能：
 * - 逐章生成：每章单独发送，不做剧情线分组、不做批量发送
 * - 同一本小说在同一个对话里：保持上下文连贯
 * - 失败时用编辑重试：第一次发新消息（sendAndConfirm），重试时编辑上一条消息（editLastUserMessage）
 * - 失败后开新对话重试：sendSingle 重试耗尽后，开新对话再试一次
 * - 对话URL持久化：saveConversationUrl/readConversationUrl/deleteConversationUrl
 * - 原子写入 writeOutput（先写 tmp，再 rename）
 * - 运行锁 .run.lock
 * - 支持 --dry-run 参数
 * - 打印 __PENDING__=N 标记
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright-core';
import {
  // 类型
  type AdaptConfig,
  type OutlineItem,
  type Novel,
  // 工具
  log,
  errorMessage,
  isBrowserClosedError,
  sleep,
  isRefusal,
  isUsable,
  // 配置
  loadConfig as loadConfigFile,
  getConfigPath,
  // chatgpt
  getPages,
  newConversation,
  sendAndCollect,
  editLastUserMessage,
  hitRateLimit,
  inspectPageState,
  getLastAssistantText,
  deleteCurrentConversation,
  // 文件
  saveConversationUrl,
  readConversationUrl,
  deleteConversationUrl,
} from '@novel-pipeline/shared';
import { createFileLogger, acquireLock, releaseLock, isStopRequested } from './runner-core.js';
import type { RunResult } from './outline-runner.js';

// ---------- 路径常量 ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

/** 生成正文配置（复用 AdaptConfig） */
type GenerateConfig = AdaptConfig;

// ---------- 配置加载 ----------
function loadConfig(): GenerateConfig {
  const cfgPath = getConfigPath('generate', PROJECT_ROOT);
  return loadConfigFile<GenerateConfig>(cfgPath);
}

// ---------- 文件操作 ----------

const MIN_DONE_BYTES = 800;

/** 列出要处理的小说文件夹。novelsFilter 为空数组时＝全部。 */
function listNovels(inputRoot: string, novelsFilter: string[]): Novel[] {
  if (!fs.existsSync(inputRoot)) {
    throw new Error(`输入根目录不存在: ${inputRoot}`);
  }
  let names: string[];
  if (Array.isArray(novelsFilter) && novelsFilter.length) {
    names = novelsFilter.slice();
  } else {
    names = fs
      .readdirSync(inputRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }
  const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  names.sort(collator.compare);
  return names
    .map((name) => ({
      name,
      path: path.join(inputRoot, name),
      totalChapters: 0,
      selectedChapters: 0,
      doneChapters: 0,
      failedChapters: 0,
      pendingChapters: 0,
    }))
    .filter((n) => fs.existsSync(n.path));
}

/** 列出某本小说输入目录里的大纲文件，自然排序。 */
function listOutlines(novel: Novel, cfg: GenerateConfig): OutlineItem[] {
  if (!fs.existsSync(novel.path)) return [];
  const ext = (cfg.inputExt || '.md').toLowerCase();
  const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  const files = fs
    .readdirSync(novel.path, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .filter((name) => name.toLowerCase().endsWith(ext));
  files.sort(collator.compare);
  return files.map((name) => {
    const base = name.replace(/\.[^.]+$/, '');
    return {
      name,
      base,
      inputPath: path.join(novel.path, name),
      outputPath: path.join(cfg.outputRoot, novel.name, base + (cfg.outputExt || '.md')),
      novel,
    };
  });
}

/** 断点：输出文件已存在且 ≥800B ＝ 已处理过，跳过。 */
function isDone(outline: OutlineItem): boolean {
  try {
    const st = fs.statSync(outline.outputPath);
    return st.isFile() && st.size >= MIN_DONE_BYTES;
  } catch {
    return false;
  }
}

function readOutline(outline: OutlineItem): string {
  return fs.readFileSync(outline.inputPath, 'utf8');
}

/** 读取参考原文的前 N 字作为基调（找不到则返回空字符串） */
function readRawOpening(outline: OutlineItem, cfg: GenerateConfig, maxChars = 200): string {
  if (!cfg.rawRoot) return '';
  // 参考原文路径：rawRoot/{小说名}/章节/{base}.txt
  const candidates = [
    path.join(cfg.rawRoot, outline.novel.name, '章节', outline.base + '.txt'),
    path.join(cfg.rawRoot, outline.novel.name, outline.base + '.txt'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const text = fs.readFileSync(p, 'utf8').trim();
        return text.slice(0, maxChars);
      }
    } catch {
      /* 忽略 */
    }
  }
  return '';
}

/** 原子写入输出文件（先写临时文件，再 rename，避免崩溃时丢失数据）。 */
function writeOutput(outline: OutlineItem, text: string): boolean {
  const dir = path.dirname(outline.outputPath);
  fs.mkdirSync(dir, { recursive: true });

  if (isDone(outline)) return false;

  const tmpPath = outline.outputPath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, text, { encoding: 'utf8' });
    fs.renameSync(tmpPath, outline.outputPath);
    return true;
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* 忽略清理失败 */
    }
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return false;
    throw err;
  }
}

// ---------- 构建处理计划 ----------

interface GeneratePlanEntry {
  novel: Novel;
  outlines: OutlineItem[];
  pending: OutlineItem[];
}

interface GeneratePlan {
  plan: GeneratePlanEntry[];
  totalNovels: number;
  totalOutlines: number;
  pendingOutlines: number;
}

function buildPlan(cfg: GenerateConfig): GeneratePlan {
  const novels = listNovels(cfg.inputRoot, cfg.novels);
  const plan: GeneratePlanEntry[] = [];
  let totalOutlines = 0;
  let pendingOutlines = 0;

  for (const novel of novels) {
    const outlines = listOutlines(novel, cfg);
    const pending = outlines.filter((o) => !isDone(o));
    totalOutlines += outlines.length;
    pendingOutlines += pending.length;
    plan.push({ novel, outlines, pending });
  }

  return {
    plan,
    totalNovels: novels.length,
    totalOutlines,
    pendingOutlines,
  };
}

// ---------- 增强版发送：记录发送前 assistant 数量，确认回复到达 ----------

interface ConfirmResult {
  text: string;
  timedOut: boolean;
  conversationUrl: string | null;
}

async function sendAndConfirm(
  page: Page,
  prompt: string,
  cfg: GenerateConfig,
): Promise<ConfirmResult> {
  // 发送前：记录当前 assistant 消息数
  const beforeState = await inspectPageState(page);
  const beforeCount = beforeState.assistantCount || 0;
  const beforeUrl = page.url();

  // 发送并等待回复
  const result = await sendAndCollect(page, prompt, cfg);

  // 额外确认：assistant 消息数必须增加了
  const afterState = await inspectPageState(page);
  const afterCount = afterState.assistantCount || 0;

  let text = result.text;

  if (afterCount <= beforeCount) {
    // 消息数没增加，可能仍在生成中或页面没刷新，最多等 5 分钟
    log(`  确认回复：assistant数 ${beforeCount}→${afterCount}，等待确认…`);
    for (let i = 0; i < 150; i++) {
      await sleep(2000);
      const checkState = await inspectPageState(page);
      if ((checkState.assistantCount || 0) > beforeCount) {
        log(`  确认回复：assistant数增至 ${checkState.assistantCount}`);
        break;
      }
      if (checkState.generating) {
        if (i % 15 === 0) log(`  仍在生成中…`);
        continue;
      }
    }
    // 最终读取
    const finalText = await getLastAssistantText(page);
    if (finalText && finalText.length > (text || '').length) {
      text = finalText;
    }
  }

  // 捕获对话 URL（发送第一条消息后 URL 会变成对话链接）
  const afterUrl = page.url();
  const conversationUrl = afterUrl !== beforeUrl && /\/c\//.test(afterUrl) ? afterUrl : null;

  return { text, timedOut: result.timedOut, conversationUrl };
}

// ---------- 主流程 ----------

async function run(cfg: GenerateConfig, dryRun: boolean): Promise<RunResult> {
  // 文件日志：同时输出到控制台和 gpt-generate-runner/run.log（兼容后端 parseRunLine）
  const log = createFileLogger('generate');

  const { plan, totalNovels, totalOutlines, pendingOutlines } = buildPlan(cfg);

  console.log('__PENDING__=' + pendingOutlines);

  console.log('==================== 生成正文处理计划 ====================');
  console.log(`输入目录    : ${cfg.inputRoot}`);
  console.log(`输出目录    : ${cfg.outputRoot}`);
  console.log(`正文 GPT    : ${cfg.gptUrl}`);
  console.log(
    `小说范围    : ${cfg.novels && cfg.novels.length ? cfg.novels.length + ' 本（指定）' : '全库'}`,
  );
  console.log(`小说总数    : ${totalNovels}`);
  console.log(`全部大纲    : ${totalOutlines}`);
  console.log(`待处理      : ${pendingOutlines}（已有输出的自动跳过）`);
  console.log(`提示词前缀  : ${cfg.promptPrefix}`);
  console.log('----------------------------------------------------------');
  for (const { novel, outlines, pending } of plan.slice(0, 10)) {
    console.log(`  ${novel.name}`);
    console.log(`     共${outlines.length}章大纲 → 待处理${pending.length}`);
    if (pending[0]) console.log(`     首个待处理: ${pending[0].name}`);
  }
  if (plan.length > 10) console.log(`  …（其余 ${plan.length - 10} 本省略）`);
  console.log('==========================================================');

  if (dryRun) {
    console.log('\n[dry-run] 仅规划，未开浏览器、未写任何文件。');
    return {
      pending: pendingOutlines,
      total: totalOutlines,
      novels: totalNovels,
      done: 0,
      failed: 0,
    };
  }

  if (!cfg.gptUrl || cfg.gptUrl.includes('在这里填')) {
    throw new Error('请先在 config.json 填入正文 GPT 链接 gptUrl');
  }
  if (!pendingOutlines) {
    log('没有待处理大纲，全部已完成。');
    return { pending: 0, total: totalOutlines, novels: totalNovels, done: 0, failed: 0 };
  }

  // 获取运行锁（防止重复运行）
  const lock = acquireLock('generate');

  try {
    log('连接 Chrome（CDP），准备 1 个标签页…');
    const { pages } = await getPages(cfg, 1);
    let page = pages[0];
    log('已就绪');

    const limit = Number(cfg.maxChapters) > 0 ? Number(cfg.maxChapters) : Infinity;
    if (limit !== Infinity) {
      log(`本次最多处理 ${limit} 章（maxChapters，试跑用；设 0 = 不限）`);
    }

    const prefix = cfg.promptPrefix || '';
    const minChars = Number(cfg.minOutputChars ?? 300);
    const usable = (s: string) => isUsable(s, minChars);

    let done = 0;
    let failed = 0;
    let attempted = 0;

    // 重连浏览器，回到指定对话
    async function reconnectBrowser(conversationUrl: string | null): Promise<Page> {
      log('⚠ 尝试重连浏览器…');
      const result = await getPages(cfg, 1);
      page = result.pages[0];
      if (conversationUrl) {
        log(`  回到对话: ${conversationUrl}`);
        await page.goto(conversationUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(2000);
        await page
          .waitForSelector(
            '#prompt-textarea, textarea[name="prompt-textarea"], [data-testid="composer-input"]',
            { timeout: 30000 },
          )
          .catch(() => {});
        await sleep(1000);
      } else {
        await newConversation(page, cfg);
      }
      log('✓ 重连成功');
      return page;
    }

    // 单章发送（第一次发新消息，重试编辑上一条消息）
    async function sendSingle(outline: OutlineItem): Promise<'done' | 'failed' | 'policy_refusal'> {
      const outlineText = readOutline(outline);
      const rawOpening = readRawOpening(outline, cfg);
      // 提示词 = 前缀 + 参考原文开头（基调） + 改编大纲
      const prompt = rawOpening
        ? `${prefix}\n\n【参考原文开头（基调）】\n${rawOpening}\n\n【改编大纲】\n${outlineText}`
        : prefix
          ? `${prefix}\n\n${outlineText}`
          : outlineText;
      const maxStuck = Number(cfg.stuckRetries ?? 3);

      for (let attempt = 1; attempt <= maxStuck; attempt++) {
        if (attempt > 1) {
          log(`↻ ${outline.name}: 重试 ${attempt}/${maxStuck}（编辑上一条消息）…`);
        }

        let text: string;
        let timedOut: boolean;
        try {
          if (attempt === 1) {
            // 第一次：发新消息
            const r = await sendAndConfirm(page, prompt, cfg);
            text = r.text;
            timedOut = r.timedOut;
          } else {
            // 重试：编辑上一条用户消息（不增加对话长度，避免对话越来越长导致超时）
            try {
              const r = await editLastUserMessage(page, prompt, cfg);
              text = r.text;
              timedOut = r.timedOut;
            } catch (editErr) {
              // 编辑失败（如找不到用户消息），退回发新消息
              log(`  编辑失败，改用发新消息: ${errorMessage(editErr)}`);
              const r = await sendAndConfirm(page, prompt, cfg);
              text = r.text;
              timedOut = r.timedOut;
            }
          }
        } catch (err) {
          if (isBrowserClosedError(err)) throw err;
          log(`✗ ${outline.name}: 发送失败 - ${errorMessage(err)}`);
          continue;
        }

        if (isRefusal(text)) {
          log(`✗ ${outline.name}: 被内容政策拒绝`);
          failed++;
          return 'policy_refusal';
        }

        if (usable(text)) {
          if (writeOutput(outline, text)) {
            done++;
            log(`✓ ${outline.name} -> ${path.basename(outline.outputPath)}（${text.length} 字）`);
          }
          return 'done';
        }

        // 配额墙？
        if (await hitRateLimit(page)) {
          const waitMs =
            Number(cfg.rateLimitWaitMs) > 0 ? Number(cfg.rateLimitWaitMs) : 30 * 60 * 1000;
          log(`⚠ 撞配额墙，暂停 ${Math.ceil(waitMs / 60000)} 分钟…`);
          await sleep(waitMs);
          attempt--;
          continue;
        }
        // 文本不可用但没撞配额墙
        if (timedOut) {
          log(`↻ ${outline.name}: 超时（30分钟兜底），重试…`);
        } else {
          log(`↻ ${outline.name}: 回复不可用，重试…`);
        }
      }

      log(`✗ ${outline.name}: 重试耗尽`);
      failed++;
      return 'failed';
    }

    // 逐本处理
    for (const { novel, pending } of plan) {
      if (attempted >= limit) break;
      if (!pending.length) continue;

      log(`开始小说: ${novel.name}（待处理 ${pending.length} 章）`);

      // 恢复或开新对话
      let conversationUrl = readConversationUrl(cfg.outputRoot, novel.name);
      if (conversationUrl) {
        log(`  恢复对话: ${conversationUrl}`);
        try {
          await page.goto(conversationUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
          });
          await sleep(2000);
          await page
            .waitForSelector(
              '#prompt-textarea, textarea[name="prompt-textarea"], [data-testid="composer-input"]',
              { timeout: 30000 },
            )
            .catch(() => {});
          await sleep(1000);
          // 验证对话ID匹配
          if (!/\/c\//.test(page.url())) {
            log(`  恢复失败（URL不匹配），开新对话`);
            await newConversation(page, cfg);
            conversationUrl = null;
          }
        } catch (err) {
          log(`  恢复出错: ${errorMessage(err)}，开新对话`);
          await newConversation(page, cfg);
          conversationUrl = null;
        }
      } else {
        await newConversation(page, cfg);
        log('已开新对话');
      }

      // 逐章处理（严格按顺序，失败不跳过）
      let consecutiveFailures = 0;
      const maxConsecutiveFailures = Number(cfg.maxConsecutiveFailures ?? 3);
      const failurePauseMs = Number(cfg.failurePauseMs ?? 5 * 60 * 1000);

      for (const outline of pending) {
        if (attempted >= limit) break;
        if (isStopRequested('generate')) {
          log('检测到 STOP 标记，优雅退出');
          return {
            pending: pendingOutlines - done,
            total: totalOutlines,
            novels: totalNovels,
            done,
            failed,
          };
        }
        if (isDone(outline)) continue;

        try {
          let r = await sendSingle(outline);
          attempted++;

          // 失败后持续重试该章（不跳过，因为小说有剧情顺序）
          while (r === 'failed') {
            consecutiveFailures++;
            if (consecutiveFailures >= maxConsecutiveFailures) {
              log(`✗ ${outline.name}: 连续 ${consecutiveFailures} 次失败，停止整个流程`);
              return {
                pending: pendingOutlines - done,
                total: totalOutlines,
                novels: totalNovels,
                done,
                failed,
              };
            }
            log(`  ⚠ ${outline.name}: 失败（第 ${consecutiveFailures}/${maxConsecutiveFailures} 次），开新对话重试…`);
            await newConversation(page, cfg);
            // 等待一段时间再重试
            if (consecutiveFailures > 1) {
              log(`  暂停 ${Math.ceil(failurePauseMs / 60000)} 分钟后重试…`);
              await sleep(failurePauseMs);
            }
            r = await sendSingle(outline);
          }

          // 成功后重置连续失败计数
          if (r === 'done') {
            consecutiveFailures = 0;
          }

          // 捕获对话URL（发送第一条消息后 URL 会变成对话链接）
          const curUrl = page.url();
          if (/\/c\//.test(curUrl) && curUrl !== conversationUrl) {
            conversationUrl = curUrl;
            saveConversationUrl(cfg.outputRoot, novel.name, conversationUrl);
            log(`  对话URL: ${conversationUrl}`);
          }

          await sleep(cfg.betweenChaptersMs || 1000);
        } catch (err) {
          if (isBrowserClosedError(err)) {
            try {
              page = await reconnectBrowser(conversationUrl);
              continue;
            } catch (reconnErr) {
              log(`FATAL 重连失败: ${errorMessage(reconnErr)}`);
              throw err;
            }
          }
          log(`  ✗ ${outline.name}: ${errorMessage(err)}`);
          failed++;
          attempted++;
        }
      }

      log(`========== ${novel.name} 本轮结束 ==========`);

      // 完成后清理对话
      if (cfg.deleteConversationAfterDone) {
        try {
          await deleteCurrentConversation(page);
          deleteConversationUrl(cfg.outputRoot, novel.name);
        } catch {
          /* 忽略 */
        }
      }
    }

    log(`全部结束。成功 ${done}，失败 ${failed}。`);
    return {
      pending: pendingOutlines - done,
      total: totalOutlines,
      novels: totalNovels,
      done,
      failed,
    };
  } finally {
    releaseLock(lock);
  }
}

/**
 * 运行生成正文主流程。
 *
 * @param cfg    配置（GenerateConfig = AdaptConfig）
 * @param dryRun 只规划、不开浏览器
 */
export async function runGenerate(cfg: GenerateConfig, dryRun = false): Promise<RunResult> {
  return await run(cfg, dryRun);
}

// ---------- 直接运行入口 ----------
const DRY = process.argv.includes('--dry-run');

const isMain =
  import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/') ||
  process.argv[1]?.endsWith('generate-runner.ts') ||
  process.argv[1]?.endsWith('generate-runner.js');

if (isMain) {
  const cfg = loadConfig();
  runGenerate(cfg, DRY).catch((err) => {
    console.error('运行出错:', err);
    process.exit(1);
  });
}
