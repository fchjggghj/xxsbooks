import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatNum(n: number): string {
  return n.toLocaleString('zh-CN');
}

export function formatPercent(done: number, total: number): string {
  if (!total) return '0%';
  return `${((done / total) * 100).toFixed(1)}%`;
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${sec}s`;
  return `${sec}s`;
}

export function timestamp(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

export function readersTxt(r: number | null | undefined): string {
  if (r == null) return '—';
  return r >= 10000 ? `${(r / 10000).toFixed(r % 10000 ? 1 : 0)}万` : `${r}人`;
}

export function secsHuman(s: number | null | undefined): string {
  if (s == null || !isFinite(s)) return '—';
  s = Math.round(s);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  return `${m} 分`;
}
