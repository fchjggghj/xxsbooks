import fs from 'node:fs';
import path from 'node:path';
import type { OutlinePoolItem } from './types.js';

const POOL_DIR = 'data/02_5_pool';
const POOL_INDEX_FILE = 'pool.json';

function getPoolRoot(pipelineRoot: string): string {
  return path.join(pipelineRoot, POOL_DIR);
}

function getPoolIndexPath(pipelineRoot: string): string {
  return path.join(getPoolRoot(pipelineRoot), POOL_INDEX_FILE);
}

export function loadPoolItems(pipelineRoot: string, genre?: string): OutlinePoolItem[] {
  const indexPath = getPoolIndexPath(pipelineRoot);
  if (!fs.existsSync(indexPath)) return [];

  try {
    const content = fs.readFileSync(indexPath, 'utf8');
    const allItems: OutlinePoolItem[] = JSON.parse(content);
    if (genre) {
      return allItems.filter((item) => item.genre === genre);
    }
    return allItems;
  } catch {
    return [];
  }
}

export function getPoolItemById(pipelineRoot: string, itemId: string): OutlinePoolItem | undefined {
  const items = loadPoolItems(pipelineRoot);
  return items.find((item) => item.id === itemId);
}

export function addPoolItem(pipelineRoot: string, item: Omit<OutlinePoolItem, 'id' | 'addedAt'>): OutlinePoolItem {
  const items = loadPoolItems(pipelineRoot);
  const newItem: OutlinePoolItem = {
    ...item,
    id: `${item.sourceBookId}-pool-${Date.now()}`,
    addedAt: new Date().toISOString(),
  };

  items.push(newItem);
  savePoolIndex(pipelineRoot, items);

  const genreDir = path.join(getPoolRoot(pipelineRoot), item.genre);
  fs.mkdirSync(genreDir, { recursive: true });
  const outputPath = path.join(genreDir, `${newItem.id}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(newItem, null, 2), 'utf8');

  return newItem;
}

export function updatePoolItem(pipelineRoot: string, itemId: string, updates: Partial<OutlinePoolItem>): OutlinePoolItem | undefined {
  const items = loadPoolItems(pipelineRoot);
  const index = items.findIndex((item) => item.id === itemId);
  if (index === -1) return undefined;

  const oldItem = items[index];
  items[index] = { ...items[index], ...updates };
  savePoolIndex(pipelineRoot, items);

  if (oldItem.genre !== items[index].genre) {
    const oldPath = path.join(getPoolRoot(pipelineRoot), oldItem.genre, `${itemId}.json`);
    if (fs.existsSync(oldPath)) {
      fs.unlinkSync(oldPath);
    }
  }

  const genreDir = path.join(getPoolRoot(pipelineRoot), items[index].genre);
  fs.mkdirSync(genreDir, { recursive: true });
  const outputPath = path.join(genreDir, `${itemId}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(items[index], null, 2), 'utf8');

  return items[index];
}

export function deletePoolItem(pipelineRoot: string, itemId: string): boolean {
  const items = loadPoolItems(pipelineRoot);
  const index = items.findIndex((item) => item.id === itemId);
  if (index === -1) return false;

  const item = items[index];
  items.splice(index, 1);
  savePoolIndex(pipelineRoot, items);

  const outputPath = path.join(getPoolRoot(pipelineRoot), item.genre, `${itemId}.json`);
  if (fs.existsSync(outputPath)) {
    fs.unlinkSync(outputPath);
  }

  return true;
}

export function getPoolByGenre(pipelineRoot: string): Map<string, OutlinePoolItem[]> {
  const items = loadPoolItems(pipelineRoot);
  const map = new Map<string, OutlinePoolItem[]>();

  for (const item of items) {
    const list = map.get(item.genre) || [];
    list.push(item);
    map.set(item.genre, list);
  }

  return map;
}

export function getAvailableGenres(pipelineRoot: string): string[] {
  const map = getPoolByGenre(pipelineRoot);
  return Array.from(map.keys()).sort();
}

export function batchSyncPool(pipelineRoot: string): number {
  const root = getPoolRoot(pipelineRoot);
  if (!fs.existsSync(root)) return 0;

  const items: OutlinePoolItem[] = [];
  const genreDirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());

  for (const genreDir of genreDirs) {
    const genrePath = path.join(root, genreDir.name);
    const files = fs.readdirSync(genrePath).filter((f) => f.endsWith('.json'));

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(genrePath, file), 'utf8');
        const item = JSON.parse(content) as OutlinePoolItem;
        if (!items.find((i) => i.id === item.id)) {
          items.push(item);
        }
      } catch {
        continue;
      }
    }
  }

  savePoolIndex(pipelineRoot, items);
  return items.length;
}

function savePoolIndex(pipelineRoot: string, items: OutlinePoolItem[]): void {
  const indexPath = getPoolIndexPath(pipelineRoot);
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify(items, null, 2), 'utf8');
}