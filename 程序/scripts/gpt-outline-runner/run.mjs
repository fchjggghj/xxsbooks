// 主流程：每本小说独占对话，本书内每 N 章换新对话，本书发完自动开下一本。
// 断点续传：输出已存在的章节自动跳过。
// 用法：
//   node run.mjs --dry-run   只规划、不开浏览器（验证文件/断点逻辑）
//   node run.mjs             连接你的 Chrome 真正开跑
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPlan,
  claimChapter,
  clearSkipMarker,
  isDone,
  readChapter,
  releaseChapterClaim,
  writeOutput,
  writeSkipMarker,
} from './lib/files.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes('--dry-run');

function loadConfig() {
  const cfgPath = path.join(__dirname, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^﻿/, '')); // 去 BOM：PowerShell 重写 config 会带 BOM（server.mjs 同样处理）
  return cfg;
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

function isTransientPageError(err) {
  return /execution context was destroyed|cannot find context with specified id|frame was detached|navigation/i.test(errorMessage(err));
}

function boundedMs(value, fallback, maxValue = 24 * 60 * 60 * 1000) {
  const n = Number(value);
  const ms = Number.isFinite(n) && n > 0 ? n : fallback;
  return Math.max(1000, Math.min(ms, maxValue));
}

function processAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function readRunLock(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function acquireRunLock(cfg) {
  const lockPath = path.join(__dirname, '.run.lock');
  const staleMs = Number(cfg.runLockStaleMs ?? 24 * 60 * 60 * 1000);

  for (let i = 0; i < 2; i++) {
    let fd = null;
    try {
      fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
      }, null, 2), 'utf8');
      return { lockPath };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;

      const info = readRunLock(lockPath);
      if (info.pid && processAlive(info.pid)) {
        throw new Error(`已有 run.mjs 正在运行（pid=${info.pid}），本次退出以避免重复生成。`);
      }

      try {
        const st = fs.statSync(lockPath);
        if (!info.pid && Date.now() - st.mtimeMs < staleMs) {
          throw new Error(`发现较新的运行锁 ${lockPath}，本次退出以避免重复生成。`);
        }
        fs.unlinkSync(lockPath);
        continue;
      } catch (staleErr) {
        if (staleErr?.code !== 'ENOENT') throw staleErr;
        continue;
      }
    } finally {
      if (fd != null) fs.closeSync(fd);
    }
  }

  throw new Error(`无法创建运行锁 ${lockPath}`);
}

function releaseRunLock(lock) {
  if (!lock?.lockPath) return;
  try {
    const info = readRunLock(lock.lockPath);
    if (Number(info.pid) === process.pid) fs.unlinkSync(lock.lockPath);
  } catch {
    // 退出清理失败不影响已生成文件。
  }
}

async function run(cfg) {
  const { plan, totalNovels, totalChapters, selectedChapters, pendingChapters } = buildPlan(cfg);

  // 机器可读标记（守护脚本 run-forever.ps1 靠它判断剩余/是否跑完，纯 ASCII）
  console.log('__PENDING__=' + pendingChapters);

  const roundToArc = cfg.selection?.roundToArc ?? true;
  const uniformN = Number(cfg.selection?.firstNPerNovel ?? 0);
  const concurrency = Math.max(1, Number(cfg.concurrency ?? 1));
  const batchSize = Math.max(1, Number(cfg.chaptersPerRequest ?? 1));

  console.log('==================== 处理计划 ====================');
  console.log(`素材库      : ${cfg.libraryRoot}`);
  console.log(`小说范围    : ${(cfg.novels && cfg.novels.length) ? cfg.novels.length + ' 本（指定）' : '全库'}`);
  console.log(`小说总数    : ${totalNovels}`);
  console.log(`全部章节    : ${totalChapters}`);
  if (uniformN > 0) console.log(`选取规则    : 每本前 ${uniformN} 章（${roundToArc ? '按弧边界·不切断世界' : '硬切到第' + uniformN + '章'}）`);
  console.log(`规则选中    : ${selectedChapters} 章`);
  console.log(`待处理      : ${pendingChapters}（选中里已有输出的自动跳过）`);
  console.log(`并发标签页  : ${concurrency}`);
  if (batchSize > 1) console.log(`每请求章数  : ${batchSize}（多章合一个提示发送，减少请求次数=少撞限制）`);
  console.log('--------------------------------------------------');
  for (const { novel, tier, chapters, selected, pending } of plan.slice(0, 10)) {
    const r = novel.readers == null ? '无在读' : (novel.readers >= 10000 ? (novel.readers / 10000) + '万' : novel.readers + '人');
    console.log(`  ${novel.name}`);
    console.log(`     [${tier}/${r}] 全${chapters.length}章 → 选中${selected.length}，待处理${pending.length}`);
    if (pending[0]) console.log(`     首个待处理: ${pending[0].name} → ${pending[0].outputPath}`);
  }
  if (plan.length > 10) console.log(`  …（其余 ${plan.length - 10} 本省略）`);
  console.log('==================================================');

  if (DRY) {
    console.log('\n[dry-run] 仅规划，未开浏览器、未写任何文件。');
    if (!cfg.gptUrl || cfg.gptUrl.includes('在这里填')) {
      console.log('[dry-run] 提醒：config.json 里的 gptUrl 还没填你的自定义 GPT 链接。');
    }
    return;
  }

  if (!cfg.gptUrl || cfg.gptUrl.includes('在这里填')) {
    throw new Error('请先在 config.json 填入你的自定义 GPT 链接 gptUrl');
  }
  if (!pendingChapters) {
    log('没有待处理章节，全部已完成。');
    return;
  }

  // ===== 配置热更新 =====
  // 结构类字段（影响计划/连接：并发、选取规则、素材库、GPT链接等）变了 → 本轮优雅退出让守护用新配置重启；
  // 其余（每请求章数、各超时、章间隔、每对话章数、提示词、重试次数、最小字数）每批前热读、立即生效。
  function structSig(c) {
    return JSON.stringify({
      libraryRoot: c.libraryRoot, novels: c.novels, chaptersDir: c.chaptersDir,
      outputDir: c.outputDir, outputExt: c.outputExt, skipFiles: c.skipFiles,
      selection: c.selection, concurrency: c.concurrency, gptUrl: c.gptUrl, cdpUrl: c.cdpUrl,
    });
  }
  const baseSig = structSig(cfg);
  let live = cfg;      // 最新一次成功读到的配置
  let stale = false;   // 结构类配置发生了变化
  function refreshLive() {
    try {
      const next = loadConfig();
      live = next;
      if (!stale && structSig(next) !== baseSig) {
        stale = true;
        log('⟳ 检测到配置结构变更（并发/选取规则/素材库/GPT链接等），本轮处理完手头的批后优雅退出，守护会用新配置重启（约30秒内生效）。');
      }
    } catch { /* 读失败（可能面板正写一半）→ 沿用上次 live，下一批再读 */ }
    return live;
  }

  // 扁平化待处理队列（按计划顺序）。批大小在运行时按最新 chaptersPerRequest 动态决定（热更新）。
  const flat = [];
  for (const { novel, pending } of plan) {
    for (const ch of pending) flat.push({ ch, novelName: novel.name });
  }

  // 回复有效性校验（minChars 用最新配置，故做成带参函数）。
  const isRefusal = (s) => { const x = (s || '').trim(); return x.length < 600 && /违反了我们的使用政策|可能违反|使用政策/.test(x); };
  const usableWith = (s, minChars) => { const x = (s || '').trim(); return x.length >= minChars && !isRefusal(s); };

  // 把 M 章拼成一个带分隔标记的提示（GPT 实测能按 =====CHAPTER-k===== 乖乖分段）。
  function buildBatchPrompt(chs) {
    const M = chs.length;
    const head = `我一次发给你 ${M} 个章节，请逐章拆大纲。务必严格按下面格式输出（我要用程序自动切分，格式不对会作废重发）：
- 第 k 章（k 从 1 到 ${M}）开头，单独占一行只写分隔标记：=====CHAPTER-k=====（把 k 换成数字，如第1章写 =====CHAPTER-1=====）
- 紧接着另起一行，写该章完整大纲，沿用你一贯的高密度逐条大纲风格。
- 必须正好输出 ${M} 段，顺序与我给的一致；不要写任何前言、过渡语、总结或目录。

以下是 ${M} 个章节的正文：\n`;
    let body = '';
    chs.forEach((c, i) => { body += `\n----- 章节${i + 1}（${c.base}）-----\n${readChapter(c)}\n`; });
    return head + body;
  }

  // 按分隔标记把回复切成 M 段。标记数 ≠ M 就返回 null（宁可整批作废重发，绝不写错位）。
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

  // 仅在真正要跑时才加载浏览器模块
  const cg = await import('./lib/chatgpt.mjs');
  const workers = Math.min(concurrency, flat.length);
  log(`连接 Chrome（CDP），准备 ${workers} 个标签页…（每批 ${batchSize} 章合 1 个请求；配置支持热更新，改 config.json 随时生效）`);
  const { pages } = await cg.getPages(cfg, workers);
  log(`已就绪 ${pages.length} 个标签页`);

  async function waitForRateLimitRecovery(page, c, label = '') {
    let info = { limited: true, resetMs: null, hint: '' };
    try { info = await cg.rateLimitInfo(page); } catch {}
    const fallback = boundedMs(c.rateLimitWaitMs, 30 * 60 * 1000);
    const maxWait = boundedMs(c.maxRateLimitWaitMs, 2 * 60 * 60 * 1000);
    const waitMs = boundedMs(info?.resetMs, fallback, maxWait);
    const mins = Math.max(1, Math.ceil(waitMs / 60000));
    log(`⚠ ${label || '疑似撞配额墙'}，智能暂停约 ${mins} 分钟后自动恢复${info?.hint ? `（识别: ${info.hint}）` : ''}`);
    await cg.sleep(waitMs);
    await cg.newConversation(page, c);
    return waitMs;
  }

  async function cleanupConversation(page, c, label = '') {
    if (!c.deleteConversationAfterDone) return false;
    try {
      const r = await cg.deleteCurrentConversation(page);
      log(`${r.ok ? '✓' : '⚠'} 已请求删除网站对话记录${label ? `（${label}）` : ''}${r.ok ? '' : `：${r.message || r.step || '未完成'}`}`);
      return !!r.ok;
    } catch (err) {
      log(`⚠ 删除网站对话记录失败${label ? `（${label}）` : ''}: ${errorMessage(err)}`);
      return false;
    }
  }

  async function maybePauseAfterFailure(page, c, label = '') {
    const cap = Number(c.maxConsecutiveFailures ?? 3);
    if (!cap || cap <= 0 || consecutiveSoftFailures < cap) return;
    const waitMs = boundedMs(c.failurePauseMs, 5 * 60 * 1000);
    log(`⚠ 连续失败 ${consecutiveSoftFailures} 次，智能暂停 ${Math.ceil(waitMs / 60000)} 分钟后继续${label ? `（${label}）` : ''}`);
    await cg.sleep(waitMs);
    await cg.newConversation(page, c);
    consecutiveSoftFailures = 0;
  }

  const limit = Number(cfg.maxChapters) > 0 ? Number(cfg.maxChapters) : Infinity;
  if (limit !== Infinity) log(`本次最多处理 ${limit} 章（maxChapters，用于试跑；设 0 = 不限）`);

  let cursor = 0;
  let done = 0;
  let failed = 0;
  let attempted = 0;
  let fatal = null;
  let consecutiveSoftFailures = 0;
  const loggedBooks = new Set();

  // 取下一批：从游标起，取最多 size 个「同一本书」的连续待处理章（size=最新 chaptersPerRequest，热更新）。
  const nextBatch = (size) => {
    if (fatal || stale || attempted >= limit || cursor >= flat.length) return null;
    const first = flat[cursor]; cursor++;
    const items = [first.ch];
    while (cursor < flat.length && flat[cursor].novelName === first.novelName && items.length < size) {
      items.push(flat[cursor].ch); cursor++;
    }
    return { novelName: first.novelName, items };
  };

  const saveOutput = (ch, text, suffix = '') => {
    if (writeOutput(ch, text)) {
      clearSkipMarker(ch);
      done++;
      consecutiveSoftFailures = 0;
      log(`✓ ${ch.name} -> ${path.basename(ch.outputPath)}（${text.length} 字）${suffix}`);
      return true;
    }
    log(`跳过保存（输出或跳过标记已存在）: ${ch.name}`);
    return false;
  };
  const markSkipped = (ch, reason, details, message) => {
    failed++;
    writeSkipMarker(ch, reason, details);
    log(message);
  };

  // 单章发送（兜底用，最稳）：批量切分失败时逐章重发，绝不写错位。c=最新配置。
  async function sendSingle(page, ch, c) {
    const minChars = Number(c.minOutputChars ?? 300);
    const usable = (s) => usableWith(s, minChars);
    const prompt = (c.promptTemplate || '{content}').replace('{content}', readChapter(ch));
    const { text, timedOut } = await cg.sendAndCollect(page, prompt, c);
    if (isRefusal(text)) { markSkipped(ch, 'policy_refusal', { responsePreview: String(text || '').slice(0, 300) }, `✗ ${ch.name}: 被内容政策拒绝，已写跳过标记`); return 'policy_refusal'; }
    if (usable(text)) { saveOutput(ch, text, '（单章兜底）'); return 'done'; }
    if (await cg.hitRateLimit(page)) {
      await waitForRateLimitRecovery(page, c, `处理 ${ch.name} 时达到上限`);
      const r = await cg.sendAndCollect(page, prompt, c);
      if (isRefusal(r.text)) { markSkipped(ch, 'policy_refusal', { responsePreview: String(r.text || '').slice(0, 300) }, `✗ ${ch.name}: 配额恢复后被内容政策拒绝，已写跳过标记`); return 'policy_refusal'; }
      if (usable(r.text)) { saveOutput(ch, r.text, '（配额恢复后单章）'); return 'done'; }
    }
    const maxStuck = Number(c.stuckRetries ?? 3);
    for (let s = 1; s <= maxStuck; s++) {
      await cg.newConversation(page, c);
      const r = await cg.sendAndCollect(page, prompt, c);
      if (isRefusal(r.text)) { markSkipped(ch, 'policy_refusal', { retry: s }, `✗ ${ch.name}: 重试仍被政策拒绝，已写跳过标记`); return 'policy_refusal'; }
      if (usable(r.text)) { saveOutput(ch, r.text, `（单章刷新重试第${s}次）`); return 'done'; }
    }
    markSkipped(ch, 'no_valid_reply', { timedOut, minChars }, `✗ ${ch.name}: 没拿到有效回复${timedOut ? '（超时）' : ''}，已写跳过标记`);
    consecutiveSoftFailures++;
    return 'failed';
  }

  // 工作线程：每批前热读配置 → 取一批 → 发送/切分落盘；切分失败回退逐章。独占一个标签页。
  async function worker(wi, page) {
    await cg.sleep(wi * 1500); // 错峰启动
    let countInConv = 0;
    let convReady = false;

    while (true) {
      const c = refreshLive();                 // 每批前热读最新配置（热更新）
      if (stale) break;                        // 结构类配置变更 → 本轮优雅退出
      const size = Math.max(1, Number(c.chaptersPerRequest ?? 1));
      const batch = nextBatch(size);
      if (!batch) break;

      const minChars = Number(c.minOutputChars ?? 300);
      const usable = (s) => usableWith(s, minChars);

      // 逐章加锁，过滤掉已完成/被别的标签页占用的，得到真正要处理的这批
      const claims = [];
      const chs = [];
      for (const ch of batch.items) {
        if (isDone(ch, c)) continue;
        const claim = claimChapter(ch, c);
        if (claim.claimed) { claims.push(claim); chs.push(ch); }
      }
      if (!chs.length) continue;

      try {
        if (!loggedBooks.has(batch.novelName)) { loggedBooks.add(batch.novelName); log(`========== 开始小说: ${batch.novelName} ==========`); }
        if (!convReady || countInConv >= c.chaptersPerConversation) {
          await cg.newConversation(page, c); countInConv = 0; convReady = true;
        }

        let resetConversationAfterBatch = false;
        try {
          if (chs.length === 1) {
            const result = await sendSingle(page, chs[0], c);
            if (result === 'done') resetConversationAfterBatch = await cleanupConversation(page, c, chs[0].name);
            if (result === 'failed') await maybePauseAfterFailure(page, c, chs[0].name);
          } else {
            const prompt = buildBatchPrompt(chs);
            const maxStuck = Number(c.stuckRetries ?? 3);
            let okBatch = false;
            for (let attempt = 1; attempt <= maxStuck && !okBatch; attempt++) {
              const { text } = await cg.sendAndCollect(page, prompt, c);
              if (isRefusal(text)) { log(`↻ [W${wi}] 批量(${chs.length}章)被政策拒绝，转逐章兜底…`); break; }
              const segs = splitBatch(text, chs.length);
              if (segs && segs.every(usable)) {
                for (let i = 0; i < chs.length; i++) saveOutput(chs[i], segs[i], `（批量 ${chs.length} 章/请求）`);
                okBatch = true;
                resetConversationAfterBatch = await cleanupConversation(page, c, `${chs.length} 章批量`);
              } else if (await cg.hitRateLimit(page)) {
                await waitForRateLimitRecovery(page, c, `[W${wi}] 批量达到上限`);
                countInConv = 0;
              } else {
                log(`↻ [W${wi}] 批量切分失败（标记数对不上或某段太短），刷新重试 ${attempt}/${maxStuck}…`);
                await cg.newConversation(page, c); countInConv = 0;
              }
            }
            if (!okBatch) {
              log(`[W${wi}] 批量多次不成，回退逐章处理这 ${chs.length} 章（保证不写错位）…`);
              await cg.newConversation(page, c); countInConv = 0;
              for (let ci = 0; ci < chs.length; ci++) {
                const ch = chs[ci];
                if (!isDone(ch, c)) {
                  const result = await sendSingle(page, ch, c);
                  if (result === 'done') {
                    const cleaned = await cleanupConversation(page, c, ch.name);
                    resetConversationAfterBatch = cleaned || resetConversationAfterBatch;
                    if (cleaned && ci < chs.length - 1) { await cg.newConversation(page, c); countInConv = 0; }
                  }
                  if (result === 'failed') await maybePauseAfterFailure(page, c, ch.name);
                }
              }
            }
          }
        } catch (err) {
          if (isBrowserClosedError(err)) { log(`FATAL [W${wi}] browser/page closed; 中止本轮以便守护重启 Chrome 续跑。`); fatal = err; break; }
          if (isTransientPageError(err)) {
            log(`Transient page error: ${errorMessage(err)}; 重开对话后回退逐章重试。`);
            try {
              await cg.newConversation(page, c); countInConv = 0;
              for (let ci = 0; ci < chs.length; ci++) {
                const ch = chs[ci];
                if (!isDone(ch, c)) {
                  const result = await sendSingle(page, ch, c);
                  if (result === 'done') {
                    const cleaned = await cleanupConversation(page, c, ch.name);
                    resetConversationAfterBatch = cleaned || resetConversationAfterBatch;
                    if (cleaned && ci < chs.length - 1) { await cg.newConversation(page, c); countInConv = 0; }
                  }
                  if (result === 'failed') await maybePauseAfterFailure(page, c, ch.name);
                }
              }
            } catch (retryErr) {
              if (isBrowserClosedError(retryErr)) { log(`FATAL [W${wi}] browser/page closed while retrying; 中止。`); fatal = retryErr; break; }
              failed += chs.length;
              consecutiveSoftFailures += chs.length;
              await maybePauseAfterFailure(page, c, `W${wi} 重试失败`);
              log(`✗ 批次失败: ${retryErr?.message || retryErr}`);
            }
          } else {
            failed += chs.length;
            consecutiveSoftFailures += chs.length;
            await maybePauseAfterFailure(page, c, `W${wi} 批次失败`);
            log(`✗ 批次失败: ${err?.message || err}`);
          }
        }

        if (resetConversationAfterBatch) { convReady = false; countInConv = 0; }
        else countInConv += chs.length;
        attempted += chs.length;
        if (attempted >= limit) { log(`已达本次上限 ${limit} 章，停止（改 config.json 的 maxChapters 放开）。`); break; }
        await cg.sleep(c.betweenChaptersMs);
      } finally {
        for (const cl of claims) releaseChapterClaim(cl);
      }
    }
  }

  await Promise.all(pages.map((p, i) => worker(i, p)));

  if (fatal) { log(`本轮中止。成功 ${done}，失败 ${failed}。`); throw fatal; }
  if (stale) { log(`配置已变更，本轮优雅退出（成功 ${done}，失败 ${failed}）。守护将用新配置重启（约30秒内）。`); return; }
  log(`全部结束。成功 ${done}，失败 ${failed}。`);
}

async function main() {
  const cfg = loadConfig();
  const runLock = DRY ? null : acquireRunLock(cfg);
  try {
    await run(cfg);
  } finally {
    releaseRunLock(runLock);
  }
}

main().catch((err) => {
  console.error('运行出错:', err);
  process.exit(1);
});
