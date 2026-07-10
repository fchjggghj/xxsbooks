import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { sortVolumeNames } from './naming.mjs';

async function walkFiles(dir, extensions, recursive = true, root = dir) {
  if (!fssync.existsSync(dir)) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && recursive) {
      files.push(...await walkFiles(full, extensions, recursive, root));
    } else if (entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase())) {
      files.push({ inputPath: full, relativePath: path.relative(root, full) });
    }
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'zh-Hans-CN', { numeric: true }));
}

function truncateWithMarker(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false };
  const marker = '\n……（已按上下文预算截断）';
  return { text: `${text.slice(0, Math.max(0, maxChars - marker.length))}${marker}`, truncated: true };
}

export async function collectPriorVolumeContext(options) {
  const {
    bookDir,
    currentVolume,
    inputSubdir = '拆分',
    extensions = ['.txt', '.md'],
    recursive = true,
    summaryFileName = '卷摘要.md',
    maxChars = 30000,
    fallbackCharsPerVolume = 6000,
    extractContent = (raw) => raw,
  } = options;

  const budget = Math.max(0, Number(maxChars || 0));
  if (!budget || !fssync.existsSync(bookDir)) {
    return { text: '', charCount: 0, truncated: false, sources: [], volumeCount: 0 };
  }

  const volumeNames = (await fs.readdir(bookDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort(sortVolumeNames);
  const currentIndex = volumeNames.indexOf(currentVolume);
  if (currentIndex <= 0) {
    return { text: '', charCount: 0, truncated: false, sources: [], volumeCount: 0 };
  }

  const sections = [];
  for (const volumeName of volumeNames.slice(0, currentIndex)) {
    const volumeDir = path.join(bookDir, volumeName);
    const summaryCandidates = [
      path.join(volumeDir, summaryFileName),
      path.join(volumeDir, inputSubdir, summaryFileName),
    ];
    const summaryPath = summaryCandidates.find((candidate) => fssync.existsSync(candidate));
    if (summaryPath) {
      const raw = await fs.readFile(summaryPath, 'utf8');
      sections.push({ volumeName, kind: 'summary', text: extractContent(raw), source: summaryPath });
      continue;
    }

    const sourceDir = path.join(volumeDir, inputSubdir);
    const files = await walkFiles(sourceDir, extensions, recursive, sourceDir);
    const rawParts = [];
    for (const file of files) {
      if (path.basename(file.inputPath) === summaryFileName) continue;
      const raw = await fs.readFile(file.inputPath, 'utf8');
      rawParts.push(`===== ${file.relativePath} =====\n${extractContent(raw)}`);
    }
    const fallback = truncateWithMarker(rawParts.join('\n\n'), Math.max(0, Number(fallbackCharsPerVolume || 0)));
    if (fallback.text) {
      sections.push({ volumeName, kind: 'bounded_fallback', text: fallback.text, source: sourceDir, truncated: fallback.truncated });
    }
  }

  if (!sections.length) {
    return { text: '', charCount: 0, truncated: false, sources: [], volumeCount: 0 };
  }

  const header = '【前序卷背景摘要】\n以下内容仅用于保持人物、伏笔、设定和时间线连续：\n\n';
  const perSectionBudget = Math.max(200, Math.floor((budget - header.length - sections.length * 24) / sections.length));
  let truncated = false;
  const rendered = sections.map((section) => {
    const clipped = truncateWithMarker(section.text, perSectionBudget);
    truncated ||= Boolean(section.truncated || clipped.truncated);
    const sourceLabel = section.kind === 'summary' ? '卷摘要' : '有界原始提纲';
    return `## ${section.volumeName}（${sourceLabel}）\n${clipped.text}`;
  });
  const final = truncateWithMarker(`${header}${rendered.join('\n\n')}`, budget);
  truncated ||= final.truncated;
  return {
    text: final.text ? `${final.text}\n\n` : '',
    charCount: final.text.length,
    truncated,
    volumeCount: sections.length,
    sources: sections.map((section) => ({ volume: section.volumeName, kind: section.kind, path: section.source })),
  };
}
