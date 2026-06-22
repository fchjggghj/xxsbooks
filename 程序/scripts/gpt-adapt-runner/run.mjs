// step2 改编大纲主流程：
//   每本小说独占一个对话（整本同对话），采用重叠批次策略：
//   - 第一批：1-6章一起发，只保留1-5的结果
//   - 后续批次：从上一批保留的最后一章开始，取7章，保留中间5章
//   例如：1-6(保留1-5), 5-11(保留6-10), 10-16(保留11-15)...
//   关键：同一本小说的所有批次在同一个对话里，上下文连贯。
//   断连重连时回到该对话 URL，而不是开新对话。
//
// 用法：
//   node run.mjs --dry-run   只规划、不开浏览器
//   node run.mjs             连接 Chrome 正式跑
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlan, isDone, readOutline, writeOutput, readConversationUrl, saveConversationUrl, deleteConversationUrl } from './lib/files.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes('--dry-run');

function loadConfig() {
  const cfgPath = path.join(__dirname, 'config.json');
  try {
    return JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new Error(`配置文件 ${cfgPath} 解析失败: ${err.message}`);
  }
}

function log(msg) {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${t}] ${msg}`);
}

function errorMessage(err) {
  return String(err?.message || err || '');
}

function isBrowserClosedError(err) {
  return /target page, context or browser has been closed|browser has been closed|browser closed|target closed|connection closed|websocket.*closed|econnrefused/i.test(errorMessage(err));
}

function boundedMs(value, fallback, maxValue = 24 * 60 * 60 * 1000) {
  const n = Number(value);
  const ms = Number.isFinite(n) && n > 0 ? n : fallback;
  return Math.max(1000, Math.min(ms, maxValue));
}

// 回复有效性校验
const isRefusal = (s) => {
  const x = (s || '').trim();
  return x.length < 600 && /违反了我们的使用政策|可能违反|使用政策/.test(x);
};
const usableWith = (s, minChars) => {
  const x = (s || '').trim();
  return x.length >= minChars && !isRefusal(s);
};

// 把 M 章大纲拼成一个带分隔标记的提示
function buildBatchPrompt(chs, prefix) {
  const M = chs.length;
  const head = `${prefix}

我一次发给你 ${M} 个章节的大纲。请按你的规则逐章处理。输出时务必严格按下面格式（我要用程序自动切分）：
- 第 k 章（k 从 1 到 ${M}）开头，单独占一行只写分隔标记：=====CHAPTER-k=====（把 k 换成数字，如第1章写 =====CHAPTER-1=====）
- 紧接着另起一行，写该章处理后的内容。
- 必须正好输出 ${M} 段，顺序与我给的一致。

以下是 ${M} 个章节的大纲：\n`;
  let body = '';
  chs.forEach((c, i) => { body += `\n----- 章节${i + 1}（${c.base}）-----\n${readOutline(c)}\n`; });
  return head + body;
}

// 按分隔标记把回复切成 M 段。标记数 ≠ M 返回 null（整批作废重发，绝不写错位）
function splitBatch(text, M) {
  const re = /=====\s*CHAPTER[-\s]*\d+\s*=====/gi;
  const pos = [];
  let m;
  while ((m = re.exec(text || ''))) pos.push({ at: m.index, end: re.lastIndex });
  if (pos.length !== M) return null;
  const segs = [];
  for (let i = 0; i < M; i++) {
    const s = pos[i].end;
    const e = i + 1 < M ? pos[i + 1].at : (text || '').length;
    segs.push((text || '').slice(s, e).trim());
  }
  return segs;
}

// 构建重叠批次计划
function buildBatches(pending, batchSize, batchSizeNext, keepCount) {
  const batches = [];
  let i = 0;
  let isFirst = true;

  while (i < pending.length) {
    const size = isFirst ? batchSize : batchSizeNext;
    const end = Math.min(i + size, pending.length);
    const toSend = pending.slice(i, end);

    if (toSend.length < 2) {
      batches.push({ toSend, keepIndices: toSend.map((_, idx) => idx), isSingle: true });
      break;
    }

    let keepIndices;
    if (isFirst) {
      keepIndices = Array.from({ length: Math.min(keepCount, toSend.length) }, (_, j) => j);
    } else {
      keepIndices = Array.from({ length: Math.min(keepCount, toSend.length - 1) }, (_, j) => j + 1);
    }

    batches.push({ toSend, keepIndices, isSingle: false });
    // 推进到保留的最后一章的索引，确保下一批从该章开始（重叠上下文）
    i += keepIndices[keepIndices.length - 1];
    isFirst = false;

    if (i >= pending.length) break;
  }

  return batches;
}

// 增强版发送：记录发送前的 assistant 数量，确认回复真正到达后才返回
async function sendAndConfirm(page, prompt, cfg, cg) {
  // 发送前：记录当前 assistant 消息数
  const beforeState = await cg.inspectPageState(page);
  const beforeCount = beforeState.assistantCount || 0;
  const beforeUrl = page.url();

  // 发送并等待回复
  const result = await cg.sendAndCollect(page, prompt, cfg);

  // 额外确认：assistant 消息数必须增加了
  const afterState = await cg.inspectPageState(page);
  const afterCount = afterState.assistantCount || 0;

  if (afterCount <= beforeCount && result.text) {
    // 消息数没增加但有文本，可能是页面没刷新，再等一下
    log(`  确认回复：assistant数 ${beforeCount}→${afterCount}，等待确认…`);
    for (let i = 0; i < 10; i++) {
      await cg.sleep(1000);
      const checkState = await cg.inspectPageState(page);
      if ((checkState.assistantCount || 0) > beforeCount) {
        log(`  确认回复：assistant数增至 ${checkState.assistantCount}`);
        break;
      }
      if (checkState.generating) {
        log(`  仍在生成中…`);
        continue;
      }
    }
    // 最终读取
    const finalText = await cg.getLastAssistantText(page);
    if (finalText && finalText.length > (result.text || '').length) {
      result.text = finalText;
    }
  }

  // 捕获对话 URL（发送第一条消息后 URL 会变成对话链接）
  const afterUrl = page.url();
  const conversationUrl = afterUrl !== beforeUrl && /\/c\//.test(afterUrl) ? afterUrl : null;

  return { ...result, conversationUrl };
}

async function run(cfg) {
  const { plan, totalNovels, totalOutlines, pendingOutlines } = buildPlan(cfg);

  console.log('__PENDING__=' + pendingOutlines);

  const concurrency = Math.max(1, Number(cfg.concurrency ?? 1));
  const batchSize = Number(cfg.overlapBatchSize ?? 6);
  const batchSizeNext = Number(cfg.overlapBatchSizeNext ?? 7);
  const keepCount = Number(cfg.overlapKeepCount ?? 5);

  // 参数校验
  if (keepCount < 1) throw new Error('config.json: overlapKeepCount 必须 >= 1');
  if (batchSize < 2) throw new Error('config.json: overlapBatchSize 必须 >= 2');
  if (keepCount >= batchSizeNext) log('⚠ overlapKeepCount >= overlapBatchSizeNext，后续批次无重叠章');

  console.log('==================== 改编大纲处理计划 ====================');
  console.log(`输入目录    : ${cfg.inputRoot}`);
  console.log(`输出目录    : ${cfg.outputRoot}`);
  console.log(`改编 GPT    : ${cfg.gptUrl}`);
  console.log(`小说范围    : ${(cfg.novels && cfg.novels.length) ? cfg.novels.length + ' 本（指定）' : '全库'}`);
  console.log(`小说总数    : ${totalNovels}`);
  console.log(`全部大纲    : ${totalOutlines}`);
  console.log(`待处理      : ${pendingOutlines}（已有输出的自动跳过）`);
  console.log(`批次策略    : 首批${batchSize}章保留${keepCount}章，后续${batchSizeNext}章保留${keepCount}章（重叠上下文）`);
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

  if (DRY) {
    console.log('\n[dry-run] 仅规划，未开浏览器、未写任何文件。');
    return;
  }

  if (!cfg.gptUrl || cfg.gptUrl.includes('在这里填')) {
    throw new Error('请先在 config.json 填入改编 GPT 链接 gptUrl');
  }
  if (!pendingOutlines) {
    log('没有待处理大纲，全部已完成。');
    return;
  }

  const cg = await import('../gpt-outline-runner/lib/chatgpt.mjs');
  const workers = Math.min(concurrency, 1);
  log(`连接 Chrome（CDP），准备 ${workers} 个标签页…`);
  let { pages } = await cg.getPages(cfg, workers);
  let page = pages[0];
  log('已就绪');

  const limit = Number(cfg.maxChapters) > 0 ? Number(cfg.maxChapters) : Infinity;
  if (limit !== Infinity) log(`本次最多处理 ${limit} 章（maxChapters，试跑用；设 0 = 不限）`);

  const prefix = cfg.promptPrefix || '';
  const minChars = Number(cfg.minOutputChars ?? 300);
  const usable = (s) => usableWith(s, minChars);

  let done = 0;
  let failed = 0;
  let attempted = 0;

  // 重连浏览器，回到指定对话
  async function reconnectBrowser(conversationUrl) {
    log('⚠ 尝试重连浏览器…');
    const result = await cg.getPages(cfg, 1);
    page = result.pages[0];
    if (conversationUrl) {
      log(`  回到对话: ${conversationUrl}`);
      await page.goto(conversationUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await cg.sleep(2000);
      // 等待输入框就绪
      await page.waitForSelector('#prompt-textarea, textarea[name="prompt-textarea"], [data-testid="composer-input"]', { timeout: 30000 }).catch(() => {});
      await cg.sleep(1000);
    } else {
      await cg.newConversation(page, cfg);
    }
    log('✓ 重连成功');
    return page;
  }

  // 单章发送（兜底用，在当前对话内发送，不开新对话）
  async function sendSingle(outline) {
    const prompt = prefix ? `${prefix}\n\n${readOutline(outline)}` : readOutline(outline);
    const maxStuck = Number(cfg.stuckRetries ?? 3);

    for (let attempt = 1; attempt <= maxStuck; attempt++) {
      if (attempt > 1) {
        log(`↻ ${outline.name}: 重试 ${attempt}/${maxStuck}…`);
      }

      let text, timedOut;
      try {
        ({ text, timedOut } = await sendAndConfirm(page, prompt, cfg, cg));
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
          log(`✓ ${outline.name}（${text.length}字，单章）`);
          return 'done';
        }
        return 'done';
      }

      // 配额墙？
      if (await cg.hitRateLimit(page)) {
        const waitMs = boundedMs(cfg.rateLimitWaitMs, 30 * 60 * 1000);
        log(`⚠ 撞配额墙，暂停 ${Math.ceil(waitMs / 60000)} 分钟…`);
        await cg.sleep(waitMs);
        attempt--;
        continue;
      }
    }

    log(`✗ ${outline.name}: 重试耗尽`);
    failed++;
    return 'failed';
  }

  // 批量发送（在当前对话内发送，不开新对话）
  async function sendBatchWithKeep(toSend, keepIndices) {
    const prompt = buildBatchPrompt(toSend, prefix);
    const maxStuck = Number(cfg.stuckRetries ?? 3);

    for (let attempt = 1; attempt <= maxStuck; attempt++) {
      let text;
      try {
        ({ text } = await sendAndConfirm(page, prompt, cfg, cg));
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
        log(`✓ 批量${toSend.length}章完成，保留${saved}章`);
        return true;
      }

      // 配额墙？
      if (await cg.hitRateLimit(page)) {
        const waitMs = boundedMs(cfg.rateLimitWaitMs, 30 * 60 * 1000);
        log(`⚠ 批量撞配额墙，暂停 ${Math.ceil(waitMs / 60000)} 分钟…`);
        await cg.sleep(waitMs);
        attempt--;
        continue;
      }

      log(`↻ 批量切分失败（期望${toSend.length}段，实际${segs ? '格式不对' : '未找到标记'}），重试 ${attempt}/${maxStuck}…`);
    }
    return false;
  }

  // 逐本处理
  for (const { novel, pending } of plan) {
    if (attempted >= limit) break;
    if (!pending.length) continue;

    log(`========== 开始小说: ${novel.name}（待处理 ${pending.length} 章）==========`);

    // 检查是否有已保存的对话URL，有则恢复到该对话，没有才开新对话
    let conversationUrl = readConversationUrl(novel, cfg);
    if (conversationUrl) {
      log(`恢复已有对话: ${conversationUrl}`);
      try {
        await page.goto(conversationUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await cg.sleep(2000);
        // 验证是否真的到了目标对话
        const currentUrl = page.url();
        const expectedId = conversationUrl.match(/\/c\/([^/?]+)/)?.[1];
        const actualId = currentUrl.match(/\/c\/([^/?]+)/)?.[1];
        if (!actualId || actualId !== expectedId) {
          log(`⚠ 对话已不存在或URL已变更（期望 ${expectedId}，实际 ${actualId || '无'}），开新对话`);
          conversationUrl = null;
          deleteConversationUrl(novel, cfg);
          await cg.newConversation(page, cfg);
        } else {
          await page.waitForSelector('#prompt-textarea, textarea[name="prompt-textarea"], [data-testid="composer-input"]', { timeout: 30000 }).catch(() => {});
          await cg.sleep(1000);
          log('✓ 已回到已有对话');
        }
      } catch (err) {
        log(`⚠ 恢复对话失败: ${errorMessage(err)}，开新对话`);
        conversationUrl = null;
        deleteConversationUrl(novel, cfg);
        await cg.newConversation(page, cfg);
      }
    } else {
      await cg.newConversation(page, cfg);
      log('已开新对话');
    }

    // 构建重叠批次
    const batches = buildBatches(pending, batchSize, batchSizeNext, keepCount);

    // 打印批次计划
    log(`批次规划：共 ${batches.length} 批`);
    batches.forEach((b, bi) => {
      const names = b.toSend.map((o) => o.name.replace(/\.md$/, ''));
      const keepNames = b.keepIndices.map((idx) => names[idx]);
      log(`  批次${bi + 1}: 发[${names[0]}..${names[names.length - 1]}] 保留[${keepNames.join(', ')}]`);
    });

    // 执行批次（用索引循环，支持重连后重试当前批次）
    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi];
      if (attempted >= limit) break;

      const toProcess = batch.toSend.filter((o) => !isDone(o));
      if (!toProcess.length) continue;

      try {
        if (batch.isSingle || toProcess.length === 1) {
          for (const o of toProcess) {
            if (isDone(o)) continue;
            if (attempted >= limit) break;
            await sendSingle(o);
            attempted++;
            // 捕获对话URL
            if (!conversationUrl) {
              const curUrl = page.url();
              if (/\/c\//.test(curUrl)) {
                conversationUrl = curUrl;
                saveConversationUrl(novel, cfg, conversationUrl);
                log(`  对话URL: ${conversationUrl}`);
              }
            }
            await cg.sleep(cfg.betweenChaptersMs || 1000);
          }
        } else {
          const ok = await sendBatchWithKeep(batch.toSend, batch.keepIndices);
          // 捕获对话URL
          if (!conversationUrl) {
            const curUrl = page.url();
            if (/\/c\//.test(curUrl)) {
              conversationUrl = curUrl;
              saveConversationUrl(novel, cfg, conversationUrl);
              log(`  对话URL: ${conversationUrl}`);
            }
          }
          if (!ok) {
            // 批量失败，回退逐章（只处理需要保留的章节，仍在同一对话内）
            const toFallback = batch.toSend.filter((_, idx) => batch.keepIndices.includes(idx)).filter((o) => !isDone(o));
            log(`批量不成，回退逐章处理 ${toFallback.length} 章（同一对话内）…`);
            for (const o of toFallback) {
              if (isDone(o)) continue;
              if (attempted >= limit) break;
              await sendSingle(o);
              attempted++;
              await cg.sleep(cfg.betweenChaptersMs || 1000);
            }
          } else {
            attempted += toProcess.length;
            await cg.sleep(cfg.betweenChaptersMs || 1000);
          }
        }
      } catch (err) {
        if (isBrowserClosedError(err)) {
          try {
            page = await reconnectBrowser(conversationUrl);
            bi--; // 重试当前批次
            continue;
          } catch (reconnErr) {
            log(`FATAL 重连失败: ${errorMessage(reconnErr)}`);
            throw err;
          }
        }
        log(`✗ 批次失败: ${errorMessage(err)}`);
        failed += toProcess.length;
        attempted += toProcess.length;
        // 非浏览器关闭错误，尝试回到当前对话继续
        if (conversationUrl) {
          try {
            await page.goto(conversationUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await cg.sleep(2000);
          } catch {}
        }
      }
    }

    log(`========== ${novel.name} 本轮结束 ==========`);

    // 如果所有章节都完成了，清理对话URL文件
    const remaining = pending.filter((o) => !isDone(o));
    if (!remaining.length) {
      deleteConversationUrl(novel, cfg);
    }

    if (cfg.deleteConversationAfterDone) {
      try { await cg.deleteCurrentConversation(page); } catch {}
    }
  }

  log(`全部结束。成功 ${done}，失败 ${failed}。`);
}

async function main() {
  const cfg = loadConfig();
  await run(cfg);
}

main().catch((err) => {
  console.error('运行出错:', err);
  process.exit(1);
});
