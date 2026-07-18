const CONTRACTS = {
  manager: [
    { code: 'new_chapter_button', pattern: />\s*新建章节\s*</u },
  ],
  editor: [
    { code: 'title_input', pattern: /placeholder=["']请输入标题["']/u },
    { code: 'content_editor', pattern: /contenteditable=["']true["']/u },
  ],
  publish: [
    { code: 'publish_settings', pattern: /发布设置/u },
    { code: 'ai_disclosure', pattern: /是否使用AI/u },
    { code: 'schedule', pattern: /定时发布/u },
    { code: 'confirm_publish', pattern: />\s*确认发布\s*</u },
  ],
};

function decodeHtml(value) {
  return String(value || '')
    .replace(/<[^>]*>/gu, '')
    .replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .trim();
}

export function validateFanqiePageContractHtml(html, pageType) {
  const contract = CONTRACTS[pageType];
  if (!contract) throw new Error(`未知番茄页面契约: ${pageType}`);
  const missing = contract.filter((item) => !item.pattern.test(html)).map((item) => item.code);
  if (pageType === 'manager'
    && !/<tbody[\s>]/iu.test(html)
    && !/暂无章节/u.test(html)
    && !/>\s*新建章节\s*</u.test(html)) {
    missing.push('chapter_list_or_empty_state');
  }
  return { ok: missing.length === 0, pageType, missing };
}

export async function assertFanqiePageContract(page, pageType) {
  const result = validateFanqiePageContractHtml(await page.content(), pageType);
  if (!result.ok) throw new Error(`番茄 ${pageType} 页面结构已变化，缺少契约标记: ${result.missing.join(', ')}`);
  return result;
}

export function parseFanqieManagerFixture(html) {
  const tbody = String(html).match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/iu)?.[1] || '';
  return [...tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/giu)].map((rowMatch) => {
    const cells = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/giu)].map((match) => decodeHtml(match[1]));
    const href = rowMatch[1].match(/<a[^>]+href=["']([^"']+)["']/iu)?.[1] || '';
    const ids = href.match(/\d{8,}/gu) || [];
    return {
      title: cells[0] || '', words: cells[1] || '', typoCount: cells[2] || '',
      status: cells[3] || '', publishAt: cells[4] || '', remoteChapterId: ids.at(-1) || '', href,
    };
  });
}
