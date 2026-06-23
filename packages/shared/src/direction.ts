import fs from 'node:fs';
import path from 'node:path';
import type { AdaptDirection } from './types.js';

const DIRECTIONS_DIR = 'data/01_5_directions';
const DIRECTIONS_INDEX_FILE = 'directions_index.json';

function getDirectionsRoot(pipelineRoot: string): string {
  return path.join(pipelineRoot, DIRECTIONS_DIR);
}

function getDirectionsIndexPath(pipelineRoot: string): string {
  return path.join(getDirectionsRoot(pipelineRoot), DIRECTIONS_INDEX_FILE);
}

export function loadDirections(pipelineRoot: string, bookId?: string): AdaptDirection[] {
  const indexPath = getDirectionsIndexPath(pipelineRoot);
  if (!fs.existsSync(indexPath)) return [];

  try {
    const content = fs.readFileSync(indexPath, 'utf8');
    const allDirections: AdaptDirection[] = JSON.parse(content);
    if (bookId) {
      return allDirections.filter((d) => d.bookId === bookId);
    }
    return allDirections;
  } catch {
    return [];
  }
}

export function getDirectionById(pipelineRoot: string, directionId: string): AdaptDirection | undefined {
  const directions = loadDirections(pipelineRoot);
  return directions.find((d) => d.id === directionId);
}

export function addDirection(pipelineRoot: string, direction: Omit<AdaptDirection, 'id' | 'createdAt'>): AdaptDirection {
  const directions = loadDirections(pipelineRoot);
  const newDirection: AdaptDirection = {
    ...direction,
    id: `${direction.bookId}-dir-${Date.now()}`,
    createdAt: new Date().toISOString(),
  };

  directions.push(newDirection);
  saveDirectionsIndex(pipelineRoot, directions);

  const outputDir = path.join(getDirectionsRoot(pipelineRoot), direction.bookId);
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${newDirection.worldIndex}_${newDirection.worldName}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(newDirection, null, 2), 'utf8');

  return newDirection;
}

export function updateDirection(pipelineRoot: string, directionId: string, updates: Partial<AdaptDirection>): AdaptDirection | undefined {
  const directions = loadDirections(pipelineRoot);
  const index = directions.findIndex((d) => d.id === directionId);
  if (index === -1) return undefined;

  directions[index] = { ...directions[index], ...updates };
  saveDirectionsIndex(pipelineRoot, directions);

  const outputDir = path.join(getDirectionsRoot(pipelineRoot), directions[index].bookId);
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${directions[index].worldIndex}_${directions[index].worldName}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(directions[index], null, 2), 'utf8');

  return directions[index];
}

export function deleteDirection(pipelineRoot: string, directionId: string): boolean {
  const directions = loadDirections(pipelineRoot);
  const index = directions.findIndex((d) => d.id === directionId);
  if (index === -1) return false;

  const direction = directions[index];
  directions.splice(index, 1);
  saveDirectionsIndex(pipelineRoot, directions);

  const outputPath = path.join(getDirectionsRoot(pipelineRoot), direction.bookId, `${direction.worldIndex}_${direction.worldName}.json`);
  if (fs.existsSync(outputPath)) {
    fs.unlinkSync(outputPath);
  }

  return true;
}

function saveDirectionsIndex(pipelineRoot: string, directions: AdaptDirection[]): void {
  const indexPath = getDirectionsIndexPath(pipelineRoot);
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify(directions, null, 2), 'utf8');
}

export function batchSyncDirections(pipelineRoot: string): number {
  const root = getDirectionsRoot(pipelineRoot);
  if (!fs.existsSync(root)) return 0;

  const directions: AdaptDirection[] = [];
  const bookDirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());

  for (const bookDir of bookDirs) {
    const bookPath = path.join(root, bookDir.name);
    const files = fs.readdirSync(bookPath).filter((f) => f.endsWith('.json'));

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(bookPath, file), 'utf8');
        const direction = JSON.parse(content) as AdaptDirection;
        if (!directions.find((d) => d.id === direction.id)) {
          directions.push(direction);
        }
      } catch {
        continue;
      }
    }
  }

  saveDirectionsIndex(pipelineRoot, directions);
  return directions.length;
}