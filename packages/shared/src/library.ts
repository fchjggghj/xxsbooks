import fs from 'node:fs';
import path from 'node:path';
import type { Book, BookMeta } from './types.js';
import { writeFile, fileExists, listDirs, readFile } from './files.js';

const LIBRARY_META_FILE = 'books.json';
const CHAPTERS_DIR = '章节';
const TXT_EXT = '.txt';

function generateBookId(name: string): string {
  const match = name.match(/^(\d{4})_/);
  if (match) return match[1];
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

function extractReaderCount(name: string): string | undefined {
  const match = name.match(/【在读：([^】]+)】/);
  return match ? match[1] : undefined;
}

function countChapters(bookPath: string): number {
  const chaptersDir = path.join(bookPath, CHAPTERS_DIR);
  if (!fileExists(chaptersDir)) return 0;
  try {
    return fs.readdirSync(chaptersDir).filter((f) => f.endsWith(TXT_EXT)).length;
  } catch {
    return 0;
  }
}

function countWords(bookPath: string): number {
  const chaptersDir = path.join(bookPath, CHAPTERS_DIR);
  if (!fileExists(chaptersDir)) return 0;
  let total = 0;
  try {
    const files = fs.readdirSync(chaptersDir).filter((f) => f.endsWith(TXT_EXT));
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(chaptersDir, file), 'utf8');
        total += content.length;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return total;
}

function parseBookName(name: string): { id: string; name: string; author: string } {
  const id = generateBookId(name);
  const cleanName = name.replace(/^(\d{4})_/, '').replace(/【在读：[^】]+】$/, '');
  return { id, name: cleanName, author: '' };
}

export function getLibraryPath(pipelineRoot: string): string {
  return path.join(pipelineRoot, 'data', 'library');
}

export function getLibraryMetaPath(pipelineRoot: string): string {
  return path.join(getLibraryPath(pipelineRoot), LIBRARY_META_FILE);
}

export function loadLibraryMeta(pipelineRoot: string): BookMeta {
  const metaPath = getLibraryMetaPath(pipelineRoot);
  if (fileExists(metaPath)) {
    try {
      const raw = readFile(metaPath);
      return JSON.parse(raw) as BookMeta;
    } catch {
      /* ignore */
    }
  }
  return { books: [] };
}

export function saveLibraryMeta(pipelineRoot: string, meta: BookMeta): void {
  const metaPath = getLibraryMetaPath(pipelineRoot);
  writeFile(metaPath, JSON.stringify(meta, null, 2));
}

export function scanLibrary(pipelineRoot: string): Book[] {
  const libraryPath = getLibraryPath(pipelineRoot);
  if (!fileExists(libraryPath)) {
    fs.mkdirSync(libraryPath, { recursive: true });
    return [];
  }

  const bookDirs = listDirs(libraryPath);
  const books: Book[] = [];

  for (const dirName of bookDirs) {
    const bookPath = path.join(libraryPath, dirName);
    const { id, name, author } = parseBookName(dirName);
    const totalChapters = countChapters(bookPath);
    const wordCount = countWords(bookPath);
    const readerCount = extractReaderCount(dirName);

    books.push({
      id,
      name: readerCount ? `${name}【在读：${readerCount}】` : name,
      author,
      source: 'local',
      tags: [],
      totalChapters,
      wordCount,
      status: totalChapters > 0 ? 'raw' : 'broken',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  return books;
}

export function syncLibraryMeta(pipelineRoot: string): BookMeta {
  const books = scanLibrary(pipelineRoot);
  const meta: BookMeta = { books };
  saveLibraryMeta(pipelineRoot, meta);
  return meta;
}

export function addBookToLibrary(
  pipelineRoot: string,
  sourcePath: string,
  options?: { name?: string; author?: string; tags?: string[] },
): Book {
  const libraryPath = getLibraryPath(pipelineRoot);
  fs.mkdirSync(libraryPath, { recursive: true });

  const sourceName = path.basename(sourcePath);
  const bookId = generateBookId(sourceName);
  const bookName = options?.name || sourceName;
  const destPath = path.join(libraryPath, bookName);

  if (!fileExists(destPath)) {
    fs.cpSync(sourcePath, destPath, { recursive: true });
  }

  const totalChapters = countChapters(destPath);
  const wordCount = countWords(destPath);

  const book: Book = {
    id: bookId,
    name: bookName,
    author: options?.author || '',
    source: 'imported',
    tags: options?.tags || [],
    totalChapters,
    wordCount,
    status: totalChapters > 0 ? 'raw' : 'broken',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const meta = loadLibraryMeta(pipelineRoot);
  const existingIndex = meta.books.findIndex((b) => b.id === bookId);
  if (existingIndex >= 0) {
    meta.books[existingIndex] = book;
  } else {
    meta.books.push(book);
  }
  saveLibraryMeta(pipelineRoot, meta);

  return book;
}

export function updateBookMeta(
  pipelineRoot: string,
  bookId: string,
  updates: Partial<Omit<Book, 'id' | 'createdAt' | 'updatedAt'>>,
): Book | null {
  const meta = loadLibraryMeta(pipelineRoot);
  const index = meta.books.findIndex((b) => b.id === bookId);
  if (index < 0) return null;

  meta.books[index] = {
    ...meta.books[index],
    ...updates,
    updatedAt: new Date().toISOString(),
  };
  saveLibraryMeta(pipelineRoot, meta);

  return meta.books[index];
}

export function removeBookFromLibrary(pipelineRoot: string, bookId: string): boolean {
  const meta = loadLibraryMeta(pipelineRoot);
  const index = meta.books.findIndex((b) => b.id === bookId);
  if (index < 0) return false;

  const book = meta.books[index];
  const bookPath = path.join(getLibraryPath(pipelineRoot), book.name);
  if (fileExists(bookPath)) {
    fs.rmSync(bookPath, { recursive: true });
  }

  meta.books.splice(index, 1);
  saveLibraryMeta(pipelineRoot, meta);

  return true;
}

export function getBookById(pipelineRoot: string, bookId: string): Book | null {
  const meta = loadLibraryMeta(pipelineRoot);
  return meta.books.find((b) => b.id === bookId) || null;
}

export function searchBooks(pipelineRoot: string, query: string): Book[] {
  const meta = loadLibraryMeta(pipelineRoot);
  const lowerQuery = query.toLowerCase();
  return meta.books.filter(
    (b) =>
      b.name.toLowerCase().includes(lowerQuery) ||
      b.author.toLowerCase().includes(lowerQuery) ||
      b.tags.some((t) => t.toLowerCase().includes(lowerQuery)),
  );
}

export function getBooksByStatus(pipelineRoot: string, status: Book['status']): Book[] {
  const meta = loadLibraryMeta(pipelineRoot);
  return meta.books.filter((b) => b.status === status);
}

export function migrateRawChapters(pipelineRoot: string): void {
  const rawRoot = path.join(pipelineRoot, 'data', '00_raw_chapters');
  const libraryPath = getLibraryPath(pipelineRoot);

  if (!fileExists(rawRoot)) return;

  const rawDirs = listDirs(rawRoot);
  for (const dirName of rawDirs) {
    const sourcePath = path.join(rawRoot, dirName);
    const destPath = path.join(libraryPath, dirName);
    if (!fileExists(destPath)) {
      fs.cpSync(sourcePath, destPath, { recursive: true });
    }
  }

  syncLibraryMeta(pipelineRoot);
}