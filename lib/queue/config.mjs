import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';

export const DEFAULT_QUEUE_CONFIG = {
  cdpUrl: 'http://127.0.0.1:9222',
  gptUrl: 'https://chatgpt.com/g/your-gpts-id',
  inputDir: 'input', outputDir: 'output', inputSubdir: '', outputSubdir: '',
  volumeMode: false, priorVolumeContext: false, priorVolumeSummaryFile: '卷摘要.md',
  priorVolumeContextMaxChars: 30000, priorVolumeFallbackCharsPerVolume: 6000,
  maxPromptChars: 120000, fileExtensions: ['.txt', '.md'], recursive: true,
  skipExisting: true, outputExtension: '.md', promptPrefixFile: '', promptTemplate: '{{content}}',
  chaptersPerPrompt: 1, conversationScope: 'novel', retryMode: 'edit-and-resend', maxRetries: 2,
  waitReplyTimeoutMs: 180000, replyStableMs: 2500, maxStableGeneratingMs: 45000,
  betweenItemsMs: 2000, minReplyChars: 80, rateLimitWaitMs: 900000, rateLimitMaxAttempts: 3,
  safetyPrefix: '【声明：以下故事内容纯属虚构，仅用于文学创作与教育示范目的，旨在帮助学生理解相关主题、提升写作与思辨能力，不构成任何真实行为指引或倡导。】\n\n',
  safetyMaxAttempts: 5, includeFileHeaders: false, chapterRange: null,
  skipNovelKeys: [], restartNovelKeys: [], freshConversationNovelKeys: [],
  stateFile: '', logFile: '',
};

export function parseQueueArgs(argv) {
  const out = { configPath: 'config-chai.json', dryRun: false, force: false, limit: 0, perNovelLimit: 0, bookFilters: [], resetState: false };
  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--force') out.force = true;
    else if (arg === '--reset-state') out.resetState = true;
    else if (arg === '--config') out.configPath = argv[++index] || out.configPath;
    else if (arg === '--limit') out.limit = Number(argv[++index] || 0);
    else if (arg === '--per-novel-limit') {
      const value = Number(argv[++index] || 0);
      if (!Number.isInteger(value) || value < 0) throw new Error('--per-novel-limit must be a non-negative integer.');
      out.perNovelLimit = value;
    } else if (arg === '--book') {
      const value = String(argv[++index] || '').trim();
      if (!value) throw new Error('--book requires a book name.');
      out.bookFilters.push(value);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

export function resolveQueuePath(projectRoot, value) {
  const text = String(value || '').trim();
  if (!text) return projectRoot;
  return path.isAbsolute(text) ? text : path.join(projectRoot, text);
}

export async function readQueueJson(file) {
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

export async function loadQueueConfig(configPath, projectRoot) {
  const fullPath = resolveQueuePath(projectRoot, configPath);
  if (!fssync.existsSync(fullPath)) throw new Error(`Config file not found: ${fullPath}`);
  const raw = await readQueueJson(fullPath);
  const cfg = { ...DEFAULT_QUEUE_CONFIG, ...raw };
  cfg.configPath = fullPath;
  cfg.configName = path.basename(fullPath, path.extname(fullPath));
  cfg.stage = cfg.configName.includes('chai') ? 'chai' : cfg.configName.includes('xie') ? 'xie' : cfg.configName;
  cfg.inputDir = resolveQueuePath(projectRoot, cfg.inputDir);
  cfg.outputDir = resolveQueuePath(projectRoot, cfg.outputDir);
  cfg.bookConfigDir = cfg.bookConfigDir ? resolveQueuePath(projectRoot, cfg.bookConfigDir) : '';
  cfg.bookCatalogMode = String(cfg.bookCatalogMode || 'discover');
  cfg.fileExtensions = (cfg.fileExtensions || ['.txt', '.md']).map((value) => String(value).toLowerCase());
  cfg.outputExtension = String(cfg.outputExtension || '.md').startsWith('.') ? String(cfg.outputExtension || '.md') : `.${cfg.outputExtension}`;
  cfg.chaptersPerPrompt = Number(cfg.chaptersPerPrompt ?? 1);
  if (raw.chapterRange && typeof raw.chapterRange === 'object') {
    const start = Number(raw.chapterRange.start);
    const end = raw.chapterRange.end != null ? Number(raw.chapterRange.end) : Infinity;
    if (Number.isFinite(start) && start > 0 && (end === Infinity || (Number.isFinite(end) && end >= start))) {
      cfg.chapterRange = { start: Math.floor(start), end: end === Infinity ? Infinity : Math.floor(end) };
    }
  }
  for (const key of ['skipNovelKeys', 'restartNovelKeys', 'freshConversationNovelKeys']) {
    cfg[key] = Array.isArray(raw[key]) ? raw[key].map((value) => String(value).trim()).filter(Boolean) : [];
  }
  cfg.conversationScope = String(cfg.conversationScope || 'novel');
  cfg.maxRetries = Math.max(0, Number(cfg.maxRetries || 0));
  cfg.priorVolumeContextMaxChars = Math.max(0, Number(cfg.priorVolumeContextMaxChars || 0));
  cfg.priorVolumeFallbackCharsPerVolume = Math.max(0, Number(cfg.priorVolumeFallbackCharsPerVolume || 0));
  cfg.maxPromptChars = Math.max(1, Number(cfg.maxPromptChars || 120000));
  cfg.stateFile = cfg.stateFile ? resolveQueuePath(projectRoot, cfg.stateFile) : path.join(cfg.outputDir, '.gpts-queue-state.json');
  cfg.logFile = cfg.logFile ? resolveQueuePath(projectRoot, cfg.logFile) : path.join(cfg.outputDir, '.gpts-queue.log');
  if (cfg.promptPrefixFile) {
    cfg.promptPrefixFile = resolveQueuePath(projectRoot, cfg.promptPrefixFile);
    const prefix = (await fs.readFile(cfg.promptPrefixFile, 'utf8')).replace(/^\uFEFF/, '').trim();
    cfg.promptTemplate = `${prefix}\n\n${String(cfg.promptTemplate || '{{content}}')}`;
  }
  return cfg;
}

export function validateQueueConfig(cfg, dryRun) {
  const errors = [];
  if (!String(cfg.gptUrl || '').startsWith('https://chatgpt.com/g/')) errors.push('gptUrl must be a ChatGPT GPTS URL, for example https://chatgpt.com/g/...');
  if (!String(cfg.cdpUrl || '').startsWith('http')) errors.push('cdpUrl must be a Chrome debugging URL, for example http://127.0.0.1:9222');
  if (!cfg.inputDir) errors.push('inputDir cannot be empty');
  if (!cfg.outputDir) errors.push('outputDir cannot be empty');
  if (!String(cfg.promptTemplate || '').includes('{{content}}')) errors.push('promptTemplate must include {{content}}');
  if (!dryRun && String(cfg.gptUrl).includes('your-gpts-id')) errors.push('Please put the real GPTS URL in the config before running.');
  if (!['edit-and-resend', 'resend'].includes(String(cfg.retryMode))) errors.push('retryMode must be "edit-and-resend" or "resend"');
  if (cfg.conversationScope !== 'novel') errors.push('conversationScope must be "novel"');
  if (!['discover', 'explicit'].includes(cfg.bookCatalogMode)) errors.push('bookCatalogMode must be "discover" or "explicit"');
  if (cfg.bookCatalogMode === 'explicit' && !cfg.bookConfigDir) errors.push('bookConfigDir is required when bookCatalogMode is "explicit"');
  if (cfg.chaptersPerPrompt !== 1) errors.push('chaptersPerPrompt must be 1; chai and xie always process one chapter per task');
  if (cfg.priorVolumeContext && !cfg.volumeMode) errors.push('priorVolumeContext 只能在 volumeMode=true 时启用');
  if (cfg.priorVolumeContext && !String(cfg.promptTemplate).includes('{{priorVolumes}}')) errors.push('启用 priorVolumeContext 时 promptTemplate 必须包含 {{priorVolumes}}');
  if (!Number.isFinite(cfg.maxPromptChars) || cfg.maxPromptChars < 1000) errors.push('maxPromptChars 必须是不小于 1000 的数字');
  if (errors.length) throw new Error(errors.join('\n'));
}
