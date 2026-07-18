import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { acquireQueueLock, releaseQueueLock } from './queue-lock.mjs';
import { sortVolumeNames } from './lib/naming.mjs';
import { taskStateKey, mergeStateTasks, firstRunnableTask } from './lib/queue-state.mjs';
import { classifyQueueError, safeAppendJsonlLog } from './lib/structured-log.mjs';
import { collectPriorVolumeContext } from './lib/prior-context.mjs';
import { normalizeAssistantText } from './lib/assistant-text.mjs';
import { replaceReplyTitle, resolveOriginalTitle } from './lib/chapter-title.mjs';
import { loadBookCatalog, settingsForBook } from './lib/book-catalog.mjs';
import { filterFilesByChapterRange, matchesBookFilter } from './lib/task-scope.mjs';
import {
  canonicalConversationUrl,
  claimConversation,
  isConversationUrl,
  releaseNovelConversation,
} from './lib/conversation-registry.mjs';
import { loadQueueConfig, parseQueueArgs, readQueueJson, validateQueueConfig } from './lib/queue/config.mjs';
import { detectPageError, QueueError } from './lib/queue/page-errors.mjs';

let queueLockHandle = null;
let queuePage = null;
let signalExitStarted = false;
const runId = randomUUID();
const priorContextCache = new Map();

async function releaseLockAndExit(signal) {
  if (signalExitStarted) return;
  signalExitStarted = true;
  const exitCode = signal === 'SIGINT' ? 130 : 143;
  try {
    if (queuePage && !queuePage.isClosed()) await queuePage.close().catch(() => {});
    queuePage = null;
    await releaseQueueLock(queueLockHandle);
    queueLockHandle = null;
  } catch (err) {
    console.error(`Failed to release queue lock: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    process.exit(exitCode);
  }
}

process.once('SIGINT', () => {
  void releaseLockAndExit('SIGINT');
});
process.once('SIGTERM', () => {
  void releaseLockAndExit('SIGTERM');
});

const COMPOSER_SELECTORS = [
  'div#prompt-textarea[contenteditable="true"][role="textbox"]',
  '[data-testid="prompt-textarea"][contenteditable="true"]',
  'div[contenteditable="true"][role="textbox"]',
  'div[contenteditable="true"]',
  'textarea:not(.wcDTda_fallbackTextarea)',
];

const SEND_BUTTON_SELECTORS = [
  '[data-testid="send-button"]',
  '[data-testid="fruitjuice-send-button"]',
  'button[aria-label*="Send"]',
  'button[aria-label*="发送"]',
];

const EDIT_BUTTON_SELECTORS = [
  '[data-testid="message-edit-button"]',
  'button[aria-label*="Edit"]',
  'button[aria-label*="编辑"]',
];

const EDIT_SUBMIT_SELECTORS = [
  '[data-testid="message-edit-submit-button"]',
  'button[aria-label*="Submit"]',
  'button[aria-label*="Save"]',
  'button[aria-label*="发送"]',
  'button[aria-label*="提交"]',
  'button:has-text("Submit")',
  'button:has-text("Save")',
  'button:has-text("发送")',
  'button:has-text("提交")',
];

const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"]';
const USER_SELECTOR = '[data-message-author-role="user"]';

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function atomicWrite(file, text) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  // Windows 上 rename 可能因杀毒软件/索引服务锁定目标文件而失败(EPERM)，
  // 重试几次，每次间隔递增。
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      if (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES') throw err;
      // 重新写入 tmp 文件（上次 rename 失败后 tmp 可能已被移走或仍存在）
      if (attempt < 5) {
        try { await fs.writeFile(tmp, text, 'utf8'); } catch { /* ignore */ }
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }
  throw lastErr;
}

async function logEvent(cfg, event, fields = {}) {
  return safeAppendJsonlLog(cfg.logFile, event, {
    schemaVersion: 1,
    runId,
    stage: cfg.stage,
    ...fields,
  }, (error) => {
    // 日志失败不得覆盖真实任务结果。
    console.warn(`警告: 写入日志失败: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function walkFiles(dir, recursive, extensions, root = dir) {
  if (!fssync.existsSync(dir)) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) files.push(...(await walkFiles(full, recursive, extensions, root)));
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!extensions.includes(ext)) continue;
    files.push({
      inputPath: full,
      relativePath: path.relative(root, full),
    });
  }

  return files.sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath, 'zh-Hans-CN', { numeric: true }),
  );
}

function sanitizeFileName(value) {
  return String(value)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function pad(num, width = 4) {
  return String(num).padStart(width, '0');
}

function taskIdFor(index, group) {
  const start = pad(index + 1);
  const end = pad(index + group.length);
  return group.length === 1 ? start : `${start}-${end}`;
}

function outputPathForTask(cfg, task) {
  // 卷模式：outputDir/书名/卷名/outputSubdir/[中间子路径/]文件名.ext
  // 书结构模式：outputDir/书名/outputSubdir/[中间子路径/]文件名.ext
  // 扁平模式（outputSubdir 为空或无书目录）：退化为 outputDir/相对目录/文件名.ext
  const useSubdir = task.hasNovelFolder && cfg.outputSubdir;

  if (task.inputFiles.length === 1) {
    const rel = task.inputFiles[0].relativePath;
    const parts = rel.split(/[\\/]+/).filter(Boolean);
    const fileName = parts.pop();
    // relativePath = 书名/[卷名/]文件路径。去掉 novelKey 首段，保留中间子路径。
    const novelKeyParts = task.novelKey.split(/[\\/]+/).filter(Boolean);
    const midParts = parts.slice(novelKeyParts.length);
    const outParts = [cfg.outputDir, ...novelKeyParts];
    if (useSubdir) outParts.push(cfg.outputSubdir);
    outParts.push(...midParts);
    const parsed = path.parse(fileName);
    outParts.push(`${parsed.name}${cfg.outputExtension}`);
    return path.join(...outParts);
  }

  const first = sanitizeFileName(path.parse(task.inputFiles[0].relativePath).name);
  const last = sanitizeFileName(path.parse(task.inputFiles.at(-1).relativePath).name);
  const novelKeyParts = task.novelKey.split(/[\\/]+/).filter(Boolean);
  const outParts = [cfg.outputDir, ...novelKeyParts];
  if (useSubdir) outParts.push(cfg.outputSubdir);
  outParts.push(`${task.localId}__${first}__to__${last}${cfg.outputExtension}`);
  return path.join(...outParts);
}

// 变更每次处理的章节数时，保留旧任务已完成章节的完成状态，避免把原先的
// 多章任务拆成单章任务后重复发送。
function completedInputFiles(state) {
  return new Set(
    Object.values(state.tasks || {})
      .filter((item) => item.status === 'done')
      .flatMap((item) => Array.isArray(item.inputFiles) ? item.inputFiles : []),
  );
}

function preserveCompletedInputs(state, tasks, completedFiles) {
  for (const task of tasks) {
    const item = state.tasks[taskStateKey(task)];
    if (!item || item.status === 'done' || item.restartRequired === true) continue;
    if (task.inputFiles.length > 0 && task.inputFiles.every((file) => completedFiles.has(file.relativePath))) {
      item.status = 'done';
      item.lastError = '';
    }
  }
}

function fileNovelInfo(file) {
  const parts = file.relativePath.split(/[\\/]+/).filter(Boolean);
  if (parts.length > 1) {
    return {
      novelKey: parts[0],
      novelName: parts[0],
      hasNovelFolder: true,
    };
  }

  const name = path.parse(file.relativePath).name;
  return {
    novelKey: name,
    novelName: name,
    hasNovelFolder: false,
  };
}

async function scanBookSource(cfg) {
  // 收集每本书的源文件，并附带 novelKey/novelName/hasNovelFolder/volumeKey/volumeName。
  //
  // 卷模式（volumeMode=true，强制分卷）：
  //   inputDir/书名/卷名/inputSubdir/文件
  //   novelKey = "书名/卷名"，对话按卷隔离，同卷复用对话，跨卷不串
  //   relativePath = "书名/卷名/文件相对路径"
  //
  // 书结构模式（inputSubdir 非空，volumeMode=false）：
  //   inputDir/书名/inputSubdir/文件
  //   novelKey = 书名
  //
  // 扁平模式（inputSubdir 为空）：递归扫描 inputDir，由 relativePath 推断 novelKey。
  const files = [];

  if (cfg.volumeMode && cfg.inputSubdir) {
    if (!fssync.existsSync(cfg.inputDir)) return files;
    const books = await fs.readdir(cfg.inputDir, { withFileTypes: true });
    for (const bookEntry of books) {
      if (!bookEntry.isDirectory() || bookEntry.name.startsWith('.')) continue;
      const bookName = bookEntry.name;
      const bookDir = path.join(cfg.inputDir, bookName);
      const volumes = await fs.readdir(bookDir, { withFileTypes: true });
      const volumeNames = volumes
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort(sortVolumeNames);
      for (const volumeName of volumeNames) {
        const sourceDir = path.join(bookDir, volumeName, cfg.inputSubdir);
        if (!fssync.existsSync(sourceDir)) continue;
        const subFiles = await walkFiles(sourceDir, cfg.recursive, cfg.fileExtensions, sourceDir);
        const novelKey = `${bookName}/${volumeName}`;
        for (const f of subFiles) {
          files.push({
            inputPath: f.inputPath,
            relativePath: path.join(bookName, volumeName, f.relativePath),
            novelKey,
            novelName: bookName,
            volumeKey: novelKey,
            volumeName,
            hasNovelFolder: true,
          });
        }
      }
    }
    // 卷模式下按 novelKey(书名/卷名) 分组排序，保证卷顺序正确（第一卷 < 第二卷）
    files.sort((a, b) => {
      const aParts = a.novelKey.split('/');
      const bParts = b.novelKey.split('/');
      // 先按书名排序
      const bookCmp = aParts[0].localeCompare(bParts[0], 'zh-Hans-CN', { numeric: true });
      if (bookCmp !== 0) return bookCmp;
      // 同书按卷名排序（支持中文数字）
      if (aParts[1] && bParts[1]) {
        const vcmp = sortVolumeNames(aParts[1], bParts[1]);
        if (vcmp !== 0) return vcmp;
      }
      return a.relativePath.localeCompare(b.relativePath, 'zh-Hans-CN', { numeric: true });
    });
    return files;
  }

  if (cfg.inputSubdir) {
    if (!fssync.existsSync(cfg.inputDir)) return files;
    const entries = await fs.readdir(cfg.inputDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const bookName = entry.name;
      const sourceDir = path.join(cfg.inputDir, bookName, cfg.inputSubdir);
      if (!fssync.existsSync(sourceDir)) continue;
      const subFiles = await walkFiles(sourceDir, cfg.recursive, cfg.fileExtensions, sourceDir);
      for (const f of subFiles) {
        files.push({
          inputPath: f.inputPath,
          relativePath: path.join(bookName, f.relativePath),
          novelKey: bookName,
          novelName: bookName,
          volumeKey: bookName,
          volumeName: '',
          hasNovelFolder: true,
        });
      }
    }
    files.sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath, 'zh-Hans-CN', { numeric: true }),
    );
    return files;
  }

  const walked = await walkFiles(cfg.inputDir, cfg.recursive, cfg.fileExtensions);
  for (const f of walked) {
    files.push({ ...f, ...fileNovelInfo(f), volumeKey: f.novelKey, volumeName: '' });
  }
  return files;
}

async function buildTasks(cfg, opts) {
  // 普通 dry-run 必须零写入，目录只在真实运行时创建。
  if (!opts.dryRun) {
    await ensureDir(cfg.inputDir);
    await ensureDir(cfg.outputDir);
  }

  const files = await scanBookSource(cfg);
  const catalog = await loadBookCatalog(cfg);
  const novels = new Map();
  for (const file of files) {
    // scanBookSource 已附带 novelKey/volumeKey，直接用；否则用 fileNovelInfo 推断
    const novel = file.novelKey
      ? { novelKey: file.novelKey, novelName: file.novelName || file.novelKey, volumeKey: file.volumeKey || file.novelKey, volumeName: file.volumeName || '', hasNovelFolder: file.hasNovelFolder !== false }
      : fileNovelInfo(file);
    if (!novels.has(novel.novelKey)) novels.set(novel.novelKey, { ...novel, files: [] });
    novels.get(novel.novelKey).files.push(file);
  }

  const tasks = [];
  for (const novel of novels.values()) {
    if (!matchesBookFilter(opts.bookFilters, novel)) continue;
    const bookSettings = settingsForBook(catalog, novel.novelName, cfg.stage, cfg.chapterRange);
    if (!bookSettings.enabled) continue;
    if (cfg.skipNovelKeys.includes(novel.novelKey)) continue;
    novel.files = filterFilesByChapterRange(novel.files, bookSettings.chapterRange);
    for (let i = 0; i < novel.files.length; i++) {
      const group = [novel.files[i]];
      const localId = taskIdFor(i, group);
      const task = {
        id: `${novel.novelKey}:${localId}`,
        localId,
        index: tasks.length,
        novelKey: novel.novelKey,
        novelName: novel.novelName,
        volumeKey: novel.volumeKey || novel.novelKey,
        volumeName: novel.volumeName || '',
        hasNovelFolder: novel.hasNovelFolder,
        inputFiles: group,
        outputPath: '',
      };
      task.outputPath = outputPathForTask(cfg, task);
      task.originalTitle = await resolveOriginalTitle(cfg, task);
      tasks.push(task);
    }
  }

  // --limit is intentionally NOT applied here: capping the built list would also
  // cap already-done tasks, so a bounded resume against a mostly-finished queue
  // would see "No pending tasks" instead of processing the next N pending ones.
  // The limit is enforced in the processing loop in main().
  return tasks;
}

function nowIso() {
  return new Date().toISOString();
}

async function loadState(cfg, opts) {
  if (opts.resetState && fssync.existsSync(cfg.stateFile)) {
    await fs.rm(cfg.stateFile, { force: true });
  }

  if (!fssync.existsSync(cfg.stateFile)) {
    return {
      version: 4,
      configName: cfg.configName,
      currentTaskId: null,
      currentNovelKey: null,
      currentConversationUrl: '',
      novelConversations: {},
      conversationOwners: {},
      tasks: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
  }

  const state = await readQueueJson(cfg.stateFile);
  state.version = 4;
  state.configName = state.configName || cfg.configName;
  state.currentTaskId = state.currentTaskId || null;
  state.currentNovelKey = state.currentNovelKey || null;
  state.currentConversationUrl = state.currentConversationUrl || '';
  state.novelConversations = state.novelConversations || {};
  state.conversationOwners = state.conversationOwners || {};
  for (const [novelKey, conversationUrl] of Object.entries(state.novelConversations)) {
    if (!isConversationUrl(conversationUrl)) {
      delete state.novelConversations[novelKey];
      continue;
    }
    claimConversation(state, conversationUrl, { stage: cfg.stage, novelKey });
  }
  state.tasks = state.tasks || {};
  delete state.conversationPromptCount;
  return state;
}

async function saveState(cfg, state) {
  state.updatedAt = nowIso();
  await atomicWrite(cfg.stateFile, JSON.stringify(state, null, 2) + '\n');
}

async function loadPlaywright() {
  try {
    return await import('playwright-core');
  } catch {
    throw new Error('Missing dependency playwright-core. Run npm install first.');
  }
}

async function visibleLocator(page, selectors, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).last();
      try {
        if ((await locator.count()) > 0 && (await locator.isVisible())) return locator;
      } catch {
        // Try the next selector.
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error('Timed out waiting for a visible page control.');
}

async function closeOverlays(page) {
  try {
    await page.keyboard.press('Escape');
  } catch {
    // Ignore focus/keyboard issues.
  }
  for (const selector of ['[data-testid="close-button"]', 'button[aria-label="关闭"]']) {
    const buttons = await page.locator(selector).all().catch(() => []);
    for (const button of buttons.reverse()) {
      try {
        if (await button.isVisible()) {
          await button.click({ timeout: 1000 });
          await page.waitForTimeout(300);
          return;
        }
      } catch {
        // Ignore stale modal buttons.
      }
    }
  }
}

async function firstComposer(page, timeoutMs = 90000) {
  return visibleLocator(page, COMPOSER_SELECTORS, timeoutMs);
}

async function assistantTexts(page) {
  try {
    const messages = page.locator(ASSISTANT_SELECTOR);
    const count = await messages.count();
    const texts = [];

    for (let index = 0; index < count; index++) {
      const message = messages.nth(index);
      const markdown = message.locator('.markdown');
      const markdownCount = await markdown.count();
      const raw = markdownCount > 0
        ? (await markdown.allInnerTexts()).join('\n\n')
        : await message.innerText();
      texts.push(normalizeAssistantText(raw));
    }

    return texts;
  } catch {
    return [];
  }
}

async function isGenerating(page) {
  const selectors = [
    '[data-testid="stop-button"]',
    'button[aria-label*="Stop"]',
    'button[aria-label*="停止"]',
  ];

  for (const selector of selectors) {
    try {
      const button = page.locator(selector).last();
      if ((await button.count()) > 0 && (await button.isVisible())) return true;
    } catch {
      // Ignore missing controls.
    }
  }
  return false;
}

async function openNewConversation(page, cfg) {
  // 开新对话是薄弱环节：goto 到 GPTS 介绍页后，React 状态可能未初始化好，
  // 插入文本并点击发送会被框架忽略。加载后先 reload 一次让 React 重新初始化。
  // goto / reload / firstComposer 任一步失败时重试，最多尝试 3 次。
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(cfg.gptUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      // 关键：刷新页面让 React 重新初始化输入框状态，否则插入文本后发送无效。
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await closeOverlays(page);
      await firstComposer(page, 90000);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await page.waitForTimeout(3000);
    }
  }
  throw lastErr;
}

async function openExistingConversation(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await closeOverlays(page);
  await firstComposer(page, 90000);
}

function assertExpectedConversation(page, expectedUrl, novelKey) {
  const actual = canonicalConversationUrl(page.url());
  const expected = canonicalConversationUrl(expectedUrl);
  if (actual !== expected) {
    throw new QueueError(
      `Conversation URL mismatch for novel "${novelKey}": expected ${expected}, got ${actual}`,
      'page_structure',
    );
  }
}

async function ensureNovelConversation(page, cfg, state, task, taskState, useFailedConversation) {
  const failedConversationUrl = useFailedConversation ? taskState.conversationUrl : '';
  const savedNovelUrl = state.novelConversations[task.novelKey] || '';
  const targetUrl = [failedConversationUrl, savedNovelUrl].find(isConversationUrl) || '';

  if (!targetUrl) {
    await openNewConversation(page, cfg);
    state.currentConversationUrl = page.url();
    state.currentNovelKey = task.novelKey;
    return;
  }

  claimConversation(state, targetUrl, { stage: cfg.stage, novelKey: task.novelKey });

  if (page.url() !== targetUrl) {
    await openExistingConversation(page, targetUrl);
  } else {
    await closeOverlays(page);
    await firstComposer(page, 90000);
  }

  assertExpectedConversation(page, targetUrl, task.novelKey);

  state.currentConversationUrl = targetUrl;
  state.currentNovelKey = task.novelKey;
  state.novelConversations[task.novelKey] = targetUrl;
}

async function setEditableText(page, locator, text) {
  // Playwright 的 fill 会触发浏览器原生 input 事件，能同步 ChatGPT 当前的
  // React/ProseMirror 状态；仅用 keyboard.insertText 会出现页面显示为空且无法发送。
  try {
    await locator.fill(text);
    const filled = await locator.evaluate((el) => {
      const value = el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement
        ? el.value
        : (el.textContent || '');
      return value.length;
    });
    if (filled > 0) return;
  } catch {
    // 少数旧版 contenteditable 不支持 fill，下面保留键盘输入回退。
  }

  await locator.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.press('Backspace');

  const chunkSize = 3500;
  for (let i = 0; i < text.length; i += chunkSize) {
    await page.keyboard.insertText(text.slice(i, i + chunkSize));
  }

  // 关键：keyboard.insertText 只改 DOM，不触发 React/ProseMirror 的 input 事件，
  // 导致框架内部状态认为输入为空，发送按钮点击无效。
  // 主动 dispatch InputEvent 让框架同步状态。
  await locator.evaluate((el) => {
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: null,
    }));
  });

  const filled = await locator.evaluate((el) => {
    const value = el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement
      ? el.value
      : (el.textContent || '');
    return value.length;
  });
  if (filled === 0) throw new QueueError('Failed to write prompt into the ChatGPT composer.', 'page_structure');
}

async function insertPrompt(page, prompt) {
  const composer = await firstComposer(page, 90000);
  await setEditableText(page, composer, prompt);
}

async function editableTextLength(locator) {
  return locator.evaluate((el) => {
    const value = el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement
      ? el.value
      : (el.textContent || '');
    return value.trim().length;
  });
}

async function clickSend(page) {
  // 只以新增用户消息作为提交成功信号。输入框清空可能由页面重绘造成，不能
  // 证明提示词已进入当前会话。
  const beforeUserCount = await page.locator(USER_SELECTOR).count();
  // A long prompt on a brand-new GPT conversation can take more than 15 seconds
  // to appear in the message list after the click, even though the button is enabled.
  const deadline = Date.now() + 45000;
  let clicked = false;
  let clickedAt = 0;
  let usedKeyboardFallback = false;
  while (Date.now() < deadline) {
    if (!clicked) {
      for (const selector of SEND_BUTTON_SELECTORS) {
        try {
          const button = page.locator(selector).last();
          if ((await button.count()) > 0 && (await button.isVisible()) && (await button.isEnabled())) {
            await button.click({ timeout: 2000, noWaitAfter: true });
            clicked = true;
            clickedAt = Date.now();
            break;
          }
        } catch {
          // The page may re-render after a successful click; verify below.
        }
      }
    }
    await page.waitForTimeout(250);
    if ((await page.locator(USER_SELECTOR).count()) > beforeUserCount) return;

    // Some GPT landing pages expose an enabled send button whose pointer click
    // does not submit. Only fall back to Enter when the same visible composer
    // still contains the full prompt, which prevents duplicate sends.
    if (clicked && !usedKeyboardFallback && Date.now() - clickedAt >= 8000) {
      const composer = await firstComposer(page, 2000).catch(() => null);
      if (composer && await editableTextLength(composer).catch(() => 0) > 0) {
        await composer.click();
        await page.keyboard.press('Enter');
        usedKeyboardFallback = true;
      }
    }
  }

  throw new QueueError('ChatGPT send control did not submit the prompt.', 'page_structure');
}

async function clickVisible(page, selectors, timeoutMs = 8000) {
  const control = await visibleLocator(page, selectors, timeoutMs);
  await control.click();
}

async function editLastUserPrompt(page, prompt) {
  const userMessages = page.locator(USER_SELECTOR);
  if ((await userMessages.count()) === 0) {
    return false;
  }

  const lastUser = userMessages.last();
  await lastUser.scrollIntoViewIfNeeded();
  await lastUser.hover();

  let editClicked = false;
  for (const selector of EDIT_BUTTON_SELECTORS) {
    const scoped = lastUser.locator(selector).last();
    try {
      if ((await scoped.count()) > 0 && (await scoped.isVisible())) {
        await scoped.click();
        editClicked = true;
        break;
      }
    } catch {
      // Try page-level controls.
    }

    const global = page.locator(selector).last();
    try {
      if ((await global.count()) > 0 && (await global.isVisible())) {
        await global.click();
        editClicked = true;
        break;
      }
    } catch {
      // Try the next selector.
    }
  }

  if (!editClicked) {
    return false;
  }

  const scopedEditor = lastUser
    .locator('textarea, div[contenteditable="true"][role="textbox"], div[contenteditable="true"]')
    .last();
  const editor =
    (await scopedEditor.count().catch(() => 0)) > 0 && (await scopedEditor.isVisible().catch(() => false))
      ? scopedEditor
      : await visibleLocator(page, COMPOSER_SELECTORS, 10000);
  await setEditableText(page, editor, prompt);

  let submitted = false;
  for (const selector of EDIT_SUBMIT_SELECTORS) {
    const scopedSubmit = lastUser.locator(selector).last();
    try {
      if ((await scopedSubmit.count()) > 0 && (await scopedSubmit.isVisible())) {
        await scopedSubmit.click();
        submitted = true;
        break;
      }
    } catch {
      // Try the next selector.
    }
  }

  if (!submitted) await clickVisible(page, EDIT_SUBMIT_SELECTORS, 10000).catch(async () => {
    await page.keyboard.press('Control+Enter').catch(async () => {
      await page.keyboard.press('Enter');
    });
  });

  return true;
}

async function waitForReply(page, beforeTexts, cfg) {
  const deadline = Date.now() + Number(cfg.waitReplyTimeoutMs || 180000);
  const beforeJoined = beforeTexts.join('\n---assistant-message---\n');
  let lastText = '';
  let stableSince = 0;

  while (Date.now() < deadline) {
    // 检测页面上的额度限制 / 安全拦截错误提示
    const pageError = await detectPageError(page);
    if (pageError) throw pageError;

    const texts = await assistantTexts(page);
    const joined = texts.join('\n---assistant-message---\n');
    const changed = texts.length > beforeTexts.length || joined !== beforeJoined;
    const current = texts.at(-1) || '';
    const text = current.trim();

    if (text && text !== lastText) {
      lastText = text;
      stableSince = Date.now();
    }

    const stableMs = stableSince ? Date.now() - stableSince : 0;
    const enoughReply =
      changed &&
      text.length >= Number(cfg.minReplyChars || 80) &&
      stableMs >= Number(cfg.replyStableMs || 2500);
    const stableWhileGeneratingMs = Number(cfg.maxStableGeneratingMs || 0);
    const generationLooksStuck =
      stableWhileGeneratingMs > 0 && stableMs >= stableWhileGeneratingMs;
    if (
      enoughReply &&
      (generationLooksStuck || !(await isGenerating(page)))
    ) {
      return text;
    }

    await page.waitForTimeout(800);
  }

  // 超时前再检测一次页面错误，避免把额度/安全误判为普通超时
  const pageError = await detectPageError(page);
  if (pageError) throw pageError;

  if (lastText.trim()) return lastText.trim();
  throw new QueueError('Timed out waiting for GPTS reply.', 'timeout');
}

// 旧版聊天记录的答案标记，仅用于向后兼容读取。
const CHAT_ANSWER_MARKER = '## 🤖 答';

// 从聊天记录格式文件内容中提取「答」部分。非聊天记录格式原样返回。
function extractAnswer(text) {
  const idx = text.indexOf(CHAT_ANSWER_MARKER);
  if (idx === -1) return text;
  return text.slice(idx + CHAT_ANSWER_MARKER.length).trim();
}

async function readTaskContent(cfg, task) {
  const parts = [];
  for (const item of task.inputFiles) {
    const raw = await fs.readFile(item.inputPath, 'utf8');
    // 聊天记录格式文件提取「答」部分；纯文本原样返回（向后兼容）
    const content = extractAnswer(raw);
    if (cfg.includeFileHeaders || task.inputFiles.length > 1) {
      parts.push(`===== ${item.relativePath} =====\n${content}`);
    } else {
      parts.push(content);
    }
  }
  return parts.join('\n\n');
}

// 收集同书前序卷的拆分文件作为背景信息，注入到 xie 的 prompt 前。
// novelKey = "书名/卷名"，提取书名，找到该书目录下排在当前卷之前的卷，
// 读取它们的 outputSubdir（拆分）目录下所有文件，拼接成背景文本。
async function collectPriorVolumes(cfg, task) {
  if (!cfg.priorVolumeContext || !task.volumeKey?.includes('/')) {
    return { text: '', charCount: 0, truncated: false, sources: [], volumeCount: 0 };
  }
  const cacheKey = `${cfg.configPath}\u0000${task.volumeKey}`;
  if (priorContextCache.has(cacheKey)) return priorContextCache.get(cacheKey);

  const [bookName, currentVolume] = task.volumeKey.split('/');
  const result = await collectPriorVolumeContext({
    bookDir: path.join(cfg.inputDir, bookName),
    currentVolume,
    inputSubdir: cfg.inputSubdir === '拆分' ? '拆分' : (cfg.priorVolumeSourceSubdir || '拆分'),
    extensions: cfg.fileExtensions,
    recursive: cfg.recursive,
    summaryFileName: cfg.priorVolumeSummaryFile,
    maxChars: cfg.priorVolumeContextMaxChars,
    fallbackCharsPerVolume: cfg.priorVolumeFallbackCharsPerVolume,
    extractContent: extractAnswer,
  });
  priorContextCache.set(cacheKey, result);
  return result;
}

function renderPrompt(template, task, content, priorVolumes = '') {
  return String(template)
    .replaceAll('{{content}}', content)
    .replaceAll('{{priorVolumes}}', priorVolumes)
    .replaceAll('{{taskId}}', task.id)
    .replaceAll('{{localTaskId}}', task.localId)
    .replaceAll('{{novelName}}', task.novelName)
    .replaceAll('{{novelKey}}', task.novelKey)
    .replaceAll('{{volumeName}}', task.volumeName || '')
    .replaceAll('{{chapterCount}}', String(task.inputFiles.length))
    .replaceAll('{{filename}}', path.basename(task.inputFiles[0].inputPath))
    .replaceAll('{{relativePath}}', task.inputFiles[0].relativePath)
    .replaceAll('{{originalTitle}}', task.originalTitle || '')
    .replaceAll('{{filenames}}', task.inputFiles.map((x) => path.basename(x.inputPath)).join('\n'))
    .replaceAll('{{relativePaths}}', task.inputFiles.map((x) => x.relativePath).join('\n'));
}

async function sendOrEdit(page, cfg, task, prompt, method, onSubmitted) {
  const beforeTexts = await assistantTexts(page);
  if (method === 'edit-and-resend') {
    const edited = await editLastUserPrompt(page, prompt);
    if (!edited) {
      await insertPrompt(page, prompt);
      await clickSend(page);
    }
  } else {
    await insertPrompt(page, prompt);
    await clickSend(page);
  }
  await onSubmitted();
  return waitForReply(page, beforeTexts, cfg);
}

async function persistSubmittedTask(page, cfg, state, task, taskState, method) {
  try {
    await page.waitForURL((url) => /\/c\/[^/]+/.test(url.pathname), { timeout: 10000 });
  } catch {
    throw new QueueError(
      `Prompt was submitted but ChatGPT did not expose a conversation URL: ${page.url()}`,
      'page_structure',
    );
  }
  const conversationUrl = page.url();
  claimConversation(state, conversationUrl, { stage: cfg.stage, novelKey: task.novelKey });
  taskState.sent = true;
  taskState.conversationUrl = conversationUrl;
  taskState.updatedAt = nowIso();
  state.currentConversationUrl = conversationUrl;
  state.currentNovelKey = task.novelKey;
  state.novelConversations[task.novelKey] = conversationUrl;
  await saveState(cfg, state);
  await logEvent(cfg, 'task_submitted', taskLogFields(task, { method, conversationUrl }));
}

function taskLogFields(task, extra = {}) {
  return {
    taskId: task.id,
    book: task.novelName,
    volume: task.volumeName || '',
    inputFiles: task.inputFiles.map((item) => item.relativePath),
    outputFile: path.relative(process.cwd(), task.outputPath),
    ...extra,
  };
}

async function markTaskFailed(page, cfg, state, task, taskState, error, phase, extra = {}) {
  const kind = classifyQueueError(error);
  const message = error instanceof Error ? error.message : String(error);
  const currentUrl = page?.url?.() || taskState.conversationUrl || '';
  taskState.status = 'failed';
  taskState.lastError = message;
  taskState.updatedAt = nowIso();
  if (currentUrl && taskState.sent) taskState.conversationUrl = currentUrl;
  state.currentTaskId = task.id;
  state.currentNovelKey = task.novelKey;
  if (currentUrl && taskState.sent) {
    state.currentConversationUrl = currentUrl;
    state.novelConversations[task.novelKey] = currentUrl;
  }
  await saveState(cfg, state);
  await logEvent(cfg, 'task_failed', taskLogFields(task, {
    phase,
    errorKind: kind,
    error: message,
    conversationUrl: currentUrl,
    ...extra,
  }));
  return { kind, message };
}

async function processTask(page, cfg, state, task, taskState) {
  let content;
  let priorVolumes;
  let basePrompt;
  try {
    content = await readTaskContent(cfg, task);
    priorVolumes = await collectPriorVolumes(cfg, task);
    basePrompt = renderPrompt(cfg.promptTemplate, task, content, priorVolumes.text);
    if (basePrompt.length > cfg.maxPromptChars) {
      throw new QueueError(
        `提示词 ${basePrompt.length} 字符，超过 maxPromptChars=${cfg.maxPromptChars}；请缩短当前章节或卷摘要`,
        'prompt_too_large',
      );
    }

    const useEditFirst =
      cfg.retryMode === 'edit-and-resend' &&
      taskState.status === 'failed' &&
      taskState.sent === true &&
      taskState.conversationUrl;
    await ensureNovelConversation(page, cfg, state, task, taskState, useEditFirst);
    await saveState(cfg, state);
  } catch (error) {
    const failed = await markTaskFailed(page, cfg, state, task, taskState, error, 'prepare', {
      contentChars: content?.length || 0,
      priorContextChars: priorVolumes?.charCount || 0,
      promptChars: basePrompt?.length || 0,
    });
    await atomicWrite(`${task.outputPath}.error.txt`, `${failed.message}\n`);
    throw error;
  }

  // 三类重试各自独立计数，不互相挤占额度：
  //   rateLimitRetries — 额度限制，等待后 edit-and-resend 重发同一条
  //   safetyRetries    — 安全拦截，加安全前缀后 edit-and-resend 重发
  //   normalRetries    — 其他超时/错误，走原有 maxRetries 逻辑
  let rateLimitRetries = 0;
  let safetyRetries = 0;
  let normalRetries = 0;
  let lastError = '';
  const normalMaxAttempts = cfg.maxRetries + 1;
  // 安全前缀会累加：每次安全重试再追加一句声明，让 GPTS 重新评估
  let safetyPrefixCount = 0;
  // recoveryLog 记录恢复动作，写入 taskState（state.json），便于事后追溯
  taskState.recoveryLog = taskState.recoveryLog || [];

  for (;;) {
    // 决定本次 method：已发送过且配置了 edit-and-resend 则编辑重发，否则新发
    const shouldEdit = taskState.sent === true && cfg.retryMode === 'edit-and-resend';
    const method = shouldEdit ? 'edit-and-resend' : 'send';

    // 组装本次 prompt：安全拦截时在前面加声明前缀（可累加）
    let prompt = basePrompt;
    if (safetyPrefixCount > 0) {
      prompt = cfg.safetyPrefix.repeat(safetyPrefixCount) + basePrompt;
    }

    const attemptStartedAt = Date.now();
    try {
      if (prompt.length > cfg.maxPromptChars) {
        throw new QueueError(
          `重试提示词 ${prompt.length} 字符，超过 maxPromptChars=${cfg.maxPromptChars}`,
          'prompt_too_large',
        );
      }
      taskState.status = 'running';
      taskState.currentAttempt = normalRetries + 1;
      taskState.lastError = '';
      if (taskState.sent) taskState.conversationUrl = state.currentConversationUrl || page.url();
      taskState.updatedAt = nowIso();
      await saveState(cfg, state);
      await logEvent(cfg, 'task_attempt_started', taskLogFields(task, {
        method,
        attempt: normalRetries + 1,
        rateLimitRetries,
        safetyRetries,
        normalRetries,
        contentChars: content.length,
        priorContextChars: priorVolumes.charCount,
        priorContextTruncated: priorVolumes.truncated,
        promptChars: prompt.length,
        conversationUrl: taskState.conversationUrl,
      }));

      const reply = await sendOrEdit(page, cfg, task, prompt, method, async () => {
        await persistSubmittedTask(page, cfg, state, task, taskState, method);
      });
      const finalReply = task.originalTitle
        ? replaceReplyTitle(reply, task.originalTitle)
        : `${reply.trim()}\n`;

      // 只保存回复内容；元信息（对话地址/时间/重试/恢复过程）已在 taskState 里，持久化到 state.json
      await atomicWrite(task.outputPath, finalReply);
      await fs.rm(`${task.outputPath}.error.txt`, { force: true });

      state.currentConversationUrl = page.url();
      state.currentNovelKey = task.novelKey;
      state.novelConversations[task.novelKey] = page.url();

      taskState.status = 'done';
      delete taskState.restartRequired;
      taskState.retries = Number(taskState.retries || 0) + normalRetries;
      taskState.lastError = '';
      taskState.outputFile = task.outputPath;
      taskState.conversationUrl = page.url();
      taskState.doneAt = nowIso();
      taskState.updatedAt = nowIso();
      await saveState(cfg, state);
      await logEvent(cfg, 'task_done', taskLogFields(task, {
        method,
        durationMs: Date.now() - attemptStartedAt,
        replyChars: finalReply.length,
        promptChars: prompt.length,
        priorContextChars: priorVolumes.charCount,
        conversationUrl: page.url(),
      }));
      return finalReply.length;
    } catch (error) {
      const failed = await markTaskFailed(page, cfg, state, task, taskState, error, 'attempt', {
        method,
        durationMs: Date.now() - attemptStartedAt,
        promptChars: prompt.length,
        contentChars: content.length,
        priorContextChars: priorVolumes.charCount,
      });
      const { kind } = failed;
      lastError = failed.message;

      // 1) 额度限制：等待后 edit-and-resend 重发同一条，不跳到后面
      if (kind === 'rate_limit' && rateLimitRetries < Number(cfg.rateLimitMaxAttempts || 3)) {
        rateLimitRetries++;
        const waitMs = Number(cfg.rateLimitWaitMs || 900000);
        const waitMin = Math.round(waitMs / 60000);
        taskState.recoveryLog.push({ time: nowIso(), kind: 'rate_limit', action: `wait_${waitMin}min`, retry: rateLimitRetries });
        await saveState(cfg, state);
        await logEvent(cfg, 'task_retry_scheduled', taskLogFields(task, {
          errorKind: kind,
          retry: rateLimitRetries,
          maxRetries: cfg.rateLimitMaxAttempts,
          waitMs,
        }));
        console.log(`  额度限制，等待 ${waitMin} 分钟后重发第 ${rateLimitRetries} 次...`);
        await page.waitForTimeout(waitMs);
        continue;
      }

      // 2) 安全拦截：不等待，加安全前缀后 edit-and-resend 重发，多次尝试
      if (kind === 'safety' && safetyRetries < Number(cfg.safetyMaxAttempts || 5)) {
        safetyRetries++;
        safetyPrefixCount++;
        taskState.recoveryLog.push({ time: nowIso(), kind: 'safety', action: `add_safety_prefix x${safetyPrefixCount}`, retry: safetyRetries });
        await saveState(cfg, state);
        await logEvent(cfg, 'task_retry_scheduled', taskLogFields(task, {
          errorKind: kind,
          retry: safetyRetries,
          maxRetries: cfg.safetyMaxAttempts,
          safetyPrefixCount,
        }));
        console.log(`  安全拦截，加安全声明前缀后重发第 ${safetyRetries} 次...`);
        continue;
      }

      // 3) 其他错误：走原有 maxRetries 逻辑
      if (kind === 'prompt_too_large' || kind === 'login' || kind === 'page_structure') {
        await atomicWrite(`${task.outputPath}.error.txt`, `${lastError}\n`);
        throw error;
      }

      normalRetries++;
      taskState.recoveryLog.push({ time: nowIso(), kind, action: 'normal_retry', retry: normalRetries });
      if (normalRetries >= normalMaxAttempts) {
        await atomicWrite(`${task.outputPath}.error.txt`, `${lastError}\n`);
        throw error;
      }

      await page.waitForTimeout(Math.max(1000, Number(cfg.betweenItemsMs || 0)));
    }
  }
}

function displayPath(projectRoot, file) {
  return path.relative(projectRoot, file) || '.';
}

// 按 novelKey 限流：每个 novelKey 最多保留 perNovelLimit 个任务。
// perNovelLimit<=0 表示不限流。用于实现"每本书只处理前 N 章"的跨书轮询。
function filterByPerNovelLimit(tasks, perNovelLimit) {
  if (!perNovelLimit || perNovelLimit <= 0) return tasks;
  const counts = new Map();
  const result = [];
  for (const task of tasks) {
    const c = counts.get(task.novelKey) || 0;
    if (c >= perNovelLimit) continue;
    counts.set(task.novelKey, c + 1);
    result.push(task);
  }
  return result;
}

async function printDryRun(projectRoot, cfg, state, tasks, opts) {
  console.log(`Config: ${displayPath(projectRoot, cfg.configPath)}`);
  console.log(`Input: ${cfg.inputDir}`);
  console.log(`Output: ${cfg.outputDir}`);
  console.log(`chaptersPerPrompt: ${cfg.chaptersPerPrompt}`);
  if (cfg.chapterRange) {
    const end = cfg.chapterRange.end === Infinity ? '末尾' : cfg.chapterRange.end;
    console.log(`chapterRange: ${cfg.chapterRange.start}-${end}`);
  }
  if (cfg.skipNovelKeys.length > 0) {
    console.log(`skipNovelKeys: ${cfg.skipNovelKeys.join(', ')}`);
  }
  if (cfg.restartNovelKeys.length > 0) {
    console.log(`restartNovelKeys: ${cfg.restartNovelKeys.join(', ')}`);
  }
  if (cfg.freshConversationNovelKeys.length > 0) {
    console.log(`freshConversationNovelKeys: ${cfg.freshConversationNovelKeys.join(', ')}`);
  }
  console.log(`conversationScope: ${cfg.conversationScope}`);
  console.log(`retryMode: ${cfg.retryMode}`);
  console.log(`State: ${displayPath(projectRoot, cfg.stateFile)}`);
  if (opts.perNovelLimit > 0) console.log(`perNovelLimit: ${opts.perNovelLimit}`);

  const novelCount = new Set(tasks.map((task) => task.novelKey)).size;
  console.log(`Novels: ${novelCount}`);

  const allPending = tasks.filter((task) => {
    const item = state.tasks[taskStateKey(task)];
    if (opts.force) return true;
    if (item?.restartRequired === true) return true;
    if (cfg.skipExisting && fssync.existsSync(task.outputPath)) return false;
    return item?.status !== 'done';
  });
  const pending = filterByPerNovelLimit(allPending, opts.perNovelLimit);

  const limitNote = opts.perNovelLimit > 0
    ? ` (per-novel-limit=${opts.perNovelLimit}, 全部 pending ${allPending.length})`
    : '';
  console.log(`Pending tasks: ${pending.length}${limitNote}`);
  for (const task of pending) {
    const item = state.tasks[taskStateKey(task)] || {};
    const status = item.status || 'pending';
    const files = task.inputFiles.map((x) => x.relativePath).join(' + ');
    console.log(
      `- ${task.id} [${status}] novel="${task.novelName}" ${files} -> ${displayPath(projectRoot, task.outputPath)}`,
    );
  }
}

async function main() {
  const opts = parseQueueArgs(process.argv);
  const projectRoot = process.cwd();
  const cfg = await loadQueueConfig(opts.configPath, projectRoot);
  validateQueueConfig(cfg, opts.dryRun);
  try {
    if (!opts.dryRun || opts.resetState) {
      queueLockHandle = await acquireQueueLock(projectRoot, {
        command: 'gpts-queue',
        config: displayPath(projectRoot, cfg.configPath),
        argv: process.argv.slice(2),
      });
    }

    const tasks = await buildTasks(cfg, opts);
    const state = await loadState(cfg, opts);
    const priorCompletedFiles = completedInputFiles(state);
    state.restartedNovelKeys = state.restartedNovelKeys || {};
    state.freshConversationNovelKeys = state.freshConversationNovelKeys || {};
    const restartNovelKeys = new Set(
      cfg.restartNovelKeys.filter((key) => !state.restartedNovelKeys[key]),
    );
    const freshConversationNovelKeys = new Set(
      cfg.freshConversationNovelKeys.filter((key) => !state.freshConversationNovelKeys[key]),
    );
    for (const key of freshConversationNovelKeys) {
      releaseNovelConversation(state, cfg.stage, key);
      if (state.currentNovelKey === key) {
        state.currentTaskId = null;
        state.currentNovelKey = null;
        state.currentConversationUrl = null;
      }
      for (const item of Object.values(state.tasks)) {
        if (item.novelKey === key) {
          item.sent = false;
          item.conversationUrl = '';
        }
      }
    }
    mergeStateTasks(cfg, state, tasks, opts, {
      exists: fssync.existsSync,
      now: nowIso,
      restartNovelKeys,
      preserveExisting: opts.bookFilters.length > 0,
    });
    preserveCompletedInputs(state, tasks, priorCompletedFiles);
    for (const key of restartNovelKeys) state.restartedNovelKeys[key] = nowIso();
    for (const key of freshConversationNovelKeys) state.freshConversationNovelKeys[key] = nowIso();

    // A plain dry run is a read-only preview. --reset-state remains an explicit mutation.
    if (!opts.dryRun || opts.resetState) await saveState(cfg, state);

    if (opts.dryRun) {
      await printDryRun(projectRoot, cfg, state, tasks, opts);
      return;
    }

    await logEvent(cfg, 'run_started', {
      taskCount: tasks.length,
      force: opts.force,
      limit: opts.limit,
      perNovelLimit: opts.perNovelLimit,
      volumeMode: cfg.volumeMode,
    });

    const nextTask = firstRunnableTask(cfg, state, tasks, opts, { exists: fssync.existsSync });
    if (!nextTask) {
      console.log('No pending tasks.');
      await logEvent(cfg, 'run_completed', { success: 0, failed: 0, remaining: 0 });
      return;
    }

    const { chromium } = await loadPlaywright();
    const browser = await chromium.connectOverCDP(cfg.cdpUrl);
    const context = browser.contexts()[0] || (await browser.newContext());
    // Never reuse a user-owned ChatGPT tab. A fresh tab keeps queue navigation
    // and automatic sends isolated from manually opened history conversations.
    const page = await context.newPage();
    queuePage = page;

    let ok = 0;
    let failed = 0;
    let processed = 0;
    // 每个 novelKey 本次运行已处理的 pending 任务数（用于 --per-novel-limit）。
    const perNovelProcessed = new Map();

    try {
      for (const task of tasks) {
        const key = taskStateKey(task);
        const item = state.tasks[key];
        const outputExists = fssync.existsSync(task.outputPath);
        const restartRequired = item.restartRequired === true;
        if (!restartRequired && !opts.force && cfg.skipExisting && outputExists) continue;
        if (item.status === 'done' && !opts.force && !restartRequired) continue;

        // --per-novel-limit 限制单个 novelKey 本次运行处理的 pending 任务数。
        // 已 done/skip 的任务不计入；超出配额的 novelKey 的后续章节直接跳过。
        if (opts.perNovelLimit > 0) {
          const npc = perNovelProcessed.get(task.novelKey) || 0;
          if (npc >= opts.perNovelLimit) continue;
        }

        // --limit bounds the number of pending tasks processed in a single run,
        // not the size of the task list. Stop before starting a task that would
        // exceed the budget so currentTaskId stays clean.
        if (opts.limit > 0 && processed >= opts.limit) {
          console.log(`\nReached --limit ${opts.limit}; stopping run with ${ok} done, ${failed} failed.`);
          break;
        }
        processed++;
        if (opts.perNovelLimit > 0) {
          perNovelProcessed.set(task.novelKey, (perNovelProcessed.get(task.novelKey) || 0) + 1);
        }

        state.currentTaskId = task.id;
        state.currentNovelKey = task.novelKey;
        await saveState(cfg, state);

        const files = task.inputFiles.map((x) => x.relativePath).join(' + ');
        console.log(`\n[${task.index + 1}/${tasks.length}] ${task.id} novel="${task.novelName}" ${files}`);
        try {
          const chars = await processTask(page, cfg, state, task, item);
          ok++;
          state.currentTaskId = null;
          await saveState(cfg, state);
          console.log(`  OK -> ${displayPath(projectRoot, task.outputPath)} (${chars} chars)`);
        } catch (err) {
          failed++;
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`  FAIL: ${msg}`);
          console.error('  Queue stopped at this task. Fix/retry this task before later tasks run.');
          process.exitCode = 1;
          break;
        }

        if (Number(cfg.betweenItemsMs || 0) > 0) {
          await page.waitForTimeout(Number(cfg.betweenItemsMs));
        }
      }
    } finally {
      if (!page.isClosed()) await page.close().catch(() => {});
      if (queuePage === page) queuePage = null;
      await browser.close();
    }

    const remaining = tasks.filter((task) => {
      const item = state.tasks[taskStateKey(task)];
      return item?.status !== 'done';
    }).length;
    console.log(`\nDone: success ${ok}, failed ${failed}, remaining ${remaining}`);
    await logEvent(cfg, 'run_completed', { success: ok, failed, remaining, processed });
  } finally {
    await releaseQueueLock(queueLockHandle);
    queueLockHandle = null;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
