const AUTH_COOKIE_PATTERN = /^(?:__Secure-(?:next-auth|authjs)\.session-token(?:\.\d+)?|oai-client-auth-info|_account)$/i;

export async function inspectChatGptSession(cdpUrl, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 8000);
  const loadChromium = options.loadChromium || (async () => (await import('playwright-core')).chromium);
  let browser;
  try {
    const chromium = await loadChromium();
    browser = await chromium.connectOverCDP(cdpUrl, { timeout: timeoutMs });
    const contexts = browser.contexts();
    if (contexts.length === 0) {
      return { ok: false, detail: '浏览器没有可用上下文' };
    }

    const pages = contexts
      .flatMap((context) => context.pages())
      .filter((page) => page.url().startsWith('https://chatgpt.com/'));

    for (const page of pages) {
      const composer = page.locator('#prompt-textarea, [data-testid="prompt-textarea"]');
      if (await composer.count()) {
        return { ok: true, detail: '已通过 CDP 页面确认登录' };
      }
      const login = page.locator('a[href*="/auth/login"], button:has-text("Log in"), button:has-text("登录")');
      if (await login.count()) {
        return { ok: false, detail: 'ChatGPT 页面显示需要登录' };
      }
    }

    for (const context of contexts) {
      const cookies = await context.cookies('https://chatgpt.com');
      if (cookies.some((cookie) => AUTH_COOKIE_PATTERN.test(cookie.name))) {
        return { ok: true, detail: '已在 CDP 会话中找到登录凭据' };
      }
    }
    return { ok: false, detail: 'CDP 可达，但未找到 ChatGPT 登录会话' };
  } catch (error) {
    return { ok: false, detail: `检查失败: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    await browser?.close().catch(() => {});
  }
}
