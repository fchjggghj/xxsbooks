export function normalizeAssistantText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/^\s*编辑\s*(?=第\s*\d+\s*章)/u, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
