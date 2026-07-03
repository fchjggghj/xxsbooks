import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_CONFIG = {
  cdpUrl: 'http://127.0.0.1:9222',
  gptUrl: 'https://chatgpt.com/g/your-gpts-id',
  inputDir: 'input',
  outputDir: 'output',
  fileExtensions: ['.txt', '.md'],
  recursive: true,
  skipExisting: true,
  outputExtension: '.md',
  promptPrefixFile: '',
  promptTemplate: '{{content}}',
  chaptersPerPrompt: 1,
  conversationScope: 'novel',
  retryMode: 'edit-and-resend',
  maxRetries: 2,
  waitReplyTimeoutMs: 180000,
  replyStableMs: 2500,
  maxStableGeneratingMs: 45000,
  betweenItemsMs: 2000,
  minReplyChars: 80,
  includeFileHeaders: false,
  stateFile: '',
  logFile: '',
};

const COMPOSER_SELECTORS = [
  '#prompt-textarea',
  '[data-testid="prompt-textarea"]',
  'div[contenteditable="true"][role="textbox"]',
  'div[contenteditable="true"]',
  'textarea',
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

function parseArgs(argv) {
  const out = {
    configPath: 'config.json',
    dryRun: false,
    force: false,
    limit: 0,
    resetState: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--force') out.force = true;
    else if (arg === '--reset-state') out.resetState = true;
    else if (arg === '--config') out.configPath = argv[++i] || out.configPath;
    else if (arg === '--limit') out.limit = Number(argv[++i] || 0);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return out;
}

function resolveFromRoot(projectRoot, value) {
  const s = String(value || '').trim();
  if (!s) return projectRoot;
  return path.isAbsolute(s) ? s : path.join(projectRoot, s);
}

async function readJson(file) {
  const raw = await fs.readFile(file, 'utf8');
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
}

async function loadConfig(configPath, projectRoot) {
  const fullPath = resolveFromRoot(projectRoot, configPath);
  if (!fssync.existsSync(fullPath)) {
    throw new Error(`Config file not found: ${fullPath}`);
  }

  const raw = await readJson(fullPath);
  const cfg = { ...DEFAULT_CONFIG, ...raw };
  cfg.configPath = fullPath;
  cfg.configName = path.basename(fullPath, path.extname(fullPath));
  cfg.inputDir = resolveFromRoot(projectRoot, cfg.inputDir);
  cfg.outputDir = resolveFromRoot(projectRoot, cfg.outputDir);
  cfg.fileExtensions = (cfg.fileExtensions || ['.txt', '.md']).map((x) =>
    String(x).toLowerCase(),
  );
  cfg.outputExtension = String(cfg.outputExtension || '.md').startsWith('.')
    ? String(cfg.outputExtension || '.md')
    : `.${cfg.outputExtension}`;
  cfg.chaptersPerPrompt = Math.max(1, Number(cfg.chaptersPerPrompt || 1));
  cfg.conversationScope = String(cfg.conversationScope || 'novel');
  cfg.maxRetries = Math.max(0, Number(cfg.maxRetries || 0));
  cfg.stateFile = cfg.stateFile
    ? resolveFromRoot(projectRoot, cfg.stateFile)
    : path.join(cfg.outputDir, '.gpts-queue-state.json');
  cfg.logFile = cfg.logFile
    ? resolveFromRoot(projectRoot, cfg.logFile)
    : path.join(cfg.outputDir, '.gpts-queue.log');
  if (cfg.promptPrefixFile) {
    cfg.promptPrefixFile = resolveFromRoot(projectRoot, cfg.promptPrefixFile);
    const prefix = (await fs.readFile(cfg.promptPrefixFile, 'utf8')).replace(/^\uFEFF/, '').trim();
    cfg.promptTemplate = `${prefix}\n\n${String(cfg.promptTemplate || '{{content}}')}`;
  }
  return cfg;
}

function validateConfig(cfg, dryRun) {
  const errors = [];
  if (!String(cfg.gptUrl || '').startsWith('https://chatgpt.com/g/')) {
    errors.push('gptUrl must be a ChatGPT GPTS URL, for example https://chatgpt.com/g/...');
  }
  if (!String(cfg.cdpUrl || '').startsWith('http')) {
    errors.push('cdpUrl must be a Chrome debugging URL, for example http://127.0.0.1:9222');
  }
  if (!cfg.inputDir) errors.push('inputDir cannot be empty');
  if (!cfg.outputDir) errors.push('outputDir cannot be empty');
  if (!String(cfg.promptTemplate || '').includes('{{content}}')) {
    errors.push('promptTemplate must include {{content}}');
  }
  if (!dryRun && String(cfg.gptUrl).includes('your-gpts-id')) {
    errors.push('Please put the real GPTS URL in the config before running.');
  }
  if (!['edit-and-resend', 'resend'].includes(String(cfg.retryMode))) {
    errors.push('retryMode must be "edit-and-resend" or "resend"');
  }
  if (cfg.conversationScope !== 'novel') {
    errors.push('conversationScope must be "novel"');
  }
  if (errors.length) throw new Error(errors.join('\n'));
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function atomicWrite(file, text) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, file);
}

async function appendLog(cfg, line) {
  await ensureDir(path.dirname(cfg.logFile));
  await fs.appendFile(cfg.logFile, `${new Date().toISOString()} ${line}\n`, 'utf8');
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
  if (task.inputFiles.length === 1) {
    const parsed = path.parse(task.inputFiles[0].relativePath);
    return path.join(cfg.outputDir, parsed.dir, `${parsed.name}${cfg.outputExtension}`);
  }

  const first = sanitizeFileName(path.parse(task.inputFiles[0].relativePath).name);
  const last = sanitizeFileName(path.parse(task.inputFiles.at(-1).relativePath).name);
  const novelDir = task.hasNovelFolder ? task.novelName : '';
  return path.join(cfg.outputDir, novelDir, `${task.localId}__${first}__to__${last}${cfg.outputExtension}`);
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

async function buildTasks(cfg, opts) {
  await ensureDir(cfg.inputDir);
  await ensureDir(cfg.outputDir);

  const files = await walkFiles(cfg.inputDir, cfg.recursive, cfg.fileExtensions);
  const novels = new Map();
  for (const file of files) {
    const novel = fileNovelInfo(file);
    if (!novels.has(novel.novelKey)) novels.set(novel.novelKey, { ...novel, files: [] });
    novels.get(novel.novelKey).files.push(file);
  }

  const tasks = [];
  for (const novel of novels.values()) {
    for (let i = 0; i < novel.files.length; i += cfg.chaptersPerPrompt) {
      const group = novel.files.slice(i, i + cfg.chaptersPerPrompt);
      const localId = taskIdFor(i, group);
      const task = {
        id: `${novel.novelKey}:${localId}`,
        localId,
        index: tasks.length,
        novelKey: novel.novelKey,
        novelName: novel.novelName,
        hasNovelFolder: novel.hasNovelFolder,
        inputFiles: group,
        outputPath: '',
      };
      task.outputPath = outputPathForTask(cfg, task);
      tasks.push(task);
      if (opts.limit > 0 && tasks.length >= opts.limit) return tasks;
    }
  }

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
      version: 3,
      configName: cfg.configName,
      currentTaskId: null,
      currentNovelKey: null,
      currentConversationUrl: '',
      novelConversations: {},
      tasks: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
  }

  const state = await readJson(cfg.stateFile);
  state.version = 3;
  state.configName = state.configName || cfg.configName;
  state.currentTaskId = state.currentTaskId || null;
  state.currentNovelKey = state.currentNovelKey || null;
  state.currentConversationUrl = state.currentConversationUrl || '';
  state.novelConversations = state.novelConversations || {};
  state.tasks = state.tasks || {};
  delete state.conversationPromptCount;
  return state;
}

async function saveState(cfg, state) {
  state.updatedAt = nowIso();
  await atomicWrite(cfg.stateFile, JSON.stringify(state, null, 2) + '\n');
}

function taskStateKey(task) {
  return task.id;
}

function mergeStateTasks(cfg, state, tasks, opts) {
  const next = {};
  for (const task of tasks) {
    const key = taskStateKey(task);
    const previous = state.tasks[key] || {};
    const outputExists = fssync.existsSync(task.outputPath);
    const status = !opts.force && cfg.skipExisting && outputExists ? 'done' : previous.status || 'pending';

    next[key] = {
      ...previous,
      id: task.id,
      localId: task.localId,
      index: task.index,
      novelKey: task.novelKey,
      novelName: task.novelName,
      inputFiles: task.inputFiles.map((x) => x.relativePath),
      outputFile: task.outputPath,
      status: opts.force && status === 'done' ? 'pending' : status,
      retries: Number(previous.retries || 0),
      lastError: previous.lastError || '',
      sent: previous.sent === true,
      conversationUrl: previous.conversationUrl || '',
      updatedAt: previous.updatedAt || nowIso(),
    };
  }
  state.tasks = next;
}

function firstRunnableTask(cfg, state, tasks, opts) {
  for (const task of tasks) {
    const item = state.tasks[taskStateKey(task)];
    if (!item) return task;
    if (!opts.force && cfg.skipExisting && fssync.existsSync(task.outputPath)) continue;
    if (item.status !== 'done') return task;
  }
  return null;
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
    return await page.locator(ASSISTANT_SELECTOR).allTextContents();
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

async function ensureNovelConversation(page, cfg, state, task, taskState, useFailedConversation) {
  const failedConversationUrl = useFailedConversation ? taskState.conversationUrl : '';
  const savedNovelUrl = state.novelConversations[task.novelKey] || '';
  const targetUrl = failedConversationUrl || savedNovelUrl;

  if (!targetUrl) {
    await openNewConversation(page, cfg);
    state.currentConversationUrl = page.url();
    state.currentNovelKey = task.novelKey;
    state.novelConversations[task.novelKey] = page.url();
    return;
  }

  if (page.url() !== targetUrl) {
    await openExistingConversation(page, targetUrl);
  } else {
    await closeOverlays(page);
    await firstComposer(page, 90000);
  }

  state.currentConversationUrl = targetUrl;
  state.currentNovelKey = task.novelKey;
  state.novelConversations[task.novelKey] = targetUrl;
}

async function setEditableText(page, locator, text) {
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
}

async function insertPrompt(page, prompt) {
  const composer = await firstComposer(page, 90000);
  await setEditableText(page, composer, prompt);
}

async function clickSend(page) {
  // 发送按钮在文本刚插入时可能仍处于 disabled，需要等待框架识别输入并启用按钮。
  const tryClickButton = async () => {
    for (const selector of SEND_BUTTON_SELECTORS) {
      try {
        const button = page.locator(selector).last();
        if ((await button.count()) > 0 && (await button.isVisible())) {
          // 显式等按钮 enabled（最多 8 秒），insertText 后按钮启用有延迟。
          try {
            await button.waitFor({ state: 'attached', timeout: 1000 });
            const enabled = await button.isEnabled();
            if (enabled) {
              await button.click();
              return true;
            }
            continue;
          } catch {
            continue;
          }
        }
      } catch {
        // Try the next selector.
      }
    }
    return false;
  };

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await tryClickButton()) {
      // 点击后等待输入框清空（发送成功的标志），最多等 3 秒。
      await page.waitForTimeout(500);
      const cleared = await page.evaluate(() => {
        const el = document.querySelector('#prompt-textarea') || document.querySelector('div[contenteditable="true"][role="textbox"]');
        return !el || (el.textContent || '').trim().length === 0;
      });
      if (cleared) return;
      // 输入框未清空，说明发送未生效，继续重试。
    }
    await page.waitForTimeout(300);
  }

  // Fallback：先聚焦输入框再按 Enter。
  try {
    const composer = await firstComposer(page, 2000);
    await composer.click();
    await page.keyboard.press('Enter');
  } catch {
    await page.keyboard.press('Enter');
  }
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

  if (lastText.trim()) return lastText.trim();
  throw new Error('Timed out waiting for GPTS reply.');
}

async function readTaskContent(cfg, task) {
  const parts = [];
  for (const item of task.inputFiles) {
    const content = await fs.readFile(item.inputPath, 'utf8');
    if (cfg.includeFileHeaders || task.inputFiles.length > 1) {
      parts.push(`===== ${item.relativePath} =====\n${content}`);
    } else {
      parts.push(content);
    }
  }
  return parts.join('\n\n');
}

function renderPrompt(template, task, content) {
  return String(template)
    .replaceAll('{{content}}', content)
    .replaceAll('{{taskId}}', task.id)
    .replaceAll('{{localTaskId}}', task.localId)
    .replaceAll('{{novelName}}', task.novelName)
    .replaceAll('{{novelKey}}', task.novelKey)
    .replaceAll('{{chapterCount}}', String(task.inputFiles.length))
    .replaceAll('{{filename}}', path.basename(task.inputFiles[0].inputPath))
    .replaceAll('{{relativePath}}', task.inputFiles[0].relativePath)
    .replaceAll('{{filenames}}', task.inputFiles.map((x) => path.basename(x.inputPath)).join('\n'))
    .replaceAll('{{relativePaths}}', task.inputFiles.map((x) => x.relativePath).join('\n'));
}

async function sendOrEdit(page, cfg, task, prompt, method) {
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
  return waitForReply(page, beforeTexts, cfg);
}

async function processTask(page, cfg, state, task, taskState) {
  const content = await readTaskContent(cfg, task);
  const prompt = renderPrompt(cfg.promptTemplate, task, content);
  const useEditFirst =
    cfg.retryMode === 'edit-and-resend' &&
    taskState.status === 'failed' &&
    taskState.sent === true &&
    taskState.conversationUrl;

  await ensureNovelConversation(page, cfg, state, task, taskState, useEditFirst);
  await saveState(cfg, state);

  const attempts = cfg.maxRetries + 1;
  let lastError = '';

  for (let attempt = 0; attempt < attempts; attempt++) {
    const method =
      attempt === 0 && useEditFirst
        ? 'edit-and-resend'
        : attempt > 0 && cfg.retryMode === 'edit-and-resend' && taskState.sent
          ? 'edit-and-resend'
          : 'send';

    try {
      taskState.status = 'running';
      taskState.currentAttempt = attempt + 1;
      taskState.sent = method === 'edit-and-resend' ? taskState.sent : true;
      taskState.conversationUrl = state.currentConversationUrl || page.url();
      taskState.updatedAt = nowIso();
      await saveState(cfg, state);
      await appendLog(cfg, `TASK ${task.id} attempt=${attempt + 1} method=${method}`);

      const reply = await sendOrEdit(page, cfg, task, prompt, method);
      await atomicWrite(task.outputPath, reply.trim() + '\n');
      await fs.rm(`${task.outputPath}.error.txt`, { force: true });

      state.currentConversationUrl = page.url();
      state.currentNovelKey = task.novelKey;
      state.novelConversations[task.novelKey] = page.url();

      taskState.status = 'done';
      taskState.retries = Number(taskState.retries || 0) + attempt;
      taskState.lastError = '';
      taskState.outputFile = task.outputPath;
      taskState.conversationUrl = page.url();
      taskState.doneAt = nowIso();
      taskState.updatedAt = nowIso();
      await saveState(cfg, state);
      await appendLog(cfg, `TASK ${task.id} done output=${task.outputPath}`);
      return reply.length;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      taskState.status = 'failed';
      taskState.lastError = lastError;
      taskState.retries = Number(taskState.retries || 0) + 1;
      taskState.sent = true;
      taskState.conversationUrl = page.url();
      taskState.updatedAt = nowIso();
      state.currentTaskId = task.id;
      state.currentNovelKey = task.novelKey;
      state.currentConversationUrl = page.url();
      state.novelConversations[task.novelKey] = page.url();
      await saveState(cfg, state);
      await appendLog(cfg, `TASK ${task.id} failed attempt=${attempt + 1} error=${lastError}`);

      if (attempt + 1 >= attempts) {
        await atomicWrite(`${task.outputPath}.error.txt`, `${lastError}\n`);
        throw new Error(lastError);
      }

      await page.waitForTimeout(Math.max(1000, Number(cfg.betweenItemsMs || 0)));
    }
  }

  throw new Error(lastError || 'Task failed.');
}

function displayPath(projectRoot, file) {
  return path.relative(projectRoot, file) || '.';
}

async function printDryRun(projectRoot, cfg, state, tasks, opts) {
  console.log(`Config: ${displayPath(projectRoot, cfg.configPath)}`);
  console.log(`Input: ${cfg.inputDir}`);
  console.log(`Output: ${cfg.outputDir}`);
  console.log(`chaptersPerPrompt: ${cfg.chaptersPerPrompt}`);
  console.log(`conversationScope: ${cfg.conversationScope}`);
  console.log(`retryMode: ${cfg.retryMode}`);
  console.log(`State: ${displayPath(projectRoot, cfg.stateFile)}`);

  const novelCount = new Set(tasks.map((task) => task.novelKey)).size;
  console.log(`Novels: ${novelCount}`);

  const pending = tasks.filter((task) => {
    const item = state.tasks[taskStateKey(task)];
    return opts.force || !(cfg.skipExisting && fssync.existsSync(task.outputPath)) || item?.status === 'failed';
  });

  console.log(`Pending tasks: ${pending.length}`);
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
  const opts = parseArgs(process.argv);
  const projectRoot = process.cwd();
  const cfg = await loadConfig(opts.configPath, projectRoot);
  validateConfig(cfg, opts.dryRun);

  const tasks = await buildTasks(cfg, opts);
  const state = await loadState(cfg, opts);
  mergeStateTasks(cfg, state, tasks, opts);
  await saveState(cfg, state);

  if (opts.dryRun) {
    await printDryRun(projectRoot, cfg, state, tasks, opts);
    return;
  }

  const nextTask = firstRunnableTask(cfg, state, tasks, opts);
  if (!nextTask) {
    console.log('No pending tasks.');
    return;
  }

  const { chromium } = await loadPlaywright();
  const browser = await chromium.connectOverCDP(cfg.cdpUrl);
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = context.pages().find((p) => p.url().startsWith('https://chatgpt.com/')) || (await context.newPage());

  let ok = 0;
  let failed = 0;

  try {
    for (const task of tasks) {
      const key = taskStateKey(task);
      const item = state.tasks[key];
      const outputExists = fssync.existsSync(task.outputPath);
      if (!opts.force && cfg.skipExisting && outputExists) continue;
      if (item.status === 'done' && !opts.force) continue;

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
    await browser.close();
  }

  const remaining = tasks.filter((task) => {
    const item = state.tasks[taskStateKey(task)];
    return item?.status !== 'done';
  }).length;
  console.log(`\nDone: success ${ok}, failed ${failed}, remaining ${remaining}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
