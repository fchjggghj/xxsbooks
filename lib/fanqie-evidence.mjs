import fs from 'node:fs/promises';
import path from 'node:path';
import { fanqieWorkStateDir } from './fanqie-state.mjs';

function safePart(value) {
  return String(value || '').replace(/[<>:"/\\|?*\x00-\x1F]/gu, '_').slice(0, 80);
}

export async function captureFanqieFailure(page, projectRoot, binding, chapter, error) {
  const dir = path.join(fanqieWorkStateDir(projectRoot, binding), 'failures');
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const prefix = `${stamp}-chapter-${String(chapter?.chapterNumber || 'unknown').padStart(4, '0')}-${safePart(chapter?.title || 'unknown')}`;
  const screenshotFile = path.join(dir, `${prefix}.png`);
  const htmlFile = path.join(dir, `${prefix}.html`);
  const jsonFile = path.join(dir, `${prefix}.json`);
  const failures = [];
  await page?.screenshot({ path: screenshotFile, fullPage: true }).catch((captureError) => failures.push(`screenshot: ${captureError.message}`));
  const html = await page?.content().catch((captureError) => {
    failures.push(`html: ${captureError.message}`);
    return '';
  });
  if (html) await fs.writeFile(htmlFile, html, 'utf8');
  await fs.writeFile(jsonFile, `${JSON.stringify({
    at: new Date().toISOString(), workId: binding.workId, workTitle: binding.workTitle,
    chapterNumber: chapter?.chapterNumber || null, chapterTitle: chapter?.title || '',
    url: page?.url?.() || '', error: error?.message || String(error), captureFailures: failures,
  }, null, 2)}\n`, 'utf8');
  return {
    screenshotFile: failures.some((item) => item.startsWith('screenshot:')) ? null : screenshotFile,
    htmlFile: html ? htmlFile : null,
    jsonFile,
    captureFailures: failures,
  };
}
