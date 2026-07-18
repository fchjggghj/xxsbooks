import { chromium } from 'playwright-core';
import { calculateFanqiePublishAt, normalizeChapterTitle } from './fanqie-config.mjs';
import { assertFanqiePageContract } from './fanqie-page-contract.mjs';

const DEFAULT_TIMEOUT = 25_000;

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
    const hasCreateButton = [...document.querySelectorAll('button')]
      .some((button) => button.textContent.trim() === '新建章节');
    return Boolean(document.querySelector('tbody tr')) || text.includes('暂无章节') || hasCreateButton;
  });
  await assertFanqiePageContract(page, 'manager');
}

async function tableRows(page) {
  return page.locator('tbody tr').evaluateAll((rows) => rows.map((row) => {
    const cells = [...row.querySelectorAll('td')];
    const href = cells[0]?.querySelector('a')?.getAttribute('href') || '';
    const ids = href.match(/\d{8,}/g) || [];
    return {
      title: cells[0]?.innerText.trim() || '',
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
      const item = page.locator(`.arco-pagination-item[aria-label="第 ${number} 页"]`);
      await item.click();
      await page.locator(`.arco-pagination-item[aria-current="true"]`).filter({ hasText: String(number) }).waitFor();
      await page.waitForTimeout(250);
    }
    newestFirst.push(...await tableRows(page));
  }
  return newestFirst.reverse().map((item, index) => ({ ...item, chapterNumber: index + 1 }));
}

async function insertChapterBody(page, chapter) {
  await page.getByPlaceholder('请输入标题').fill(chapter.title);
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.waitFor({ state: 'visible' });
  await editor.evaluate((element, text) => {
    element.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: text,
    }));
  }, chapter.body);
  await page.waitForFunction((expected) => {
    const element = document.querySelector('[contenteditable="true"]');
    return element && element.innerText.replace(/\s/gu, '').length === expected;
  }, chapter.nonWhitespaceLength);
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
  const radios = page.locator('input[type="radio"]');
  const count = await radios.count();
  if (count < 2) throw new Error('发布设置中未找到“是否使用AI”选项');
  const target = radios.nth(count - (aiUsed ? 2 : 1));
  await target.check({ force: true });
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
  await page.waitForURL(/\/chapter-manage\//);
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

export async function uploadFanqieChapter(page, binding, chapter, options = {}) {
  if (!page.url().includes('/chapter-manage/')) {
    await page.goto(fanqieChapterManageUrl(binding), { waitUntil: 'domcontentloaded' });
    await waitForChapterManager(page, binding);
  }
  await options.onPhase?.('editing', {});
  await page.getByRole('button', { name: '新建章节', exact: true }).click();
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
