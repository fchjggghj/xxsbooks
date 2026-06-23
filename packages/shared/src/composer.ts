import fs from 'node:fs';
import path from 'node:path';
import type { NewBook, NewBookChapter } from './types.js';

const NEW_BOOKS_DIR = 'data/03_composed';
const BOOKS_INDEX_FILE = 'books_index.json';

function getNewBooksRoot(pipelineRoot: string): string {
  return path.join(pipelineRoot, NEW_BOOKS_DIR);
}

function getBooksIndexPath(pipelineRoot: string): string {
  return path.join(getNewBooksRoot(pipelineRoot), BOOKS_INDEX_FILE);
}

export function loadNewBooks(pipelineRoot: string): NewBook[] {
  const indexPath = getBooksIndexPath(pipelineRoot);
  if (fs.existsSync(indexPath)) {
    try {
      const content = fs.readFileSync(indexPath, 'utf8');
      return JSON.parse(content) as NewBook[];
    } catch {
      // fall through to scan directory
    }
  }

  const root = getNewBooksRoot(pipelineRoot);
  if (!fs.existsSync(root)) return [];

  const books: NewBook[] = [];
  const bookDirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());

  for (const bookDir of bookDirs) {
    const bookPath = path.join(root, bookDir.name, 'book.json');
    if (fs.existsSync(bookPath)) {
      try {
        const content = fs.readFileSync(bookPath, 'utf8');
        const book = JSON.parse(content) as NewBook;
        books.push(book);
      } catch {
        continue;
      }
    }
  }

  if (books.length > 0) {
    saveBooksIndex(pipelineRoot, books);
  }

  return books;
}

export function getNewBookById(pipelineRoot: string, bookId: string): NewBook | undefined {
  const books = loadNewBooks(pipelineRoot);
  return books.find((book) => book.id === bookId);
}

export function createNewBook(pipelineRoot: string, book: Omit<NewBook, 'id' | 'createdAt'>): NewBook {
  const books = loadNewBooks(pipelineRoot);
  const newBook: NewBook = {
    ...book,
    id: `book-${Date.now()}`,
    createdAt: new Date().toISOString(),
  };

  books.push(newBook);
  saveBooksIndex(pipelineRoot, books);

  const bookDir = path.join(getNewBooksRoot(pipelineRoot), newBook.id);
  fs.mkdirSync(bookDir, { recursive: true });
  const outputPath = path.join(bookDir, 'metadata.json');
  fs.writeFileSync(outputPath, JSON.stringify(newBook, null, 2), 'utf8');

  return newBook;
}

export function updateNewBook(pipelineRoot: string, bookId: string, updates: Partial<NewBook>): NewBook | undefined {
  const books = loadNewBooks(pipelineRoot);
  const index = books.findIndex((book) => book.id === bookId);
  if (index === -1) return undefined;

  books[index] = { ...books[index], ...updates };
  saveBooksIndex(pipelineRoot, books);

  const bookDir = path.join(getNewBooksRoot(pipelineRoot), bookId);
  fs.mkdirSync(bookDir, { recursive: true });
  const outputPath = path.join(bookDir, 'metadata.json');
  fs.writeFileSync(outputPath, JSON.stringify(books[index], null, 2), 'utf8');

  return books[index];
}

export function deleteNewBook(pipelineRoot: string, bookId: string): boolean {
  const books = loadNewBooks(pipelineRoot);
  const index = books.findIndex((book) => book.id === bookId);
  if (index === -1) return false;

  books.splice(index, 1);
  saveBooksIndex(pipelineRoot, books);

  const bookDir = path.join(getNewBooksRoot(pipelineRoot), bookId);
  if (fs.existsSync(bookDir)) {
    fs.rmSync(bookDir, { recursive: true, force: true });
  }

  return true;
}

export function addChapterToBook(pipelineRoot: string, bookId: string, chapter: Omit<NewBookChapter, 'id'>): NewBook | undefined {
  const book = getNewBookById(pipelineRoot, bookId);
  if (!book) return undefined;

  const newChapter: NewBookChapter = {
    ...chapter,
    id: `ch-${Date.now()}`,
  };

  book.chapters.push(newChapter);
  book.totalChapters = book.chapters.length;
  book.wordCount += chapter.content.length;

  const bookDir = path.join(getNewBooksRoot(pipelineRoot), bookId);
  fs.mkdirSync(bookDir, { recursive: true });

  const chapterFile = path.join(bookDir, `${newChapter.index}_${newChapter.title.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_')}.md`);
  fs.writeFileSync(chapterFile, newChapter.content, 'utf8');

  return updateNewBook(pipelineRoot, bookId, book);
}

export function removeChapterFromBook(pipelineRoot: string, bookId: string, chapterId: string): NewBook | undefined {
  const book = getNewBookById(pipelineRoot, bookId);
  if (!book) return undefined;

  const chapterIndex = book.chapters.findIndex((ch) => ch.id === chapterId);
  if (chapterIndex === -1) return undefined;

  const removedChapter = book.chapters[chapterIndex];
  book.chapters.splice(chapterIndex, 1);
  book.totalChapters = book.chapters.length;
  book.wordCount -= removedChapter.content.length;

  book.chapters.forEach((ch, idx) => {
    ch.index = idx + 1;
  });

  return updateNewBook(pipelineRoot, bookId, book);
}

export function exportBookOutline(pipelineRoot: string, bookId: string): string | null {
  const book = getNewBookById(pipelineRoot, bookId);
  if (!book) return null;

  const outlineLines: string[] = [];
  outlineLines.push(`# ${book.title}`);
  outlineLines.push(`作者：${book.author}`);
  outlineLines.push(`题材：${book.genre}`);
  outlineLines.push(`简介：${book.description}`);
  outlineLines.push('');
  outlineLines.push('## 大纲');

  book.chapters.forEach((chapter) => {
    outlineLines.push(`\n### 第${chapter.index}章 ${chapter.title}`);
    outlineLines.push(chapter.content);
  });

  const bookDir = path.join(getNewBooksRoot(pipelineRoot), bookId);
  const outputPath = path.join(bookDir, 'outline.md');
  fs.writeFileSync(outputPath, outlineLines.join('\n'), 'utf8');

  return outputPath;
}

function saveBooksIndex(pipelineRoot: string, books: NewBook[]): void {
  const indexPath = getBooksIndexPath(pipelineRoot);
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify(books, null, 2), 'utf8');
}