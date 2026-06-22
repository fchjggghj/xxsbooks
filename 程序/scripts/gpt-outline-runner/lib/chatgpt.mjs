// ChatGPT 页面交互（移植自扩展里已实战验证的选择器/逻辑）。
// 通过 CDP 连接你已登录的真实 Chrome，所有动作在该页面里执行。
import { chromium } from 'playwright-core';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 连接到你已用 --remote-debugging-port 启动的 Chrome，拿到 chatgpt 的页面。
export async function connect(cfg) {
  const browser = await chromium.connectOverCDP(cfg.cdpUrl);
  const context = browser.contexts()[0];
  if (!context) throw new Error('CDP 已连接，但没有浏览器上下文。确认 Chrome 是用调试端口启动的。');
  const pages = context.pages();
  let page = pages.find((p) => p.url().includes('chatgpt.com'))
    || pages.find((p) => p.url().includes('chat.openai.com'))
    || pages[0]
    || await context.newPage();
  return { browser, page };
}

// 并发用：拿到 n 个独立标签页（不够就新开）。每个工作线程独占一个，互不干扰。
export async function getPages(cfg, n = 1) {
  const browser = await chromium.connectOverCDP(cfg.cdpUrl);
  const context = browser.contexts()[0];
  if (!context) throw new Error('CDP 已连接，但没有浏览器上下文。确认 Chrome 是用调试端口启动的。');
  const isGpt = (p) => /chatgpt\.com|chat\.openai\.com/.test(p.url());
  let pages = context.pages().filter(isGpt);
  if (!pages.length) pages = [context.pages()[0] || await context.newPage()];
  while (pages.length < n) pages.push(await context.newPage());
  return { browser, pages: pages.slice(0, n) };
}

// 打开自定义 GPT 链接 ＝ 开一个全新对话。
export async function newConversation(page, cfg) {
  await page.goto(cfg.gptUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#prompt-textarea, textarea[name="prompt-textarea"], [data-testid="composer-input"]', { timeout: 45000 });
  await sleep(1500);
  const state = await inspectPageState(page);
  if (state.loginRequired) throw new Error('ChatGPT 需要登录或登录态已失效');
  if (state.captchaRequired) throw new Error('ChatGPT 出现人机验证，需要人工处理');
  if (!state.composerReady) throw new Error('未检测到可用输入框');
}

export async function openUrl(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1200);
  return await inspectWorkbenchState(page);
}

export async function openNewChat(page) {
  return await openUrl(page, 'https://chatgpt.com/');
}

export async function openGptBuilder(page) {
  return await openUrl(page, 'https://chatgpt.com/gpts/editor');
}

export async function openExploreGpts(page) {
  return await openUrl(page, 'https://chatgpt.com/gpts');
}

export async function openLibrary(page) {
  return await openUrl(page, 'https://chatgpt.com/library');
}

export async function reloadCurrentPage(page) {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(900);
  return await inspectWorkbenchState(page);
}

export async function goBack(page) {
  await page.goBack({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
  await sleep(900);
  return await inspectWorkbenchState(page);
}

export async function goForward(page) {
  await page.goForward({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
  await sleep(900);
  return await inspectWorkbenchState(page);
}

// 把整章文本写进输入框。
// contenteditable 优先合成 paste；但超大章节（番外常 3 万字+）paste 是异步插入、甚至可能被拒，
// 所以：①轮询等待内容出现 ②仍为空则分块 execCommand('insertText') 兜底。
export async function setComposerText(page, text) {
  return await page.evaluate(async (t) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const sels = [
      '#prompt-textarea',
      'div#prompt-textarea[contenteditable="true"]',
      '[data-testid="composer-input"] [contenteditable]',
      'textarea[name="prompt-textarea"]',
      'textarea#prompt-textarea',
    ];
    let el = null;
    for (const s of sels) { const e = document.querySelector(s); if (e) { el = e; break; } }
    if (!el) return false;
    el.focus();

    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')?.set;
      if (setter) setter.call(el, t); else el.value = t;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return (el.value || '').length > 0;
    }

    const curLen = () => ((el.innerText || el.textContent || '').length);
    const clear = () => {
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('delete', false);
      } catch {}
    };
    // 大段文本插入是异步的：轮询等待内容出现（最多 ~4.5s）
    const settle = async () => {
      for (let i = 0; i < 30; i++) { if (curLen() > 0) return true; await wait(150); }
      return curLen() > 0;
    };

    // 方法1：合成 paste（普通章节最稳）
    clear();
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', t);
      el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    } catch {}
    el.dispatchEvent(new Event('input', { bubbles: true }));
    if (await settle()) return true;

    // 方法2：兜底 —— 分块 insertText（超大文本一次性 paste 可能被编辑器丢弃）
    el.focus();
    clear();
    try {
      const CHUNK = 4000;
      for (let i = 0; i < t.length; i += CHUNK) {
        document.execCommand('insertText', false, t.slice(i, i + CHUNK));
      }
    } catch {}
    el.dispatchEvent(new Event('input', { bubbles: true }));
    if (await settle()) return true;

    return curLen() > 0;
  }, text);
}

// 点击发送（多选择器兜底，失败回退回车）。
export async function submit(page) {
  const clicked = await page.evaluate(() => {
    const sels = [
      'button[data-testid="send-button"]',
      '#composer-submit-button',
      'button[aria-label*="Send" i]',
      'button[aria-label*="发送"]',
      'form[data-type="unified-composer"] button[type="submit"]',
    ];
    for (const s of sels) {
      const b = document.querySelector(s);
      if (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') {
        const r = b.getBoundingClientRect();
        if (r.width > 2 && r.height > 2) { b.click(); return true; }
      }
    }
    return false;
  });
  if (clicked) return true;
  try { await page.locator('#prompt-textarea').press('Enter'); return true; } catch { return false; }
}

export async function clearComposer(page) {
  return await page.evaluate(() => {
    const el = document.querySelector('#prompt-textarea, textarea[name="prompt-textarea"], [data-testid="composer-input"], div#prompt-textarea[contenteditable="true"]');
    if (!el) return false;
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')?.set;
      if (setter) setter.call(el, ''); else el.value = '';
    } else {
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('delete', false);
      } catch {
        el.textContent = '';
      }
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  });
}

export async function stopGenerating(page) {
  return await page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 4 && r.height > 4 && st.display !== 'none' && st.visibility !== 'hidden';
    };
    const textOf = (el) => `${el.textContent || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('data-testid') || ''}`.toLowerCase();
    const btn = Array.from(document.querySelectorAll('button,[role="button"]')).filter(visible)
      .find((el) => /stop|停止|中止|终止|cancel|composer-stop/.test(textOf(el)));
    if (!btn) return { ok: false, message: '当前未找到停止生成按钮' };
    btn.click();
    return { ok: true };
  });
}

export async function copyLastAssistant(page) {
  const text = await getLastAssistantText(page);
  return { ok: !!text, text, message: text ? '已读取最后一条回复' : '没有可读取的 assistant 回复' };
}

export async function openSettings(page) {
  return await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 4 && r.height > 4 && st.display !== 'none' && st.visibility !== 'hidden';
    };
    const textOf = (el) => [
      el.textContent || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('title') || '',
      el.getAttribute('data-testid') || '',
    ].join(' ').replace(/\s+/g, ' ').trim();
    const click = (el) => {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
      return true;
    };
    const buttons = () => Array.from(document.querySelectorAll('button,[role="button"],[role="menuitem"],a')).filter(visible);
    const direct = buttons().find((el) => /settings|设置/i.test(textOf(el)));
    if (direct) return { ok: click(direct), step: 'direct' };
    const menu = buttons().find((el) => /account|profile|avatar|menu|账户|账号|个人|菜单|更多/i.test(textOf(el)))
      || Array.from(document.querySelectorAll('button')).filter(visible).at(-1);
    if (!menu) return { ok: false, step: 'open_menu', message: '未找到账号/菜单按钮' };
    click(menu);
    await wait(700);
    const item = buttons().find((el) => /settings|设置/i.test(textOf(el)));
    if (!item) return { ok: false, step: 'settings_item', message: '未找到设置入口' };
    click(item);
    await wait(700);
    return { ok: true, step: 'opened' };
  });
}

export async function openModelMenu(page) {
  return await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 4 && r.height > 4 && st.display !== 'none' && st.visibility !== 'hidden';
    };
    const textOf = (el) => [
      el.textContent || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('title') || '',
      el.getAttribute('data-testid') || '',
    ].join(' ').replace(/\s+/g, ' ').trim();
    const candidates = Array.from(document.querySelectorAll('button,[role="button"]')).filter(visible);
    const btn = candidates.find((el) => /gpt[-\s]?[45o]|model|模型|模式/i.test(textOf(el)))
      || candidates.find((el) => /chatgpt/i.test(textOf(el)));
    if (!btn) return { ok: false, message: '未找到模型菜单按钮' };
    btn.click();
    await wait(700);
    const options = Array.from(document.querySelectorAll('[role="menuitem"],[role="option"],button')).filter(visible).map(textOf).filter(Boolean).slice(0, 30);
    return { ok: true, options };
  });
}

export async function selectVisibleModel(page, modelName) {
  return await page.evaluate(async (name) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const target = String(name || '').trim().toLowerCase();
    if (!target) return { ok: false, message: '模型名称为空' };
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 4 && r.height > 4 && st.display !== 'none' && st.visibility !== 'hidden';
    };
    const textOf = (el) => [
      el.textContent || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('title') || '',
      el.getAttribute('data-testid') || '',
    ].join(' ').replace(/\s+/g, ' ').trim();
    const options = Array.from(document.querySelectorAll('[role="menuitem"],[role="option"],button')).filter(visible);
    const item = options.find((el) => textOf(el).toLowerCase().includes(target));
    if (!item) return { ok: false, message: `当前菜单里未找到模型: ${name}` };
    item.click();
    await wait(900);
    return { ok: true, selected: textOf(item) };
  }, modelName);
}

export async function uploadFiles(page, filePaths = []) {
  const files = Array.isArray(filePaths) ? filePaths.filter(Boolean) : [];
  if (!files.length) return { ok: false, message: '没有文件路径' };
  let input = page.locator('input[type="file"]');
  if (await input.count().catch(() => 0) < 1) {
    await page.evaluate(() => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 4 && r.height > 4 && st.display !== 'none' && st.visibility !== 'hidden';
      };
      const textOf = (el) => `${el.textContent || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`.toLowerCase();
      const btn = Array.from(document.querySelectorAll('button,[role="button"]')).filter(visible).find((el) => /attach|upload|paperclip|上传|附件|文件|图片|image/.test(textOf(el)));
      if (btn) btn.click();
    });
    await sleep(700);
    input = page.locator('input[type="file"]');
  }
  if (await input.count().catch(() => 0) < 1) return { ok: false, message: '未找到上传控件' };
  await input.first().setInputFiles(files);
  await sleep(1200);
  return { ok: true, count: files.length };
}

// 是否正在生成：存在「停止」按钮即为 true。
export async function isGenerating(page) {
  return await page.evaluate(() => {
    const root = document.querySelector('main') || document.body;
    return Array.from(root.querySelectorAll('button')).some((b) => {
      const r = b.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return false;
      const t = ((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-testid') || '')).toLowerCase();
      return /stop|停止|中止|终止|cancel|composer-stop/.test(t);
    });
  });
}

// 抓最后一条 assistant 消息的纯文本。
export async function getLastAssistantText(page) {
  return await page.evaluate(() => {
    const nodes = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (!nodes.length) return '';
    const el = nodes[nodes.length - 1];
    const md = el.querySelector('.markdown, .prose, [class*="markdown"]');
    return ((md || el).innerText || '').trim();
  });
}

export async function inspectWorkbenchState(page) {
  const base = await inspectPageState(page).catch(() => ({}));
  const data = await page.evaluate(() => {
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const hrefOf = (a) => {
      try { return new URL(a.getAttribute('href') || '', location.origin).href; } catch { return ''; }
    };
    const uniq = (items, key) => {
      const seen = new Set();
      const out = [];
      for (const item of items) {
        const k = key(item);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        out.push(item);
      }
      return out;
    };
    const messages = Array.from(document.querySelectorAll('[data-message-author-role]')).slice(-16).map((el, index) => {
      const role = el.getAttribute('data-message-author-role') || '';
      const md = el.querySelector('.markdown, .prose, [class*="markdown"]');
      return { index, role, text: clean((md || el).innerText || '').slice(0, 1800) };
    }).filter((m) => m.text);
    const conversations = uniq(Array.from(document.querySelectorAll('a[href*="/c/"]')).map((a) => ({
      title: clean(a.innerText || a.textContent || a.getAttribute('aria-label') || '未命名对话').slice(0, 120),
      url: hrefOf(a),
    })).filter((x) => x.url), (x) => x.url).slice(0, 80);
    const gpts = uniq(Array.from(document.querySelectorAll('a[href*="/g/"]')).map((a) => ({
      name: clean(a.innerText || a.textContent || a.getAttribute('aria-label') || 'GPTS').slice(0, 120),
      url: hrefOf(a),
    })).filter((x) => /\/g\//.test(x.url)), (x) => x.url).slice(0, 60);
    const composer = document.querySelector('#prompt-textarea, textarea[name="prompt-textarea"], [data-testid="composer-input"], div#prompt-textarea[contenteditable="true"]');
    const buttons = Array.from(document.querySelectorAll('button,[role="button"]')).map((b) => clean(`${b.textContent || ''} ${b.getAttribute('aria-label') || ''} ${b.getAttribute('data-testid') || ''}`)).filter(Boolean);
    const modelText = buttons.find((t) => /gpt[-\s]?[45o]|model|模型/i.test(t)) || '';
    const titleCandidates = Array.from(document.querySelectorAll('h1,h2,[data-testid*="conversation" i],[data-testid*="gizmo" i]')).map((el) => clean(el.innerText || el.textContent)).filter(Boolean);
    return {
      url: location.href,
      title: document.title,
      modelText: modelText.slice(0, 120),
      pageHeading: titleCandidates[0] || '',
      composerText: composer ? clean(composer.value || composer.innerText || composer.textContent || '') : '',
      conversations,
      gpts,
      messages,
      visibleTools: uniq(buttons.filter((t) => /image|图片|上传|attach|文件|canvas|画布|voice|语音|search|搜索|deep|reason|推理|工具/.test(t.toLowerCase())).slice(0, 40).map((name) => ({ name })), (x) => x.name),
    };
  });
  return { ...base, ...data };
}

// 账号配额墙检测（撞墙换对话也没用，只能等）。
export async function hitRateLimit(page) {
  return (await inspectPageState(page)).rateLimited;
}

// 智能识别限制的「还要等多久」：从页面提示里解析重置时间（X 分钟后 / 几点恢复 / in X hours）。
// 返回 { limited, resetMs(可能为 null=没说具体时间), hint }。
export async function rateLimitInfo(page) {
  return await page.evaluate(() => {
    const body = (document.body?.innerText || '');
    const lower = body.toLowerCase();
    const limited = /you've reached|reached your|usage (cap|limit)|limit reached|message (cap|limit)|too many requests|请稍后再试|达到.*上限|使用量已达|稍后再试|发送(消息)?过于频繁|消息次数/.test(lower);
    if (!limited) return { limited: false, resetMs: null, hint: '' };
    let resetMs = null, hint = '';
    let m;
    // "几点几分恢复 / try again at|after 3:21 pm / 在 15:30 之后"
    if ((m = body.match(/(?:try again (?:after|at|around)|再试|之后|恢复|after)\D{0,12}(\d{1,2}):(\d{2})\s*(am|pm|上午|下午)?/i))) {
      let h = parseInt(m[1], 10); const mi = parseInt(m[2], 10); const ap = (m[3] || '').toLowerCase();
      if ((ap === 'pm' || ap === '下午') && h < 12) h += 12;
      if ((ap === 'am' || ap === '上午') && h === 12) h = 0;
      const now = new Date(); const t = new Date(now); t.setHours(h, mi, 0, 0);
      if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
      resetMs = t.getTime() - now.getTime(); hint = m[0];
    } else if ((m = body.match(/(\d+)\s*(小时|hours?|hrs?)/i))) {
      resetMs = parseInt(m[1], 10) * 3600000; hint = m[0];
    } else if ((m = body.match(/(\d+)\s*(分钟|minutes?|mins?)/i))) {
      resetMs = parseInt(m[1], 10) * 60000; hint = m[0];
    }
    return { limited: true, resetMs, hint: hint || body.slice(0, 160).replace(/\s+/g, ' ').trim() };
  });
}

// 可选清理：删除 ChatGPT 网站侧当前对话记录。
// 这是 UI 级 best-effort 操作，ChatGPT 页面改版时可能失败；失败会返回 ok:false，由调用方记录但不中断已保存结果。
export async function deleteCurrentConversation(page) {
  const beforeUrl = page.url();
  const result = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const textOf = (el) => [
      el.textContent || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('title') || '',
      el.getAttribute('data-testid') || '',
    ].join(' ').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 4 && r.height > 4 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const click = (el) => {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
      return true;
    };
    const allClickable = () => Array.from(document.querySelectorAll('button,[role="button"],[role="menuitem"],a,[data-testid]')).filter(visible);
    const findClickable = (re) => allClickable().find((el) => re.test(textOf(el)));

    let del = findClickable(/delete chat|delete conversation|删除聊天|删除对话/i);
    if (!del) {
      const menuSelectors = [
        '[data-testid*="conversation-options" i]',
        '[data-testid*="chat-options" i]',
        'button[aria-label*="More" i]',
        'button[aria-label*="options" i]',
        'button[aria-label*="更多"]',
        'button[aria-label*="选项"]',
        'button[aria-haspopup="menu"]',
      ];
      let menu = null;
      for (const s of menuSelectors) {
        menu = Array.from(document.querySelectorAll(s)).find(visible);
        if (menu) break;
      }
      if (!menu) {
        menu = allClickable().find((el) => {
          const t = textOf(el).toLowerCase();
          return /more|option|menu|更多|选项|操作/.test(t) && !/send|发送|stop|停止|new chat|新建/.test(t);
        });
      }
      if (!menu) return { ok: false, step: 'open_menu', message: '未找到当前对话的菜单按钮' };
      click(menu);
      await wait(700);
      del = findClickable(/delete chat|delete conversation|删除聊天|删除对话|删除/i);
    }

    if (!del) return { ok: false, step: 'delete_item', message: '未找到删除对话菜单项' };
    click(del);
    await wait(900);

    const confirm = allClickable().find((el) => {
      const t = textOf(el).toLowerCase();
      return /^(delete|删除|确认删除)$/.test(t) || (/delete|删除/.test(t) && !/cancel|取消/.test(t));
    });
    if (confirm) {
      click(confirm);
      await wait(1400);
      return { ok: true, step: 'confirmed' };
    }
    return { ok: true, step: 'clicked_delete_no_confirm' };
  });
  await sleep(1000);
  return { ...result, beforeUrl, afterUrl: page.url() };
}

// 轻量页面状态探测：给队列运行和健康面板识别“卡在哪里”。
export async function inspectPageState(page) {
  return await page.evaluate(() => {
    const bodyText = (document.body?.innerText || '');
    const lower = bodyText.toLowerCase();
    const composer = document.querySelector('#prompt-textarea, textarea[name="prompt-textarea"], [data-testid="composer-input"], div#prompt-textarea[contenteditable="true"]');
    const buttons = Array.from(document.querySelectorAll('button')).map((b) => `${b.textContent || ''} ${b.getAttribute('aria-label') || ''} ${b.getAttribute('data-testid') || ''}`.toLowerCase());
    const generating = buttons.some((t) => /stop|停止|中止|终止|cancel|composer-stop/.test(t));
    const loginRequired = /log in|sign in|登录|注册|welcome back|欢迎回来/.test(lower) && !composer;
    const captchaRequired = /captcha|verify you are human|人机验证|验证你是真人|请完成验证/.test(lower);
    const rateLimited = /you've reached|reached your|usage limit|limit reached|请稍后再试|达到.*上限|使用量已达|稍后再试/.test(lower);
    const assistantCount = document.querySelectorAll('[data-message-author-role="assistant"]').length;
    const textareaLen = composer ? ((composer.value || composer.innerText || composer.textContent || '').length) : 0;
    return {
      url: location.href,
      title: document.title,
      composerReady: !!composer,
      textareaLen,
      generating,
      assistantCount,
      loginRequired,
      captchaRequired,
      rateLimited,
      bodyHint: bodyText.slice(0, 220),
    };
  });
}

// 发送一章 → 等回复生成完 → 返回回复文本。
export async function sendAndCollect(page, prompt, cfg) {
  cfg.onStatus?.({ phase: 'checking_page', message: '检查 ChatGPT 页面状态' });
  const before = await inspectPageState(page);
  if (before.loginRequired) throw new Error('ChatGPT 需要登录或登录态已失效');
  if (before.captchaRequired) throw new Error('ChatGPT 出现人机验证，需要人工处理');
  if (before.rateLimited) throw new Error('ChatGPT 疑似达到使用上限');
  cfg.onStatus?.({ phase: 'typing_prompt', message: '写入提示词' });
  const okSet = await setComposerText(page, prompt);
  if (!okSet) throw new Error('写入输入框失败（未找到或写入未生效）');
  await sleep(300);
  cfg.onStatus?.({ phase: 'submitting_prompt', message: '点击发送' });
  await submit(page);

  const start = Date.now();
  // 1) 等生成开始（最多 ~15s；有时回复很快，未必能捕捉到 stop 按钮）
  cfg.onStatus?.({ phase: 'waiting_start', message: '等待 GPTS 开始回复' });
  while (Date.now() - start < 15000) {
    if (await isGenerating(page)) break;
    const state = await inspectPageState(page);
    if (state.loginRequired) throw new Error('ChatGPT 需要登录或登录态已失效');
    if (state.captchaRequired) throw new Error('ChatGPT 出现人机验证，需要人工处理');
    if (state.rateLimited) throw new Error('ChatGPT 疑似达到使用上限');
    await sleep(300);
  }
  // 2) 等生成结束
  cfg.onStatus?.({ phase: 'generating', message: 'GPTS 正在生成回复' });
  while (Date.now() - start < cfg.waitReplyTimeoutMs) {
    if (!(await isGenerating(page))) break;
    cfg.onStatus?.({ phase: 'generating', message: 'GPTS 正在生成回复' });
    await sleep(500);
  }
  // 3) 确认文本稳定 replyStableMs
  cfg.onStatus?.({ phase: 'stabilizing_reply', message: '等待回复稳定' });
  let last = '';
  let stableSince = 0;
  while (Date.now() - start < cfg.waitReplyTimeoutMs) {
    if (await isGenerating(page)) { stableSince = 0; await sleep(500); continue; }
    const cur = await getLastAssistantText(page);
    if (cur && cur === last) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= cfg.replyStableMs) return { text: cur, timedOut: false, state: await inspectPageState(page) };
    } else {
      last = cur;
      stableSince = 0;
    }
    await sleep(500);
  }
  return { text: last, timedOut: true, state: await inspectPageState(page) };
}
