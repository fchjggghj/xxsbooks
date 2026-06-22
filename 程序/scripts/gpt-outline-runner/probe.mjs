// 只读探针：连接现有调试 Chrome，诊断 ChatGPT 页面状态。绝不发送任何消息。
import { chromium } from 'playwright-core';

const CDP = process.argv[2] || 'http://localhost:9222';

const browser = await chromium.connectOverCDP(CDP);
const context = browser.contexts()[0];
const pages = context.pages();

console.log('=== 所有标签页 ===');
for (const p of pages) console.log(' -', p.url());

const page = pages.find((p) => p.url().includes('chatgpt.com'))
  || pages.find((p) => p.url().includes('chat.openai.com'))
  || pages[0];

console.log('\n=== 选中页面 ===');
console.log('URL:', page.url());
console.log('TITLE:', await page.title().catch(() => '(读取失败)'));

const info = await page.evaluate(() => {
  const out = {};
  const body = (document.body.innerText || '');
  const low = body.toLowerCase();
  out.bodyLen = body.length;
  out.hasComposer = !!document.querySelector('#prompt-textarea, textarea[name="prompt-textarea"], [data-testid="composer-input"]');
  out.hasSendBtn = !!document.querySelector('button[data-testid="send-button"], #composer-submit-button');
  out.loginHint = /log in|sign in|登录|登入|create account|Get started/i.test(body) && !out.hasComposer;
  out.rateLimit = /you've reached|reached your|usage limit|limit reached|请稍后再试|达到.*上限|使用量已达|稍后再试|message limit|upgrade to/i.test(low);
  // 抓出任何含 limit / 上限 / 稍后 的可见句子
  const lines = body.split('\n').map((s) => s.trim()).filter(Boolean);
  out.flagLines = lines.filter((l) => /reach|limit|上限|稍后|配额|usage|upgrade|plus|verify|human|robot|cloudflare|出错|error|try again|重新/i.test(l)).slice(0, 12);
  const asn = document.querySelectorAll('[data-message-author-role="assistant"]');
  out.assistantCount = asn.length;
  if (asn.length) {
    const el = asn[asn.length - 1];
    const md = el.querySelector('.markdown, .prose, [class*="markdown"]');
    out.lastAssistant = ((md || el).innerText || '').trim().slice(0, 400);
    out.lastAssistantLen = ((md || el).innerText || '').trim().length;
  }
  const usr = document.querySelectorAll('[data-message-author-role="user"]');
  out.userCount = usr.length;
  if (usr.length) {
    const el = usr[usr.length - 1];
    out.lastUser = (el.innerText || '').trim().slice(0, 120);
  }
  // 是否正在生成
  const root = document.querySelector('main') || document.body;
  out.generating = Array.from(root.querySelectorAll('button')).some((b) => {
    const r = b.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const t = ((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-testid') || '')).toLowerCase();
    return /stop|停止|中止|composer-stop/.test(t);
  });
  return out;
});

console.log('\n=== 页面状态 ===');
console.log(JSON.stringify(info, null, 2));

await browser.close(); // 仅断开 CDP，不关 Chrome
