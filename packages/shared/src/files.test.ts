/**
 * shared/src/files.ts 单元测试
 *
 * 覆盖文件操作、目录列举、计划构建、对话URL持久化的所有边界场景。
 * 使用 os.tmpdir() 创建临时目录，测试后自动清理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  MIN_DONE_BYTES,
  fileExists,
  listFiles,
  listDirs,
  readFile,
  writeFile,
  fileSize,
  isDone,
  listNovels,
  listOutlines,
  buildPlan,
  conversationUrlPath,
  readConversationUrl,
  saveConversationUrl,
  deleteConversationUrl,
} from './files.js';
import type { Novel } from './types.js';

// ---------- 临时目录管理 ----------
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-files-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function join(...parts: string[]): string {
  return path.join(tmpDir, ...parts);
}

// ---------- 辅助：创建文件 ----------
function createFile(relPath: string, content: string): string {
  const p = join(relPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

// ============================================================
// fileExists
// ============================================================
describe('fileExists', () => {
  it('存在的文件返回 true', () => {
    const p = createFile('exists.txt', 'hello');
    expect(fileExists(p)).toBe(true);
  });

  it('不存在的文件返回 false', () => {
    expect(fileExists(join('nonexistent.txt'))).toBe(false);
  });

  it('目录也返回 true', () => {
    fs.mkdirSync(join('subdir'));
    expect(fileExists(join('subdir'))).toBe(true);
  });
});

// ============================================================
// listFiles
// ============================================================
describe('listFiles', () => {
  it('列出指定扩展名的文件', () => {
    createFile('a.txt', '1');
    createFile('b.txt', '2');
    createFile('c.md', '3');
    const files = listFiles(tmpDir, '.txt');
    expect(files).toHaveLength(2);
    expect(files).toContain('a.txt');
    expect(files).toContain('b.txt');
  });

  it('自然排序（第2 < 第10）', () => {
    createFile('第10章.txt', '');
    createFile('第2章.txt', '');
    createFile('第1章.txt', '');
    const files = listFiles(tmpDir, '.txt');
    expect(files).toEqual(['第1章.txt', '第2章.txt', '第10章.txt']);
  });

  it('扩展名大小写不敏感', () => {
    createFile('a.TXT', '');
    createFile('b.txt', '');
    const files = listFiles(tmpDir, '.txt');
    expect(files).toHaveLength(2);
  });

  it('不存在的目录返回空数组', () => {
    expect(listFiles(join('nonexistent'), '.txt')).toEqual([]);
  });

  it('空目录返回空数组', () => {
    expect(listFiles(tmpDir, '.txt')).toEqual([]);
  });

  it('忽略子目录', () => {
    createFile('a.txt', '');
    fs.mkdirSync(join('subdir'));
    const files = listFiles(tmpDir, '.txt');
    expect(files).toEqual(['a.txt']);
  });
});

// ============================================================
// listDirs
// ============================================================
describe('listDirs', () => {
  it('列出子目录', () => {
    fs.mkdirSync(join('novel1'));
    fs.mkdirSync(join('novel2'));
    createFile('file.txt', '');
    const dirs = listDirs(tmpDir);
    expect(dirs).toHaveLength(2);
    expect(dirs).toContain('novel1');
    expect(dirs).toContain('novel2');
  });

  it('自然排序', () => {
    fs.mkdirSync(join('第10本'));
    fs.mkdirSync(join('第2本'));
    fs.mkdirSync(join('第1本'));
    expect(listDirs(tmpDir)).toEqual(['第1本', '第2本', '第10本']);
  });

  it('不存在的目录返回空数组', () => {
    expect(listDirs(join('nonexistent'))).toEqual([]);
  });

  it('忽略文件', () => {
    createFile('a.txt', '');
    fs.mkdirSync(join('subdir'));
    expect(listDirs(tmpDir)).toEqual(['subdir']);
  });
});

// ============================================================
// readFile
// ============================================================
describe('readFile', () => {
  it('读取文件内容', () => {
    const p = createFile('test.txt', 'Hello World');
    expect(readFile(p)).toBe('Hello World');
  });

  it('读取 UTF-8 中文内容', () => {
    const p = createFile('cn.txt', '你好世界');
    expect(readFile(p)).toBe('你好世界');
  });

  it('文件不存在抛出异常', () => {
    expect(() => readFile(join('nonexistent.txt'))).toThrow();
  });
});

// ============================================================
// writeFile（原子写入）
// ============================================================
describe('writeFile', () => {
  it('写入新文件', () => {
    const p = join('output.txt');
    expect(writeFile(p, 'content')).toBe(true);
    expect(fs.readFileSync(p, 'utf8')).toBe('content');
  });

  it('覆盖已有文件', () => {
    const p = join('overwrite.txt');
    writeFile(p, 'old');
    writeFile(p, 'new');
    expect(fs.readFileSync(p, 'utf8')).toBe('new');
  });

  it('自动创建目录', () => {
    const p = join('sub', 'dir', 'file.txt');
    expect(writeFile(p, 'deep')).toBe(true);
    expect(fs.readFileSync(p, 'utf8')).toBe('deep');
  });

  it('不留下 .tmp 文件', () => {
    const p = join('clean.txt');
    writeFile(p, 'data');
    expect(fs.existsSync(p + '.tmp')).toBe(false);
  });

  it('写入空字符串', () => {
    const p = join('empty.txt');
    writeFile(p, '');
    expect(fs.readFileSync(p, 'utf8')).toBe('');
  });
});

// ============================================================
// fileSize
// ============================================================
describe('fileSize', () => {
  it('返回文件字节数', () => {
    const p = createFile('size.txt', 'Hello'); // 5 bytes
    expect(fileSize(p)).toBe(5);
  });

  it('中文字符按 UTF-8 字节计算', () => {
    const p = createFile('cn.txt', '你好'); // 6 bytes (3 per char)
    expect(fileSize(p)).toBe(6);
  });

  it('不存在的文件返回 0', () => {
    expect(fileSize(join('nonexistent'))).toBe(0);
  });

  it('空文件返回 0', () => {
    const p = createFile('empty.txt', '');
    expect(fileSize(p)).toBe(0);
  });
});

// ============================================================
// isDone
// ============================================================
describe('isDone', () => {
  it('文件 >= minBytes 返回 true', () => {
    const p = createFile('done.md', 'x'.repeat(MIN_DONE_BYTES));
    expect(isDone({ outputPath: p } as any)).toBe(true);
  });

  it('文件 < minBytes 返回 false', () => {
    const p = createFile('small.md', 'short');
    expect(isDone({ outputPath: p } as any)).toBe(false);
  });

  it('文件不存在返回 false', () => {
    expect(isDone({ outputPath: join('nonexistent.md') } as any)).toBe(false);
  });

  it('自定义 minBytes', () => {
    const p = createFile('custom.md', '12345'); // 5 bytes
    expect(isDone({ outputPath: p } as any, 5)).toBe(true); // 5 >= 5
    expect(isDone({ outputPath: p } as any, 10)).toBe(false); // 5 < 10
  });
});

// ============================================================
// listNovels
// ============================================================
describe('listNovels', () => {
  it('列出所有子目录为 Novel', () => {
    fs.mkdirSync(join('novel1'));
    fs.mkdirSync(join('novel2'));
    const novels = listNovels(tmpDir);
    expect(novels).toHaveLength(2);
    expect(novels[0].name).toBe('novel1');
    expect(novels[0].path).toBe(join('novel1'));
  });

  it('filter 过滤小说', () => {
    fs.mkdirSync(join('novel1'));
    fs.mkdirSync(join('novel2'));
    fs.mkdirSync(join('novel3'));
    const novels = listNovels(tmpDir, ['novel2']);
    expect(novels).toHaveLength(1);
    expect(novels[0].name).toBe('novel2');
  });

  it('空 filter 列出全部', () => {
    fs.mkdirSync(join('a'));
    fs.mkdirSync(join('b'));
    expect(listNovels(tmpDir, [])).toHaveLength(2);
  });

  it('不存在的目录返回空数组', () => {
    expect(listNovels(join('nonexistent'))).toEqual([]);
  });

  it('Novel 初始计数全为 0', () => {
    fs.mkdirSync(join('test'));
    const novels = listNovels(tmpDir);
    expect(novels[0].totalChapters).toBe(0);
    expect(novels[0].doneChapters).toBe(0);
    expect(novels[0].pendingChapters).toBe(0);
  });
});

// ============================================================
// listOutlines
// ============================================================
describe('listOutlines', () => {
  it('列出输入目录中的大纲条目', () => {
    const novel: Novel = { name: 'test', path: join('test'), totalChapters: 0, selectedChapters: 0, doneChapters: 0, failedChapters: 0, pendingChapters: 0 };
    fs.mkdirSync(join('input', 'test'), { recursive: true });
    createFile('input/test/第001章.txt', 'content');
    createFile('input/test/第002章.txt', 'content');

    const outlines = listOutlines(novel, join('input'), join('output'), '.txt');
    expect(outlines).toHaveLength(2);
    expect(outlines[0].name).toBe('第001章.txt');
    expect(outlines[0].base).toBe('第001章');
    expect(outlines[0].inputPath).toBe(join('input', 'test', '第001章.txt'));
    expect(outlines[0].outputPath).toBe(join('output', 'test', '第001章.txt'));
    expect(outlines[0].novel).toBe(novel);
  });

  it('空目录返回空数组', () => {
    const novel: Novel = { name: 'empty', path: join('empty'), totalChapters: 0, selectedChapters: 0, doneChapters: 0, failedChapters: 0, pendingChapters: 0 };
    fs.mkdirSync(join('input', 'empty'), { recursive: true });
    expect(listOutlines(novel, join('input'), join('output'), '.txt')).toEqual([]);
  });

  it('过滤非匹配扩展名', () => {
    const novel: Novel = { name: 'test', path: join('test'), totalChapters: 0, selectedChapters: 0, doneChapters: 0, failedChapters: 0, pendingChapters: 0 };
    fs.mkdirSync(join('input', 'test'), { recursive: true });
    createFile('input/test/a.txt', '');
    createFile('input/test/b.md', '');
    const outlines = listOutlines(novel, join('input'), join('output'), '.txt');
    expect(outlines).toHaveLength(1);
    expect(outlines[0].name).toBe('a.txt');
  });
});

// ============================================================
// buildPlan
// ============================================================
describe('buildPlan', () => {
  it('构建处理计划', () => {
    fs.mkdirSync(join('input', 'novel1'), { recursive: true });
    createFile('input/novel1/第001章.txt', 'x'.repeat(100));
    createFile('input/novel1/第002章.txt', 'x'.repeat(100));

    const novels = listNovels(join('input'));
    const result = buildPlan(novels, join('input'), join('output'), '.txt');

    expect(result.totalNovels).toBe(1);
    expect(result.totalOutlines).toBe(2);
    expect(result.pendingOutlines).toBe(2); // output 目录无文件，全部 pending
    expect(result.plan).toHaveLength(1);
    expect(result.plan[0].outlines).toHaveLength(2);
    expect(result.plan[0].pending).toHaveLength(2);
  });

  it('已完成的文件不计入 pending', () => {
    fs.mkdirSync(join('input', 'novel1'), { recursive: true });
    createFile('input/novel1/第001章.txt', 'x'.repeat(100));
    createFile('input/novel1/第002章.txt', 'x'.repeat(100));
    // 创建已完成的输出
    createFile('output/novel1/第001章.txt', 'x'.repeat(MIN_DONE_BYTES));

    const novels = listNovels(join('input'));
    const result = buildPlan(novels, join('input'), join('output'), '.txt');

    expect(result.totalOutlines).toBe(2);
    expect(result.pendingOutlines).toBe(1); // 第001章已完成
  });

  it('空小说目录不计入 plan', () => {
    fs.mkdirSync(join('input', 'empty'), { recursive: true });
    fs.mkdirSync(join('input', 'hasfiles'), { recursive: true });
    createFile('input/hasfiles/a.txt', 'content');

    const novels = listNovels(join('input'));
    const result = buildPlan(novels, join('input'), join('output'), '.txt');

    expect(result.totalNovels).toBe(2);
    expect(result.plan).toHaveLength(1); // 只有 hasfiles
  });

  it('更新 novel 的计数', () => {
    fs.mkdirSync(join('input', 'novel1'), { recursive: true });
    createFile('input/novel1/a.txt', 'content');
    createFile('input/novel1/b.txt', 'content');

    const novels = listNovels(join('input'));
    const result = buildPlan(novels, join('input'), join('output'), '.txt');

    expect(result.plan[0].novel.totalChapters).toBe(2);
    expect(result.plan[0].novel.pendingChapters).toBe(2);
    expect(result.plan[0].novel.doneChapters).toBe(0);
  });
});

// ============================================================
// 对话 URL 持久化
// ============================================================
describe('conversationUrl 持久化', () => {
  describe('conversationUrlPath', () => {
    it('返回正确的路径', () => {
      const p = conversationUrlPath('/output', 'novel1');
      expect(p).toBe(path.join('/output', 'novel1', '.conversation_url'));
    });
  });

  describe('readConversationUrl', () => {
    it('读取有效 URL', () => {
      const outputRoot = join('output');
      fs.mkdirSync(join('output', 'novel1'), { recursive: true });
      fs.writeFileSync(join('output', 'novel1', '.conversation_url'), 'https://chatgpt.com/c/123');
      expect(readConversationUrl(outputRoot, 'novel1')).toBe('https://chatgpt.com/c/123');
    });

    it('文件不存在返回 null', () => {
      expect(readConversationUrl(join('output'), 'nonexistent')).toBeNull();
    });

    it('空内容返回 null', () => {
      fs.mkdirSync(join('output', 'novel1'), { recursive: true });
      fs.writeFileSync(join('output', 'novel1', '.conversation_url'), '');
      expect(readConversationUrl(join('output'), 'novel1')).toBeNull();
    });

    it('非 HTTP URL 返回 null', () => {
      fs.mkdirSync(join('output', 'novel1'), { recursive: true });
      fs.writeFileSync(join('output', 'novel1', '.conversation_url'), 'not-a-url');
      expect(readConversationUrl(join('output'), 'novel1')).toBeNull();
    });

    it('trim 空白后验证', () => {
      fs.mkdirSync(join('output', 'novel1'), { recursive: true });
      fs.writeFileSync(join('output', 'novel1', '.conversation_url'), '  https://chatgpt.com/c/456  ');
      expect(readConversationUrl(join('output'), 'novel1')).toBe('https://chatgpt.com/c/456');
    });
  });

  describe('saveConversationUrl', () => {
    it('保存 URL 并可读回', () => {
      const outputRoot = join('output');
      saveConversationUrl(outputRoot, 'novel1', 'https://chatgpt.com/c/789');
      expect(readConversationUrl(outputRoot, 'novel1')).toBe('https://chatgpt.com/c/789');
    });

    it('自动创建目录', () => {
      saveConversationUrl(join('output'), 'newnovel', 'https://chatgpt.com/c/000');
      expect(fs.existsSync(join('output', 'newnovel', '.conversation_url'))).toBe(true);
    });
  });

  describe('deleteConversationUrl', () => {
    it('删除存在的文件', () => {
      const outputRoot = join('output');
      saveConversationUrl(outputRoot, 'novel1', 'https://chatgpt.com/c/123');
      deleteConversationUrl(outputRoot, 'novel1');
      expect(fs.existsSync(join('output', 'novel1', '.conversation_url'))).toBe(false);
    });

    it('文件不存在时不抛异常', () => {
      expect(() => deleteConversationUrl(join('output'), 'nonexistent')).not.toThrow();
    });
  });
});
