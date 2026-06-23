import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright-core';
import {
  type AdaptDirection,
  type DirectionConfig,
  type OutlineItem,
  type Novel,
  log,
  errorMessage,
  isBrowserClosedError,
  sleep,
  loadConfig as loadConfigFile,
  getConfigPath,
  getPages,
  newConversation,
  sendAndCollect,
  hitRateLimit,
} from '@novel-pipeline/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

const MIN_DONE_BYTES = 500;

function loadConfig(): DirectionConfig {
  const cfgPath = getConfigPath('direction', PROJECT_ROOT);
  return loadConfigFile<DirectionConfig>(cfgPath);
}

function listNovels(inputRoot: string, novelsFilter: string[]): Novel[] {
  if (!fs.existsSync(inputRoot)) {
    throw new Error(`输入根目录不存在: ${inputRoot}`);
  }
  let names: string[];
  if (Array.isArray(novelsFilter) && novelsFilter.length) {
    names = novelsFilter.slice();
  } else {
    names = fs
      .readdirSync(inputRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }
  return names.map((name) => ({
    name,
    path: path.join(inputRoot, name),
    totalChapters: 0,
    selectedChapters: 0,
    doneChapters: 0,
    failedChapters: 0,
    pendingChapters: 0,
  }));
}

function extractStoryArc(name: string): string {
  let s = name.replace(/\.md$/, '');
  s = s.replace(/^第\d+章_/, '');
  s = s.replace(/[（(][^（(）)]*[）)]\s*$/, '');
  s = s.replace(/\d+$/, '');
  s = s.replace(/×/g, 'x').replace(/（/g, '(').replace(/）/g, ')');
  return s.trim();
}

function groupByStoryArc(novel: Novel, inputDir: string, inputExt: string): Map<string, OutlineItem[]> {
  const inDir = path.join(inputDir, novel.name);
  if (!fs.existsSync(inDir)) return new Map();

  const files = fs
    .readdirSync(inDir)
    .filter((f) => f.toLowerCase().endsWith(inputExt.toLowerCase()))
    .sort((a, b) => {
      const na = parseInt(a.match(/\d+/)?.[0] || '0', 10);
      const nb = parseInt(b.match(/\d+/)?.[0] || '0', 10);
      return na - nb;
    });

  const groups = new Map<string, OutlineItem[]>();

  for (const name of files) {
    const arc = extractStoryArc(name);
    const base = name.replace(new RegExp(`${inputExt}$`, 'i'), '');
    const outline: OutlineItem = {
      name,
      base,
      inputPath: path.join(inDir, name),
      outputPath: '',
      novel,
    };
    const list = groups.get(arc) || [];
    list.push(outline);
    groups.set(arc, list);
  }

  return groups;
}

function generateDirectionId(bookId: string, worldIndex: number): string {
  return `${bookId}-dir-${worldIndex}`;
}

function directionOutputPath(outputRoot: string, bookName: string, worldName: string): string {
  return path.join(outputRoot, bookName, `${worldName}.json`);
}

function isDirectionDone(outputPath: string): boolean {
  try {
    return fs.statSync(outputPath).size >= MIN_DONE_BYTES;
  } catch {
    return false;
  }
}

async function sendDirectionRequest(
  page: Page,
  prompt: string,
  config: DirectionConfig,
): Promise<string> {
  const result = await sendAndCollect(page, prompt, config);

  if (result.error) throw new Error(result.error);
  if (!result.text || result.text.length < MIN_DONE_BYTES) throw new Error('响应内容过短');

  return result.text;
}

function parseDirectionResponse(text: string, bookId: string, worldName: string, worldIndex: number): AdaptDirection | null {
  try {
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) {
      throw new Error('未找到JSON内容');
    }
    const jsonStr = text.slice(jsonStart, jsonEnd + 1);
    const data = JSON.parse(jsonStr);

    return {
      id: generateDirectionId(bookId, worldIndex),
      bookId,
      worldName,
      worldIndex,
      coreConflict: data.coreConflict || '',
      protagonist: {
        name: data.protagonist?.name || '苏然',
        personality: data.protagonist?.personality || '',
        motivation: data.protagonist?.motivation || '',
        arc: data.protagonist?.arc || '',
      },
      tone: data.tone || '',
      readerTarget: data.readerTarget || '',
      keyTwists: Array.isArray(data.keyTwists) ? data.keyTwists : [],
      theme: data.theme || '',
      createdAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function writeDirection(outputPath: string, direction: AdaptDirection): void {
  const dir = path.dirname(outputPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = outputPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(direction, null, 2), 'utf8');
  fs.renameSync(tmp, outputPath);
}

async function processWorld(
  page: Page,
  worldName: string,
  outlines: OutlineItem[],
  bookId: string,
  worldIndex: number,
  config: DirectionConfig,
): Promise<boolean> {
  const outputPath = directionOutputPath(config.outputRoot, outlines[0].novel.name, worldName);

  if (isDirectionDone(outputPath)) {
    log(`  [跳过] ${worldName}（已完成）`);
    return true;
  }

  log(`  [处理] ${worldName}（${outlines.length}章）`);

  const outlineContents = outlines.map((o) => fs.readFileSync(o.inputPath, 'utf8')).join('\n\n');

  const prompt = `${config.promptPrefix}\n\n【小说世界：${worldName}】\n\n${outlineContents}\n\n请输出JSON格式的改编方向建议：`;

  try {
    const response = await sendDirectionRequest(page, prompt, config);
    const direction = parseDirectionResponse(response, bookId, worldName, worldIndex);

    if (!direction) {
      throw new Error('解析改编方向失败');
    }

    writeDirection(outputPath, direction);
    log(`  [完成] ${worldName}（${response.length}字）`);
    return true;
  } catch (err) {
    log(`  [失败] ${worldName}: ${errorMessage(err)}`);
    return false;
  }
}

async function processNovel(page: Page, novel: Novel, config: DirectionConfig): Promise<{ done: number; failed: number }> {
  log(`开始小说: ${novel.name}`);

  const storyArcs = groupByStoryArc(novel, config.inputRoot, '.md');
  const worldIndexMap = new Map<string, number>();

  let idx = 1;
  for (const [arc] of storyArcs) {
    worldIndexMap.set(arc, idx++);
  }

  log(`剧情线分组：共 ${storyArcs.size} 条剧情线`);
  for (const [arc, items] of storyArcs) {
    log(`  [${arc}] ${items.length} 章`);
  }

  let done = 0;
  let failed = 0;

  for (const [worldName, outlines] of storyArcs) {
    const worldIndex = worldIndexMap.get(worldName) || 0;
    const bookId = novel.name.match(/^(\d{4})_/)?.[1] || '';

    const success = await processWorld(page, worldName, outlines, bookId, worldIndex, config);
    if (success) done++;
    else failed++;

    if (await hitRateLimit(page)) {
      log('批量撞配额墙，暂停 30 分钟…');
      await sleep(config.rateLimitWaitMs);
    }

    await sleep(config.betweenChaptersMs);
  }

  return { done, failed };
}

async function main() {
  const config = loadConfig();

  try {
    const novels = listNovels(config.inputRoot, config.novels);
    const totalWorlds = novels.reduce((sum, n) => {
      const arcs = groupByStoryArc(n, config.inputRoot, '.md');
      return sum + arcs.size;
    }, 0);

    console.log(`__PENDING__=${totalWorlds}`);
    log(`处理计划：${novels.length}本小说，${totalWorlds}个世界`);

    const { pages } = await getPages(config, 1);
    const page = pages[0];

    for (const novel of novels) {
      if (await hitRateLimit(page)) {
        log('配额墙，等待重试…');
        await sleep(config.rateLimitWaitMs);
      }

      await newConversation(page, config);

      const { done, failed } = await processNovel(page, novel, config);
      log(`小说 ${novel.name} 完成 ${done} 个世界，失败 ${failed} 个世界`);
    }

    log('所有小说处理完成！');
  } catch (err) {
    if (isBrowserClosedError(err)) {
      log('浏览器关闭');
    }
    log(`运行失败: ${errorMessage(err)}`);
    throw err;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export { main as runDirection };