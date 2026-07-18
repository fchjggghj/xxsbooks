const RATE_LIMIT_PATTERNS = [
  /usage limit/i, /rate limit/i, /try again in/i, /exceeded.{0,30}limit/i,
  /reached.{0,30}(limit|cap)/i, /too many requests/i, /quota/i, /cool.?down/i,
];

const SAFETY_PATTERNS = [
  /content policy/i, /may violate/i, /violation/i,
  /i can'?t (help|assist|provide|generate|create|write)/i,
  /i won'?t (help|assist|provide|generate|create|write)/i,
  /i'?m not able to (help|assist|provide|generate)/i,
  /against.{0,30}(policy|guidelines)/i, /not appropriate/i, /safety/i, /flagged/i,
];

export class QueueError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'QueueError';
    this.kind = kind;
  }
}

export async function detectPageError(page) {
  try {
    const bodyText = await page.evaluate(() => {
      const selectors = [
        '[role="alert"]', '.toast', '[class*="toast"]', '[class*="error"]',
        '[class*="Error"]', 'div[class*="red"]', 'div[class*="Red"]',
      ];
      const texts = [];
      for (const selector of selectors) {
        document.querySelectorAll(selector).forEach((element) => {
          const text = (element.textContent || '').trim();
          if (text && text.length < 2000) texts.push(text);
        });
      }
      const assistants = document.querySelectorAll('[data-message-author-role="assistant"]');
      const last = assistants[assistants.length - 1];
      if (last) texts.push((last.textContent || '').trim());
      return texts.join('\n');
    });
    if (!bodyText) return null;
    for (const pattern of RATE_LIMIT_PATTERNS) {
      if (pattern.test(bodyText)) return new QueueError(bodyText.slice(0, 500), 'rate_limit');
    }
    for (const pattern of SAFETY_PATTERNS) {
      if (pattern.test(bodyText)) return new QueueError(bodyText.slice(0, 500), 'safety');
    }
    return null;
  } catch {
    return null;
  }
}
