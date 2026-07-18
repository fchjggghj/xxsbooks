import { chromium } from 'playwright-core';
import { calculateFanqiePublishAt, normalizeChapterTitle } from './fanqie-config.mjs';
import { assertFanqiePageContract } from './fanqie-page-contract.mjs';

const DEFAULT_TIMEOUT = 25_000;
const SAFE_DISMISS_BUTTON = /^(?:我知道了|知道了|下次再说|暂不|关闭|完成)$/u;

async function installFanqieOverlayHandlers(page) {
  const guide = page.locator('.publish-tour-guide.reactour__helper--is-open');
  await page.addLocatorHandler(guide, async (overlay) => {
    for (let step = 0; step < 6 && await overlay.isVisible().catch(() => false); step++) {
      const next = overlay.locator('button.guide-card-footer-btn').first();
      if (!await next.isVisible().catch(() => false)) break;
      await next.click();
      await page.waitForTimeout(100);
    }
  });
  const safeDialog = page.locator('.arco-modal').filter({
    has: page.getByRole('button', { name: SAFE_DISMISS_BUTTON }),
  });
  await page.addLocatorHandler(safeDialog, async (dialog) => {
    await dialog.getByRole('button', { name: SAFE_DISMISS_BUTTON }).first().click();
  });
}

export function fanqieChapterManageUrl(binding) {
  return `https://fanqienovel.com/main/writer/chapter-manage/${binding.workId}&${encodeURIComponent(binding.workTitle)}?type=1`;
}

export async function connectFanqieBrowser(binding, options = {}) {
  const timeout = Number(options.timeout || DEFAULT_TIMEOUT);
  let browser;
  try {
    browser = await chromium.connectOverCDP(binding.cdpUrl, { timeout });
  } catch (error) {
    throw new Error(`无法连接番茄浏览器 ${binding.cdpUrl}；请先运行 fanqie:chrome。${error.message}`);
  }
  const context = browser.contexts()[0];
  if (!context) throw new Error('番茄浏览器没有可用上下文');
  const page = await context.newPage();
  page.setDefaultTimeout(timeout);
  await installFanqieOverlayHandlers(page);
  return { browser, context, page };
}

async function assertWriterLogin(page, binding) {
  const body = await page.locator('body').innerText().catch(() => '');
  if (/登录|扫码登录|手机号登录/.test(body) && !body.includes(binding.workTitle)) {
    throw new Error('番茄账号登录态已失效；请在绑定的 Chrome Profile 中重新登录作家后台');
  }
  if (!body.includes(binding.workTitle)) {
    throw new Error(`当前账号未打开目标作品“${binding.workTitle}”，请核对 workId、书名和绑定账号`);
  }
}

async function waitForChapterManager(page, binding) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction((workTitle) => {
    const text = document.body?.innerText || '';
    return text.includes(workTitle) || /登录|扫码登录|手机号登录/.test(text);
  }, binding.workTitle, { timeout: 15_000 }).catch(() => {});
  await assertWriterLogin(page, binding);
  await page.waitForFunction(() => {
    const text = document.body?.innerText || '';
    const hasCreateEntry = [...document.querySelectorAll('a, button')]
      .some((element) => element.textContent.trim() === '新建章节');
    return Boolean(document.querySelector('tbody tr')) || text.includes('暂无章节') || hasCreateEntry;
  });
  // 番茄章节表由接口异步填充。DOM ready 或“新建章节”出现时，tbody 仍可能短暂为空。
  // 等网络安静后再读取，避免把已有待发布章节误判为 0 章并重复提交。
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(350);
  await assertFanqiePageContract(page, 'manager');
}

async function tableRows(page) {
  return page.locator('tbody tr').evaluateAll((rows) => rows.map((row) => {
    const cells = [...row.querySelectorAll('td')];
    const href = cells[0]?.querySelector('a')?.getAttribute('href') || '';
    const ids = href.match(/\d{8,}/g) || [];
    const title = cells[0]?.innerText.trim() || '';
    const displayedChapterNumber = Number(title.match(/^第\s*(\d+)\s*章/u)?.[1] || 0);
    return {
      title,
      displayedChapterNumber,
      words: cells[1]?.innerText.trim() || '',
      typoCount: cells[2]?.innerText.trim() || '',
      status: cells[3]?.innerText.trim() || '',
      publishAt: cells[4]?.innerText.trim() || '',
      remoteChapterId: ids.at(-1) || '',
      href,
    };
  }));
}

export async function inspectFanqieRemoteChapters(page, binding) {
  await page.goto(fanqieChapterManageUrl(binding), { waitUntil: 'domcontentloaded' });
  await waitForChapterManager(page, binding);
  const pageNumbers = await page.locator('.arco-pagination-item[aria-label^="第 "]').evaluateAll((items) => items
    .map((item) => Number(item.textContent.trim()))
    .filter((value) => Number.isInteger(value)));
  const totalPages = Math.max(1, ...pageNumbers);
  const newestFirst = [];
  for (let number = 1; number <= totalPages; number++) {
    if (number > 1) {
      const previousSignature = await page.locator('tbody tr td:first-child').allInnerTexts();
      const item = page.locator(`.arco-pagination-item[aria-label="第 ${number} 页"]`);
      await item.click();
      await page.locator(`.arco-pagination-item[aria-current="true"]`).filter({ hasText: String(number) }).waitFor();
      await page.waitForFunction((previous) => {
        const current = [...document.querySelectorAll('tbody tr td:first-child')]
          .map((cell) => cell.textContent.trim());
        return current.length > 0 && JSON.stringify(current) !== JSON.stringify(previous);
      }, previousSignature);
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(350);
    }
    newestFirst.push(...await tableRows(page));
  }
  const numbered = newestFirst.filter((item) => item.displayedChapterNumber > 0);
  if (numbered.length === newestFirst.length) {
    const unique = new Map(numbered.map((item) => [item.displayedChapterNumber, item]));
    const ordered = [...unique.values()].sort((a, b) => a.displayedChapterNumber - b.displayedChapterNumber);
    if (unique.size !== newestFirst.length) {
      throw new Error('番茄章节分页出现重复行，已停止；请重试远端状态检查');
    }
    for (let index = 0; index < ordered.length; index++) {
      if (ordered[index].displayedChapterNumber !== index + 1) {
        throw new Error(`番茄章节分页不连续：期望第 ${index + 1} 章，读到第 ${ordered[index].displayedChapterNumber} 章`);
      }
    }
    return ordered.map((item) => ({ ...item, chapterNumber: item.displayedChapterNumber }));
  }
  return newestFirst.reverse().map((item, index) => ({ ...item, chapterNumber: index + 1 }));
}

async function insertChapterBody(page, chapter) {
  // 番茄会在账号首次遇到分卷编辑器时弹出三步 Reactour 引导。
  // 引导层存在时 execCommand 能把文字画到编辑器里，但站点不会更新“正文字数”，
  // 最终导致等待字数确认超时。先完整走完引导，再写入正文。
  const guide = page.locator('.publish-tour-guide.reactour__helper--is-open');
  const dismissGuides = async () => {
    let dismissed = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (!await guide.isVisible().catch(() => false)) break;
      const next = guide.locator('button.guide-card-footer-btn');
      await next.click();
      dismissed = true;
      await page.waitForTimeout(150);
    }
    if (await guide.isVisible().catch(() => false)) {
      throw new Error('番茄编辑器新手引导未能自动关闭，已停止以避免正文录入状态不一致');
    }
    return dismissed;
  };
  await dismissGuides();
  const editor = page.locator('.serial-editor-content > .syl-editor-container .ProseMirror').first();
  await editor.waitFor({ state: 'visible' });
  const writeBody = () => editor.evaluate((element, text) => {
    element.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: text,
    }));
  }, chapter.body);
  await writeBody();
  const contentMatches = (expectedBody) => {
    const match = (document.body?.innerText || '').match(/正文字数\s*(\d+)/u);
    const editorText = document.querySelector('.serial-editor-content > .syl-editor-container .ProseMirror')?.innerText || '';
    return Number(match?.[1] || 0) > 0
      && editorText.replace(/\s/gu, '') === String(expectedBody).replace(/\s/gu, '');
  };
  const counted = await page.waitForFunction(contentMatches, chapter.body, { timeout: 1_500 })
    .then(() => true)
    .catch(() => false);
  if (!counted) {
    await guide.waitFor({ state: 'visible', timeout: 2_500 }).catch(() => {});
    if (await dismissGuides()) await writeBody();
  }
  await page.waitForFunction(contentMatches, chapter.body);
  const customTitleFormat = page.getByText('自定义标题格式', { exact: true });
  if (await customTitleFormat.isVisible().catch(() => false)) await customTitleFormat.click();
  const chapterNumber = page.locator('.serial-editor-title-left input').first();
  if (await chapterNumber.isVisible().catch(() => false)) await chapterNumber.fill(String(chapter.chapterNumber));
  const title = page.getByPlaceholder('请输入标题');
  await title.fill(chapter.title);
  await title.press('Tab');
  await page.waitForFunction(([expectedNumber, expectedTitle]) => {
    const titleInput = document.querySelector('input[placeholder="请输入标题"]');
    const numberInput = document.querySelector('.serial-editor-title-left input');
    return titleInput?.value === expectedTitle && (!numberInput || numberInput.value === String(expectedNumber));
  }, [chapter.chapterNumber, chapter.title]);
}

async function clickEnabledNext(page) {
  const next = page.locator('button.auto-editor-next:not([disabled])');
  await next.waitFor({ state: 'visible', timeout: 15_000 });
  await next.click();
}

async function chooseBasicDetection(page) {
  const typoPrompt = page.getByText('检测到你还有错别字未修改', { exact: false });
  const detectionPrompt = page.getByText('请选择内容检测方式', { exact: false });
  await Promise.race([
    typoPrompt.waitFor({ state: 'visible' }),
    detectionPrompt.waitFor({ state: 'visible' }),
  ]);
  if (await typoPrompt.isVisible()) {
    await page.getByRole('button', { name: '提交', exact: true }).click();
    await detectionPrompt.waitFor({ state: 'visible' });
  }
  await page.getByRole('button', { name: '仅基础检测', exact: true }).click();
}

async function setAiDisclosure(page, aiUsed) {
  const selected = await page.evaluate((expectedValue) => {
    const label = [...document.querySelectorAll('.card-content-line-label')]
      .find((element) => element.textContent.includes('是否使用AI'));
    const row = label?.closest('.card-content-line');
    const input = row?.querySelector(`input[type="radio"][value="${expectedValue}"]`);
    if (!input) return false;
    input.click();
    return input.checked;
  }, aiUsed ? '1' : '2');
  if (!selected) throw new Error('发布设置中未能选中“是否使用AI”选项');
}

async function setScheduleEnabled(page) {
  const switches = page.locator('[role="switch"]');
  const count = await switches.count();
  if (!count) throw new Error('发布设置中未找到定时发布开关');
  const scheduleSwitch = switches.nth(count - 1);
  if (await scheduleSwitch.getAttribute('aria-checked') !== 'true') await scheduleSwitch.click();
}

function monthIndex(year, month) {
  return year * 12 + month - 1;
}

async function displayedCalendarMonth(page) {
  const text = await page.locator('.arco-picker-header-value').innerText();
  const match = text.replace(/\s/g, '').match(/(\d{4})年(\d{1,2})月/);
  if (!match) throw new Error(`无法识别日期选择器月份: ${text}`);
  return { year: Number(match[1]), month: Number(match[2]) };
}

async function selectPublishDate(page, dateText) {
  const [year, month, day] = dateText.split('-').map(Number);
  const input = page.getByPlaceholder('请选择日期');
  await input.click();
  await page.locator('.arco-picker-header-value').waitFor({ state: 'visible' });
  for (let attempt = 0; attempt < 36; attempt++) {
    const current = await displayedCalendarMonth(page);
    const delta = monthIndex(year, month) - monthIndex(current.year, current.month);
    if (delta === 0) break;
    const icon = delta > 0 ? '.arco-icon-right' : '.arco-icon-left';
    await page.locator(`.arco-picker-header ${icon}`).locator('..').click();
    await page.waitForTimeout(150);
    if (attempt === 35) throw new Error(`日期选择器无法移动到 ${year}-${month}`);
  }
  const clicked = await page.evaluate((targetDay) => {
    const item = [...document.querySelectorAll('.arco-picker-cell-in-view .arco-picker-date-value')]
      .find((element) => element.textContent.trim() === String(targetDay));
    if (!item) return false;
    item.parentElement.parentElement.click();
    return true;
  }, day);
  if (!clicked) throw new Error(`日期选择器中找不到 ${dateText}`);
  await page.waitForFunction((expected) => document.querySelector('input[placeholder="请选择日期"]')?.value === expected, dateText);
}

async function selectPublishTime(page, timeText) {
  const input = page.getByPlaceholder('请选择时间');
  if (await input.inputValue() === timeText) return;
  await input.click();
  await input.press('Control+A');
  await input.fill(timeText);
  await input.press('Enter');
  await page.waitForTimeout(150);
  if (await input.inputValue() !== timeText) {
    throw new Error(`无法把发布时间设为 ${timeText}；请使用页面支持的 HH:mm 时间`);
  }
}

async function configurePublish(page, binding, chapter) {
  await page.getByText('发布设置', { exact: true }).waitFor({ state: 'visible' });
  await setAiDisclosure(page, binding.aiUsed);
  await setScheduleEnabled(page);
  const publishAt = calculateFanqiePublishAt(chapter.chapterNumber, binding.schedule);
  await selectPublishDate(page, publishAt.date);
  await selectPublishTime(page, publishAt.time);
  const selectedDate = await page.getByPlaceholder('请选择日期').inputValue();
  const selectedTime = await page.getByPlaceholder('请选择时间').inputValue();
  if (selectedDate !== publishAt.date || selectedTime !== publishAt.time) {
    throw new Error(`第 ${chapter.chapterNumber} 章排期校验失败: ${selectedDate} ${selectedTime}`);
  }
  return publishAt;
}

async function verifyLatestRow(page, chapter, publishAt) {
  // 作家后台是 SPA，提交成功后会切换路由，但不保证再次触发完整 load 事件。
  await page.waitForFunction(() => location.pathname.includes('/chapter-manage/'));
  await waitForChapterManager(page, { workTitle: chapter.workTitle });
  const first = page.locator('tbody tr').first();
  await first.waitFor({ state: 'attached' });
  const cells = first.locator('td');
  const title = await cells.nth(0).innerText();
  const date = await cells.nth(4).innerText();
  if (normalizeChapterTitle(title) !== normalizeChapterTitle(chapter.title) || !date.includes(`${publishAt.date} ${publishAt.time}`)) {
    throw new Error(`第 ${chapter.chapterNumber} 章提交后列表校验失败`);
  }
  const href = await cells.nth(0).locator('a').first().getAttribute('href').catch(() => '');
  const ids = href?.match(/\d{8,}/g) || [];
  return {
    remoteChapterId: ids.at(-1) || '',
    remoteStatus: await cells.nth(3).innerText(),
    remotePublishAt: date,
  };
}

async function findReusableDraft(page, binding, chapter) {
  const pattern = new RegExp(`/main/writer/${binding.workId}/publish/\\d+`);
  for (const candidate of page.context().pages()) {
    if (candidate === page || !pattern.test(candidate.url())) continue;
    const title = await candidate.getByPlaceholder('请输入标题').inputValue().catch(() => null);
    const body = await candidate.locator('.serial-editor-content > .syl-editor-container .ProseMirror').first().innerText().catch(() => null);
    const displayedCount = await candidate.locator('body').innerText().then((text) => Number(text.match(/正文字数\s*(\d+)/u)?.[1] || 0)).catch(() => 0);
    if ((title === '' && String(body || '').trim() === '')
      || (title === chapter.title && displayedCount === chapter.nonWhitespaceLength)) return candidate;
  }
  return null;
}

async function openChapterEditor(page, binding, chapter) {
  const reusable = await findReusableDraft(page, binding, chapter);
  if (reusable) {
    const draftUrl = reusable.url();
    await page.goto(draftUrl, { waitUntil: 'domcontentloaded' });
    await reusable.close().catch(() => {});
    return;
  }
  const createLink = page.getByRole('link', { name: '新建章节', exact: true });
  const href = await createLink.getAttribute('href');
  if (!href) throw new Error('番茄章节管理页未提供“新建章节”链接地址');
  await page.goto(new URL(href, page.url()).href, { waitUntil: 'domcontentloaded' });
}

export async function uploadFanqieChapter(page, binding, chapter, options = {}) {
  if (!page.url().includes('/chapter-manage/')) {
    await page.goto(fanqieChapterManageUrl(binding), { waitUntil: 'domcontentloaded' });
    await waitForChapterManager(page, binding);
  }
  await options.onPhase?.('editing', {});
  await openChapterEditor(page, binding, chapter);
  await page.getByPlaceholder('请输入标题').waitFor({ state: 'visible' });
  await assertFanqiePageContract(page, 'editor');
  await insertChapterBody(page, chapter);
  await clickEnabledNext(page);
  await chooseBasicDetection(page);
  const publishAt = await configurePublish(page, binding, chapter);
  await assertFanqiePageContract(page, 'publish');
  await options.onPhase?.('submitting', { publishAt });
  await page.getByRole('button', { name: '确认发布', exact: true }).click();
  await options.onPhase?.('submitted', { publishAt });
  const remote = await verifyLatestRow(page, { ...chapter, workTitle: binding.workTitle }, publishAt);
  await options.onPhase?.('confirmed', { publishAt, ...remote });
  return { ...publishAt, ...remote };
}

export async function uploadFanqiePlan(page, binding, chapters, options = {}) {
  const results = [];
  for (const chapter of chapters) {
    try {
      const publishAt = await uploadFanqieChapter(page, binding, chapter, {
        onPhase: (phase, fields) => options.onPhase?.(chapter, phase, fields),
      });
      const result = { chapterNumber: chapter.chapterNumber, title: chapter.title, ...publishAt };
      results.push(result);
      await options.onProgress?.(result);
    } catch (error) {
      try {
        await options.onFailure?.(chapter, error);
      } catch (evidenceError) {
        error.evidenceError = evidenceError.message;
      }
      throw error;
    }
  }
  return results;
}
