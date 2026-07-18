import path from 'node:path';

export function matchesBookFilter(bookFilters, novel) {
  if (!bookFilters?.length) return true;
  return bookFilters.includes(novel.novelKey) || bookFilters.includes(novel.novelName);
}

export function chapterIndexFromFile(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  const match = base.match(/^(\d+)$/);
  return match ? Number(match[1]) : null;
}

export function filterFilesByChapterRange(files, range) {
  if (!range) return [...files];
  return files.filter((file) => {
    const index = chapterIndexFromFile(file.inputPath);
    return index !== null && index >= range.start && index <= range.end;
  });
}
