/**
 * ChatGPT 浏览器交互模块（TypeScript 重写版）
 * 通过 CDP 连接已登录的 Chrome，操作 ChatGPT 网页
 */
import type { Page } from 'playwright-core';
import type { BaseConfig, SendResult, RateLimitInfo } from './types.js';
import { sleep } from './utils.js';

/** 连接 Chrome CDP */
export async function connect(cfg: { cdpUrl: string }): Promise<import('playwright-core').Browser> {
  const { chromium } = await import('playwright-core');
  return chromium.connectOverCDP(cfg.cdpUrl);
}

/** 获取 N 个标签页 */
export async function getPages(
  cfg: BaseConfig,
  n: number,
): Promise<{ browser: import('playwright-core').Browser; pages: Page[] }> {
  const browser = await connect(cfg);
  const contexts = browser.contexts();
  const ctx = contexts[0] || (await browser.newContext());
  const existing = ctx.pages();
  const pages: Page[] = [];

  for (let i = 0; i < n; i++) {
    if (existing[i]) {
      pages.push(existing[i]);
    } else {
      const page = await ctx.newPage();
      pages.push(page);
    }
  }

  return { browser, pages };
}

/** 打开新对话 */
export async function newConversation(page: Page, cfg: BaseConfig): Promise<void> {
  await page.goto(cfg.gptUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2000);
  await page
    .waitForSelector(
      '#prompt-textarea, textarea[name="prompt-textarea"], [data-testid="composer-input"]',
      { timeout: 30000 },
    )
    .catch(() => {});
  await sleep(1000);
}

/** 写入输入框文本（支持 textarea 和 contenteditable div） */
export async function setComposerText(page: Page, text: string): Promise<void> {
  // ChatGPT 新版界面用 contenteditable div（id=prompt-textarea, role=textbox），
  // 旧版用 textarea（name=prompt-textarea）。优先找可见的 contenteditable，其次 textarea。
  const ceSel = '#prompt-textarea[contenteditable="true"], div[role="textbox"][contenteditable="true"]';
  const taSel = 'textarea[name="prompt-textarea"], textarea#prompt-textarea, [data-testid="composer-input"]';

  // 等待任一输入框出现
  await page.waitForSelector(`${ceSel}, ${taSel}`, { timeout: 30000 }).catch(() => {});

  // 判断哪个输入框可见
  const useContentEditable = await page.evaluate((ceSel: string) => {
    const el = document.querySelector(ceSel) as HTMLElement;
    return !!(el && el.offsetParent !== null);
  }, ceSel);

  if (useContentEditable) {
    // contenteditable div：focus → 全选删除 → keyboard.insertText
    await page.focus(ceSel);
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    // insertText 比 type 快得多，且支持 Unicode 长文本
    // 分块写入避免单次过长
    const chunkSize = 8000;
    for (let i = 0; i < text.length; i += chunkSize) {
      await page.keyboard.insertText(text.slice(i, i + chunkSize));
      await sleep(50);
    }
    await sleep(300);
    return;
  }

  // 兜底：textarea — 优先用 paste 事件
  try {
    await page.focus(taSel);
    await page.evaluate((t) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', t);
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true });
      (
        document.querySelector('textarea[name="prompt-textarea"], textarea#prompt-textarea, [data-testid="composer-input"]') as HTMLElement
      )?.dispatchEvent(ev);
    }, text);
    await sleep(300);
    // 验证是否写入成功
    const written = await page.evaluate(() => {
      const ta = document.querySelector('textarea[name="prompt-textarea"], textarea#prompt-textarea, [data-testid="composer-input"]') as HTMLTextAreaElement;
      return ta?.value || '';
    });
    if (written.length > 0) return;
  } catch {
    /* fall through to fallback */
  }

  // 最终兜底：分块 insertText
  await page.focus(taSel).catch(() => {});
  const chunkSize = 4000;
  for (let i = 0; i < text.length; i += chunkSize) {
    const chunk = text.slice(i, i + chunkSize);
    await page.evaluate((c) => document.execCommand('insertText', false, c), chunk);
    await sleep(100);
  }
}

/** 点击发送按钮 */
export async function submit(page: Page): Promise<void> {
  const selectors = [
    '[data-testid="send-button"]',
    'button[aria-label*="发送"]',
    'button[aria-label*="Send"]',
    'button[type="submit"]',
    'form button:last-child',
  ];
  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn && (await btn.isVisible())) {
        await btn.click();
        return;
      }
    } catch {
      /* try next selector */
    }
  }
  // 兜底：回车
  await page.keyboard.press('Enter');
}

/** 检查是否正在生成 */
export async function isGenerating(page: Page): Promise<boolean> {
  try {
    const stop = await page.$(
      '[data-testid="stop-button"], button[aria-label*="停止"], button[aria-label*="Stop"]',
    );
    return !!(stop && (await stop.isVisible()));
  } catch {
    return false;
  }
}

/** 获取最后一条 assistant 消息文本 */
export async function getLastAssistantText(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => {
      const msgs = document.querySelectorAll('[data-message-author-role="assistant"], .markdown');
      if (!msgs.length) return '';
      const last = msgs[msgs.length - 1];
      return last.textContent || '';
    });
  } catch {
    return '';
  }
}

/** 检测配额墙 */
export async function hitRateLimit(page: Page): Promise<boolean> {
  try {
    const text = await page.evaluate(() => document.body.innerText);
    return /rate limit|配额|额度|too many requests|请稍后|try again later/i.test(text);
  } catch {
    return false;
  }
}

/** 解析配额墙重置时间 */
export async function rateLimitInfo(page: Page): Promise<RateLimitInfo> {
  const hit = await hitRateLimit(page);
  if (!hit) return { hit: false };

  try {
    const text = await page.evaluate(() => document.body.innerText);
    // 尝试解析 "X 分钟后" / "in X hours" / "几点恢复"
    const minMatch = text.match(/(\d+)\s*分钟/);
    if (minMatch) return { hit: true, waitMs: +minMatch[1] * 60000, message: text.slice(0, 200) };
    const hourMatch = text.match(/(\d+)\s*小时|(\d+)\s*hour/i);
    if (hourMatch)
      return {
        hit: true,
        waitMs: +(hourMatch[1] || hourMatch[2]) * 3600000,
        message: text.slice(0, 200),
      };
    return { hit: true, message: text.slice(0, 200) };
  } catch {
    return { hit: true };
  }
}

/** 探测页面状态 */
export async function inspectPageState(page: Page): Promise<{
  url: string;
  loggedIn: boolean;
  generating: boolean;
  assistantCount: number;
  hasComposer: boolean;
}> {
  try {
    const state = await page.evaluate(() => {
      const msgs = document.querySelectorAll('[data-message-author-role="assistant"], .markdown');
      const composer = document.querySelector(
        '#prompt-textarea, textarea[name="prompt-textarea"], [data-testid="composer-input"]',
      );
      const stopBtn = document.querySelector(
        '[data-testid="stop-button"], button[aria-label*="停止"], button[aria-label*="Stop"]',
      );
      const loginBtn = document.querySelector(
        'button[data-testid="login-button"], a[href*="login"]',
      );
      return {
        url: location.href,
        loggedIn: !loginBtn,
        generating: !!(stopBtn && (stopBtn as HTMLElement).offsetParent),
        assistantCount: msgs.length,
        hasComposer: !!composer,
      };
    });
    return state;
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

/** 发送消息并收集回复 */
export async function sendAndCollect(
  page: Page,
  prompt: string,
  cfg: BaseConfig,
): Promise<SendResult> {
  const beforeState = await inspectPageState(page);
  const beforeCount = beforeState.assistantCount;
  const beforeUrl = page.url();

  // 写入并发送
  await setComposerText(page, prompt);
  await sleep(500);
  await submit(page);

  // 等待生成开始（最多 15 秒）
  let started = false;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if (await isGenerating(page)) {
      started = true;
      break;
    }
    const state = await inspectPageState(page);
    if (state.assistantCount > beforeCount) {
      started = true;
      break;
    }
  }

  if (!started) {
    return { text: '', timedOut: true, error: '生成未开始（15秒超时）' };
  }

  // 等待生成结束 - 只要仍在生成中就继续等待，不因超时中断
  // 兜底超时：30 分钟（防止永远卡住），正常情况下会等到生成完成
  const maxWait = 30 * 60 * 1000;
  const deadline = Date.now() + maxWait;
  let timedOut = false;

  while (Date.now() < deadline) {
    await sleep(2000);
    if (!(await isGenerating(page))) break;
  }

  // 只有超过 30 分钟兜底超时才标记为超时
  if (Date.now() >= deadline) timedOut = true;

  // 等待稳定
  await sleep(cfg.replyStableMs || 2000);

  // 获取最终文本
  const text = await getLastAssistantText(page);

  // 捕获对话 URL
  const afterUrl = page.url();
  const conversationUrl = afterUrl !== beforeUrl && /\/c\//.test(afterUrl) ? afterUrl : null;

  return { text, timedOut, conversationUrl };
}

/**
 * 编辑最后一条用户消息并重新提交（用于重试失败的消息）。
 *
 * ChatGPT 支持编辑已发送的用户消息，编辑后会重新生成回复，
 * 不会增加对话长度。适合在回复不可用/超时时重试，避免对话越来越长。
 *
 * 流程：hover 最后一条用户消息 → 点击"编辑消息" → 清空 textarea →
 * 写入新文本 → 点击"发送" → 等待生成完成
 */
export async function editLastUserMessage(
  page: Page,
  newText: string,
  cfg: BaseConfig,
): Promise<SendResult> {
  const beforeState = await inspectPageState(page);
  const beforeCount = beforeState.assistantCount;
  const beforeUrl = page.url();

  // 1. hover 最后一条用户消息（编辑按钮 hover 后才显示）
  const userMsgs = await page.$$('[data-message-author-role="user"]');
  if (!userMsgs.length) {
    throw new Error('编辑失败：找不到用户消息');
  }
  await userMsgs[userMsgs.length - 1].hover();
  await sleep(800);

  // 2. 点击编辑按钮（取最后一个，属于最后一条用户消息）
  const editBtns = await page.$$('button[aria-label="编辑消息"]');
  if (!editBtns.length) {
    throw new Error('编辑失败：找不到编辑按钮');
  }
  await editBtns[editBtns.length - 1].click();
  await sleep(1000);

  // 3. 等待编辑 textarea 出现（编辑模式下会出现 textarea.resize-none）
  await page.waitForSelector('textarea.resize-none', { timeout: 10000 }).catch(() => {});

  // 4. 清空 textarea 并写入新文本
  await page.focus('textarea.resize-none').catch(() => {});
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await sleep(200);
  // 分块写入（insertText 支持长 Unicode 文本）
  const chunkSize = 8000;
  for (let i = 0; i < newText.length; i += chunkSize) {
    await page.keyboard.insertText(newText.slice(i, i + chunkSize));
    await sleep(50);
  }
  await sleep(300);

  // 5. 点击编辑区域内的"发送"按钮（不是底部的发送按钮）
  const saveClicked = await page.evaluate(() => {
    const textarea = document.querySelector('textarea.resize-none');
    if (!textarea) return false;
    // 往上找包含按钮的容器
    let container: HTMLElement | null = textarea as HTMLElement;
    for (let i = 0; i < 10; i++) {
      container = container ? container.parentElement : null;
      if (!container) break;
      const btns = container.querySelectorAll('button');
      for (const b of btns) {
        if (!b.offsetParent) continue;
        const text = (b.textContent || '').trim();
        if (text === '发送' || text === 'Send' || text === '保存并提交' || text === 'Save & Submit') {
          (b as HTMLElement).click();
          return true;
        }
      }
    }
    return false;
  });

  if (!saveClicked) {
    // 兜底：Ctrl+Enter 提交编辑
    await page.keyboard.press('Control+Enter');
  }

  // 6. 等待生成开始（最多 15 秒）
  let started = false;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if (await isGenerating(page)) {
      started = true;
      break;
    }
    const state = await inspectPageState(page);
    if (state.assistantCount !== beforeCount) {
      started = true;
      break;
    }
  }

  if (!started) {
    return { text: '', timedOut: true, error: '编辑后生成未开始（15秒超时）' };
  }

  // 7. 等待生成结束（30 分钟兜底，只要仍在生成就继续等）
  const maxWait = 30 * 60 * 1000;
  const deadline = Date.now() + maxWait;
  let timedOut = false;

  while (Date.now() < deadline) {
    await sleep(2000);
    if (!(await isGenerating(page))) break;
  }

  if (Date.now() >= deadline) timedOut = true;

  // 等待稳定
  await sleep(cfg.replyStableMs || 2000);

  // 获取最终文本
  const text = await getLastAssistantText(page);

  // 捕获对话 URL
  const afterUrl = page.url();
  const conversationUrl = afterUrl !== beforeUrl && /\/c\//.test(afterUrl) ? afterUrl : null;

  return { text, timedOut, conversationUrl };
}

/** 删除当前对话（best-effort） */
export async function deleteCurrentConversation(page: Page): Promise<void> {
  try {
    // 打开侧栏对话列表 → 找到当前对话 → 删除
    const sidebar = await page.$('button[aria-label*="对话"], button[aria-label*="Chat"]');
    if (sidebar) await sidebar.click();
    await sleep(1000);
    // 实际删除逻辑较复杂，这里只做 best-effort
  } catch {
    /* best-effort */
  }
}
