/**
 * 控制动作 + ChatGPT 工作台操作
 *
 * stop/resume/startTask/stopTask/launchChrome/rescan/dryRun/retry/retryAll/openFolder
 * ChatGPT 工作台操作（简化版：保留基本状态查询）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import type { ApiResult } from './types.js';
import {
  PATHS,
  cdpPort,
  getConfig,
  reloadConfig,
  saveConfig as saveConfigFile,
  taskName,
  saveTaskConfig,
  reloadTaskConfig,
  getTaskScanConfig,
} from './config.js';
import { invalidateCaches, getScan, getScanForTask } from './scanner.js';
import { loadQueueStore, getQueueProfile } from './queue.js';
import { connect, inspectPageState } from '@novel-pipeline/shared';
import type { Page } from 'playwright-core';

// ---------- 进程/任务管理工具 ----------

/** 运行 schtasks 命令 */
function runSchtasks(args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile('schtasks', args, { windowsHide: true }, (err, out, errout) => {
      resolve({ ok: !err, out: (out || '') + (errout || '') });
    });
  });
}

/** 分离式启动进程 */
function spawnDetached(
  cmd: string,
  args: string[],
  opts: Parameters<typeof spawn>[2] = {},
): boolean {
  try {
    const p = spawn(cmd, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      ...opts,
    });
    p.unref();
    return true;
  } catch {
    return false;
  }
}

/** 查找 Chrome 可执行文件 */
function findChrome(): string | null {
  const cands = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  return cands.find((c) => fs.existsSync(c)) || null;
}

/** 运行 Node 脚本 */
function nodeRun(args: string[]): Promise<{ ok: boolean; out: string; err?: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      args,
      {
        cwd: PATHS.runnerDir,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        timeout: 180000,
      },
      (err, out, errout) => {
        resolve({
          ok: !err,
          out: (out || '') + (errout || ''),
          err: err?.message,
        });
      },
    );
  });
}

// ---------- 控制动作 ----------

type Body = Record<string, unknown>;

/** 执行控制动作 */
export async function doControl(action: string, body: Body): Promise<ApiResult> {
  const cfg = getConfig();
  switch (action) {
    case 'stop':
      fs.writeFileSync(PATHS.stopFile, new Date().toISOString());
      return { ok: true, msg: '已写 STOP：runner 跑完当前章后退出。' };
    case 'resume': {
      try {
        if (fs.existsSync(PATHS.stopFile)) fs.unlinkSync(PATHS.stopFile);
      } catch {
        /* ignore */
      }
      const r = await runSchtasks(['/Run', '/TN', taskName()]);
      return {
        ok: true,
        msg: r.ok
          ? '已删 STOP 并启动计划任务。'
          : `已删 STOP；启动计划任务失败：${r.out.trim() || '未知'}`,
      };
    }
    case 'startTask': {
      const r = await runSchtasks(['/Run', '/TN', taskName()]);
      return {
        ok: r.ok,
        msg: r.ok ? '已启动守护计划任务。' : r.out.trim() || '启动失败',
      };
    }
    case 'stopTask': {
      const r = await runSchtasks(['/End', '/TN', taskName()]);
      return {
        ok: r.ok,
        msg: r.ok ? '已停止守护计划任务的当前实例。' : r.out.trim() || '停止失败',
      };
    }
    case 'launchChrome': {
      const chrome = findChrome();
      if (!chrome)
        return { ok: false, msg: '未找到 chrome.exe（改 launch-chrome.ps1 里的路径）。' };
      const ok = spawnDetached(
        chrome,
        [
          `--remote-debugging-port=${cdpPort()}`,
          '--user-data-dir=C:\\chrome-automation',
          cfg.gptUrl || 'https://chatgpt.com/',
        ],
        { windowsHide: false },
      );
      return {
        ok,
        msg: ok
          ? `已启动执行浏览器（端口 ${cdpPort()}）。首次需在该窗口完成目标页面登录。`
          : '启动 Chrome 失败。',
      };
    }
    case 'rescan':
      invalidateCaches();
      await getScan(true);
      return { ok: true, msg: '已重新扫描素材库。' };
    case 'dryRun': {
      const r = await nodeRun([
        path.join(PATHS.projectRoot, 'packages', 'runners', 'dist', 'outline-runner.js'),
        '--dry-run',
      ]);
      return {
        ok: r.ok,
        msg: r.ok ? '干跑完成。' : '干跑出错：' + (r.err || ''),
        out: r.out,
      };
    }
    case 'retry': {
      const p = String(body.outputPath || '');
      const taskId = String(body.task || 'outline');
      const scanCfg = getTaskScanConfig(taskId);
      // 路径合法性：必须在任务输出根下
      const validRoots = [scanCfg.outputRoot, scanCfg.inputRoot].filter(Boolean);
      const valid = validRoots.some((r) => p.startsWith(r));
      if (!p || !valid) return { ok: false, msg: '路径不合法' };
      try {
        const skipFile = p + '.skip.json';
        if (fs.existsSync(skipFile)) fs.unlinkSync(skipFile);
      } catch (e) {
        return { ok: false, msg: e instanceof Error ? e.message : String(e) };
      }
      invalidateCaches();
      getScanForTask(taskId, true).catch(() => {});
      if (taskId === 'outline') getScan(true).catch(() => {});
      return { ok: true, msg: '已删除失败标记，断点续传将重做该章。' };
    }
    case 'retryAll': {
      const taskId = String(body.task || 'outline');
      const scan = await getScanForTask(taskId, true);
      let n = 0;
      for (const f of scan.failures) {
        try {
          const skipFile = f.outputPath + '.skip.json';
          if (fs.existsSync(skipFile)) {
            fs.unlinkSync(skipFile);
            n++;
          }
        } catch {
          /* ignore */
        }
      }
      invalidateCaches();
      getScanForTask(taskId, true).catch(() => {});
      if (taskId === 'outline') getScan(true).catch(() => {});
      return { ok: true, msg: `已清除 ${n} 个失败标记，断点续传将重做。` };
    }
    case 'openFolder': {
      const p = String(body.path || cfg.libraryRoot || '');
      if (!p) return { ok: false, msg: '无路径' };
      spawnDetached('explorer.exe', [p]);
      return { ok: true, msg: '已在资源管理器打开。' };
    }
    default:
      return { ok: false, msg: '未知动作: ' + action };
  }
}

// ---------- 配置保存 ----------

/** 保存配置（包装 config.ts 的 saveConfig，附带缓存失效） */
export function saveConfigRoute(next: unknown): ApiResult {
  const result = saveConfigFile(next);
  if (result.ok) {
    reloadConfig();
    invalidateCaches();
    getScan(true).catch(() => {});
  }
  return result;
}

/** 保存指定任务的配置（多任务版） */
export function saveConfigRouteForTask(taskId: string, next: unknown): ApiResult {
  if (taskId === 'outline') {
    // outline 用原有逻辑（保持向后兼容）
    return saveConfigRoute(next);
  }
  // adapt/generate 用新的多任务配置保存
  const result = saveTaskConfig(taskId, next);
  if (result.ok) {
    reloadTaskConfig(taskId);
    invalidateCaches();
  }
  return result;
}

// ---------- ChatGPT 工作台（简化版） ----------

/** 判断是否允许的 ChatGPT URL */
function isAllowedChatGptUrl(raw: string): boolean {
  try {
    const u = new URL(String(raw || ''));
    const host = u.hostname.toLowerCase();
    return (
      (u.protocol === 'https:' || u.protocol === 'http:') &&
      (host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'chat.openai.com')
    );
  } catch {
    return false;
  }
}

/** 获取 ChatGPT 页面 */
async function getChatGptPage(): Promise<Page> {
  const cfg = getConfig();
  const browser = await connect({ cdpUrl: cfg.cdpUrl });
  const context = browser.contexts()[0];
  if (!context) {
    throw new Error('CDP 已连接，但没有浏览器上下文。确认 Chrome 是用调试端口启动的。');
  }
  const pages = context.pages();
  const page =
    pages.find((p) => p.url().includes('chatgpt.com')) ||
    pages.find((p) => p.url().includes('chat.openai.com')) ||
    pages[0] ||
    (await context.newPage());
  return page;
}

/** 页面状态快照 */
async function pageState(page: Page): Promise<{
  url: string;
  loggedIn: boolean;
  generating: boolean;
  assistantCount: number;
  hasComposer: boolean;
}> {
  try {
    return await inspectPageState(page);
  } catch {
    return {
      url: page.url(),
      loggedIn: false,
      generating: false,
      assistantCount: 0,
      hasComposer: false,
    };
  }
}

/** ChatGPT 工作台快照 */
export async function chatGptWorkbenchSnapshot(): Promise<ApiResult> {
  try {
    const page = await getChatGptPage();
    const state = await pageState(page);
    return { ok: true, state };
  } catch (e) {
    return {
      ok: false,
      msg: e instanceof Error ? e.message : String(e),
    };
  }
}

/** 处理 ChatGPT 动作（简化版） */
export async function handleChatGptAction(body: Body = {}): Promise<ApiResult> {
  const action = String(body.action || '');
  try {
    const page = await getChatGptPage();

    if (action === 'refresh') {
      return { ok: true, state: await pageState(page) };
    }

    if (action === 'reloadPage') {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      return { ok: true, state: await pageState(page) };
    }

    if (action === 'back') {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
      return { ok: true, state: await pageState(page) };
    }

    if (action === 'forward') {
      await page.goForward({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
      return { ok: true, state: await pageState(page) };
    }

    if (action === 'openHome' || action === 'newChat') {
      await page.goto('https://chatgpt.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      return { ok: true, state: await pageState(page) };
    }

    if (action === 'openUrl' || action === 'openConversation' || action === 'openGpt') {
      const target = String(body.url || '');
      if (!isAllowedChatGptUrl(target))
        return { ok: false, msg: '只允许打开 chatgpt.com / chat.openai.com 链接' };
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
      return { ok: true, state: await pageState(page) };
    }

    if (action === 'openProfile') {
      const store = loadQueueStore();
      const profile = getQueueProfile(store, String(body.profileId || 'default'));
      const target = String(profile.gptUrl || getConfig().gptUrl || '');
      if (!isAllowedChatGptUrl(target)) return { ok: false, msg: '该执行档案没有有效入口链接' };
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
      return { ok: true, state: await pageState(page) };
    }

    if (action === 'saveCurrentGptProfile') {
      const state = await pageState(page);
      if (!/\/g\//.test(state.url))
        return { ok: false, msg: '当前页面不是可保存的执行端入口，无法保存为档案' };
      // 简化版：只返回当前 URL，不实际保存到队列存储
      return {
        ok: true,
        msg: '已检测到当前入口（简化模式：请通过队列管理页面手动保存执行档案）',
        url: state.url,
      };
    }

    // 以下动作在简化版中返回不支持提示
    if (
      [
        'draft',
        'clearComposer',
        'stopGenerating',
        'copyLastAssistant',
        'send',
        'uploadFiles',
        'deleteCurrentConversation',
      ].includes(action)
    ) {
      return {
        ok: false,
        msg: `简化模式不支持动作: ${action}（需完整版 server 驱动 Chrome 执行）`,
        state: await pageState(page),
      };
    }

    return { ok: false, msg: '未知执行端动作: ' + action };
  } catch (e) {
    return {
      ok: false,
      msg: e instanceof Error ? e.message : String(e),
    };
  }
}

// ---------- 文件夹浏览 ----------

/** 列出所有盘符 */
function listDrives(): string[] {
  const out: string[] = [];
  for (let c = 67; c <= 90; c++) {
    const d = String.fromCharCode(c) + ':\\';
    try {
      if (fs.existsSync(d)) out.push(d);
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** 浏览目录 */
export function browseDir(p: string): {
  path: string;
  parent: string | null;
  dirs: string[];
  error?: string;
} {
  if (!p) return { path: '', parent: null, dirs: listDrives() };
  try {
    const dirs = fs
      .readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, 'zh'));
    const parent = path.dirname(p) === p ? '' : path.dirname(p);
    return { path: p, parent: parent || null, dirs };
  } catch (e) {
    return {
      path: p,
      parent: path.dirname(p) || null,
      dirs: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
