/**
 * 改编大纲主流程（TypeScript 版）
 *
 * 迁移自 程序/scripts/gpt-adapt-runner/run.mjs（500行）。
 *
 * 核心功能：
 * - 重叠批次策略：首批1-6保留1-5，后续从上一批最后一章开始取7章保留5章
 * - 同一本小说所有批次在同一对话
 * - 对话URL持久化到 .conversation_url 文件
 * - sendAndConfirm：记录发送前 assistant 数量，确认回复到达
 * - reconnectBrowser：浏览器关闭后重连 + 回到对话URL + 重试当前批次（用索引循环 bi--）
 * - buildBatches：正确的重叠推进 i += keepIndices[last]
 * - 对话URL恢复验证：恢复后验证对话ID，不匹配则开新对话
 * - 原子写入 writeOutput
 * - 参数校验
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
  boundedMs,
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
} from '@novel-pipeline/shared';
import { buildBatchPrompt, splitBatch } from './batch-utils.js';
import { createFileLogger, acquireLock, releaseLock } from './runner-core.js';
import type { RunResult } from './outline-runner.js';

// ---------- 路径常量 ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

// ---------- 配置加载 ----------
function loadConfig(): AdaptConfig {
  const cfgPath = getConfigPath('adapt', PROJECT_ROOT);
  return loadConfigFile<AdaptConfig>(cfgPath);
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
function listOutlines(novel: Novel, cfg: AdaptConfig): OutlineItem[] {
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

/**
 * 从章节文件名提取剧情线名称（快穿小说按"世界"分剧情线）。
 *
 * 例如：
 * - "第001章_总裁未婚妻1.md" → "总裁未婚妻"
 * - "第033章_沈云开番外.md" → "沈云开番外"
 * - "第105章_婚后 番外.md" → "婚后 番外"
 * - "第036章_将军未婚妻1.md" → "将军未婚妻"
 * - "第052章_世子未婚妻53(完）.md" → "世子未婚妻"
 */
function extractStoryArc(name: string): string {
  let s = name.replace(/\.md$/, '');
  // 去掉 "第XXX章_" 前缀
  s = s.replace(/^第\d+章_/, '');
  // 去掉末尾的 "（XXX）"/"(XXX)" 后缀（如"（完）"、"（二合一）"等）
  s = s.replace(/[（(][^（(）)]*[）)]\s*$/, '');
  // 去掉末尾的数字
  s = s.replace(/\d+$/, '');
  // 去掉末尾空格
  return s.trim();
}

/** 剧情线分组结果 */
interface StoryArc {
  arc: string;
  items: OutlineItem[];
}

/**
 * 按剧情线分组章节（保持原始顺序）。
 *
 * 同一剧情线的章节分到一组，番外等独立名称各自成组。
 */
function groupByStoryArc(outlines: OutlineItem[]): StoryArc[] {
  const groups: StoryArc[] = [];
  const arcMap = new Map<string, OutlineItem[]>();

  for (const o of outlines) {
    const arc = extractStoryArc(o.name);
    let arr = arcMap.get(arc);
    if (!arr) {
      arr = [];
      arcMap.set(arc, arr);
      groups.push({ arc, items: arr });
    }
    arr.push(o);
  }

  return groups;
}

/**
 * 把剧情线分成子批次（超长剧情线分多批，每批最多 maxBatchSize 章）。
 */
function splitArcIntoBatches(items: OutlineItem[], maxBatchSize: number): OutlineItem[][] {
  const batches: OutlineItem[][] = [];
  for (let i = 0; i < items.length; i += maxBatchSize) {
    batches.push(items.slice(i, i + maxBatchSize));
  }
  return batches;
}

function readOutline(outline: OutlineItem): string {
  return fs.readFileSync(outline.inputPath, 'utf8');
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

// ---------- 对话URL持久化 ----------
// 注意：adapt-runner 使用剧情线分组策略，每个剧情线开新对话，
// 对话URL不需要持久化（由 sendBatchWithKeep 内部捕获并返回）

// ---------- 构建处理计划 ----------

interface AdaptPlanEntry {
  novel: Novel;
  outlines: OutlineItem[];
  pending: OutlineItem[];
}

interface AdaptPlan {
  plan: AdaptPlanEntry[];
  totalNovels: number;
  totalOutlines: number;
  pendingOutlines: number;
}

function buildPlan(cfg: AdaptConfig): AdaptPlan {
  const novels = listNovels(cfg.inputRoot, cfg.novels);
  const plan: AdaptPlanEntry[] = [];
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
  cfg: AdaptConfig,
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

async function run(cfg: AdaptConfig, dryRun: boolean): Promise<RunResult> {
  // 文件日志：同时输出到控制台和 gpt-adapt-runner/run.log（兼容后端 parseRunLine）
  const log = createFileLogger('adapt');

  const { plan, totalNovels, totalOutlines, pendingOutlines } = buildPlan(cfg);

  console.log('__PENDING__=' + pendingOutlines);

  const concurrency = Math.max(1, Number(cfg.concurrency ?? 1));
  const batchSize = 10; // 每个剧情世界每10章一批，不重叠

  console.log('==================== 改编大纲处理计划 ====================');
  console.log(`输入目录    : ${cfg.inputRoot}`);
  console.log(`输出目录    : ${cfg.outputRoot}`);
  console.log(`改编 GPT    : ${cfg.gptUrl}`);
  console.log(
    `小说范围    : ${cfg.novels && cfg.novels.length ? cfg.novels.length + ' 本（指定）' : '全库'}`,
  );
  console.log(`小说总数    : ${totalNovels}`);
  console.log(`全部大纲    : ${totalOutlines}`);
  console.log(`待处理      : ${pendingOutlines}（已有输出的自动跳过）`);
  console.log(`批次策略    : 每个剧情世界每 ${batchSize} 章一批（不重叠）`);
  console.log(`并发标签页  : ${concurrency}`);
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
    throw new Error('请先在 config.json 填入改编 GPT 链接 gptUrl');
  }
  if (!pendingOutlines) {
    log('没有待处理大纲，全部已完成。');
    return { pending: 0, total: totalOutlines, novels: totalNovels, done: 0, failed: 0 };
  }

  // 获取运行锁（防止重复运行）
  const lock = acquireLock('adapt');

  try {
  const workers = Math.min(concurrency, 1);
  log(`连接 Chrome（CDP），准备 ${workers} 个标签页…`);
  const { pages } = await getPages(cfg, workers);
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
      // 等待输入框就绪
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

  // 单章发送（兜底用，在当前对话内发送，不开新对话）
  async function sendSingle(outline: OutlineItem): Promise<'done' | 'failed' | 'policy_refusal'> {
    const prompt = prefix ? `${prefix}\n\n${readOutline(outline)}` : readOutline(outline);
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
        const waitMs = boundedMs(cfg.rateLimitWaitMs, 30 * 60 * 1000);
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

  // 批量发送（在当前对话内发送，不开新对话）
  async function sendBatchWithKeep(toSend: OutlineItem[], keepIndices: number[]): Promise<boolean> {
    const prompt = buildBatchPrompt(toSend, readOutline, prefix);
    const maxStuck = Number(cfg.stuckRetries ?? 3);

    for (let attempt = 1; attempt <= maxStuck; attempt++) {
      let text: string;
      try {
        const r = await sendAndConfirm(page, prompt, cfg);
        text = r.text;
      } catch (err) {
        if (isBrowserClosedError(err)) throw err;
        log(`↻ 批量发送失败: ${errorMessage(err)}`);
        continue;
      }

      if (isRefusal(text)) {
        log(`↻ 批量(${toSend.length}章)被政策拒绝，转逐章…`);
        return false;
      }

      const segs = splitBatch(text, toSend.length);
      if (segs && segs.every(usable)) {
        let saved = 0;
        for (const idx of keepIndices) {
          if (idx < 0 || idx >= toSend.length) continue;
          if (writeOutput(toSend[idx], segs[idx])) {
            done++;
            saved++;
          }
        }
        log(`✓ 批量${toSend.length}章完成 -> 保留${saved}章（${segs[keepIndices[0]]?.length || 0} 字）`);
        return true;
      }

      // 配额墙？
      if (await hitRateLimit(page)) {
        const waitMs = boundedMs(cfg.rateLimitWaitMs, 30 * 60 * 1000);
        log(`⚠ 批量撞配额墙，暂停 ${Math.ceil(waitMs / 60000)} 分钟…`);
        await sleep(waitMs);
        attempt--;
        continue;
      }

      log(
        `↻ 批量切分失败（期望${toSend.length}段，实际${segs ? '格式不对' : '未找到标记'}），重试 ${attempt}/${maxStuck}…`,
      );
    }
    return false;
  }

  // 逐本处理
  for (const { novel, pending } of plan) {
    if (attempted >= limit) break;
    if (!pending.length) continue;

    log(`开始小说: ${novel.name}（待处理 ${pending.length} 章）`);

    // 按剧情线分组（快穿小说按"世界"分剧情线）
    const arcs = groupByStoryArc(pending);
    log(`剧情线分组：共 ${arcs.length} 条剧情线`);
    for (const a of arcs) {
      const pendingInArc = a.items.filter((o) => !isDone(o));
      if (pendingInArc.length) {
        log(`  [${a.arc}] ${a.items.length} 章（待处理 ${pendingInArc.length}）`);
      }
    }

    // 每个剧情线开新对话处理
    for (const { arc, items } of arcs) {
      if (attempted >= limit) break;

      // 过滤已完成的章节
      const arcPending = items.filter((o) => !isDone(o));
      if (!arcPending.length) continue;

      log(`----- 剧情线: ${arc}（待处理 ${arcPending.length} 章）-----`);

      // 每个剧情线开新对话
      await newConversation(page, cfg);
      log('已开新对话');
      let conversationUrl: string | null = null;

      // 超长剧情线分子批次（每批最多 batchSize 章）
      const arcBatches = splitArcIntoBatches(arcPending, batchSize);
      log(`子批次：共 ${arcBatches.length} 批（每批最多 ${batchSize} 章）`);

      for (let bi = 0; bi < arcBatches.length; bi++) {
        if (attempted >= limit) break;
        // maxChapters 限制：如果剩余配额不够整个批次，只取前 remaining 章
        const remaining = limit - attempted;
        const batch = remaining < arcBatches[bi].length ? arcBatches[bi].slice(0, remaining) : arcBatches[bi];
        log(`  子批次 ${bi + 1}/${arcBatches.length}：${batch.length} 章`);

        // 尝试批量发送
        const ok = await sendBatchWithKeep(batch, batch.map((_, i) => i));

        // 捕获对话URL
        if (!conversationUrl) {
          const curUrl = page.url();
          if (/\/c\//.test(curUrl)) {
            conversationUrl = curUrl;
            log(`  对话URL: ${conversationUrl}`);
          }
        }

        if (!ok) {
          // 批量失败，回退逐章（重试时用编辑上一条消息）
          log(`  批量不成，回退逐章处理…`);
          for (const o of batch) {
            if (isDone(o)) continue;
            if (attempted >= limit) break;
            try {
              const r = await sendSingle(o);
              attempted++;
              if (r === 'failed') {
                log(`  ⚠ ${o.name}: 逐章也失败，跳过`);
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
              log(`  ✗ ${o.name}: ${errorMessage(err)}`);
              failed++;
              attempted++;
            }
          }
        } else {
          attempted += batch.length;
          await sleep(cfg.betweenChaptersMs || 1000);
        }
      }

      log(`----- 剧情线 ${arc} 完成 -----`);
    }

    log(`========== ${novel.name} 本轮结束 ==========`);

    if (cfg.deleteConversationAfterDone) {
      try {
        await deleteCurrentConversation(page);
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
 * 运行改编大纲主流程。
 *
 * @param cfg    配置（AdaptConfig）
 * @param dryRun 只规划、不开浏览器
 */
export async function runAdapt(cfg: AdaptConfig, dryRun = false): Promise<RunResult> {
  return await run(cfg, dryRun);
}

// ---------- 直接运行入口 ----------
const DRY = process.argv.includes('--dry-run');

const isMain =
  import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/') ||
  process.argv[1]?.endsWith('adapt-runner.ts') ||
  process.argv[1]?.endsWith('adapt-runner.js');

if (isMain) {
  const cfg = loadConfig();
  runAdapt(cfg, DRY).catch((err) => {
    console.error('运行出错:', err);
    process.exit(1);
  });
}
