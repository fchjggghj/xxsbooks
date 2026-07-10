import fs from 'node:fs/promises';
import path from 'node:path';

function cleanText(value, maxLength = 1200) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, maxLength);
}

export function classifyQueueError(error) {
  if (error?.kind) return error.kind;
  const message = cleanText(error?.message || error).toLowerCase();
  if (/timeout|timed out|超时/.test(message)) return 'timeout';
  if (/login|log in|sign in|unauthorized|403|登录/.test(message)) return 'login';
  if (/selector|locator|composer|button|textarea|输入框|按钮/.test(message)) return 'page_structure';
  if (/network|fetch|socket|econn|dns|connection/.test(message)) return 'network';
  if (/prompt.{0,20}(large|long)|上下文|字符上限/.test(message)) return 'prompt_too_large';
  return 'unknown';
}

export async function appendJsonlLog(file, event, fields = {}) {
  const record = {
    time: new Date().toISOString(),
    event: cleanText(event, 80),
    ...fields,
  };
  if (record.error) record.error = cleanText(record.error);
  if (record.message) record.message = cleanText(record.message);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

export async function safeAppendJsonlLog(file, event, fields = {}, onError = null) {
  try {
    return await appendJsonlLog(file, event, fields);
  } catch (error) {
    if (onError) onError(error);
    return null;
  }
}
