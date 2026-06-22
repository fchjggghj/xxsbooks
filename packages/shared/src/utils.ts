/**
 * 通用工具函数
 */

/** 带颜色的日志（终端 ANSI 色） */
const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
} as const;

/** 时间戳格式化 */
export function timestamp(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

/** 带时间戳和颜色的日志 */
export function log(msg: string, color?: keyof typeof COLORS): void {
  const c = color ? COLORS[color] : '';
  const r = color ? COLORS.reset : '';
  console.log(`${COLORS.gray}[${timestamp()}]${r} ${c}${msg}${r}`);
}

export function logInfo(msg: string): void {
  log(msg, 'cyan');
}
export function logOk(msg: string): void {
  log(`✓ ${msg}`, 'green');
}
export function logWarn(msg: string): void {
  log(`⚠ ${msg}`, 'yellow');
}
export function logError(msg: string): void {
  log(`✗ ${msg}`, 'red');
}
export function logDebug(msg: string): void {
  if (process.env.DEBUG) log(msg, 'gray');
}

/** 错误消息提取 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err ?? '');
}

/** 判断是否浏览器关闭错误 */
export function isBrowserClosedError(err: unknown): boolean {
  const msg = errorMessage(err);
  return /target page, context or browser has been closed|browser has been closed|browser closed|target closed|connection closed|websocket.*closed|econnrefused/i.test(
    msg,
  );
}

/** 判断是否瞬时页面错误 */
export function isTransientPageError(err: unknown): boolean {
  const msg = errorMessage(err);
  return /timeout|navigation|load failed|net::ERR|session.*expired/i.test(msg);
}

/** 限制 ms 范围 */
export function boundedMs(
  value: unknown,
  fallback: number,
  maxValue = 24 * 60 * 60 * 1000,
): number {
  const n = Number(value);
  const ms = Number.isFinite(n) && n > 0 ? n : fallback;
  return Math.max(1000, Math.min(ms, maxValue));
}

/** 睡眠 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 自然排序比较（第2章 < 第10章） */
export function naturalCompare(a: string, b: string): number {
  const ax: (string | number)[] = [];
  const bx: (string | number)[] = [];
  a.replace(/(\d+)|(\D+)/g, (_, $1, $2) => {
    ax.push($1 ? +$1 : $2);
    return '';
  });
  b.replace(/(\d+)|(\D+)/g, (_, $1, $2) => {
    bx.push($1 ? +$1 : $2);
    return '';
  });
  while (ax.length && bx.length) {
    const an = ax.shift()!;
    const bn = bx.shift()!;
    const nn =
      Number(typeof an === 'number') - Number(typeof bn === 'number') ||
      (an as number) - (bn as number) ||
      String(an).localeCompare(String(bn));
    if (nn) return nn;
  }
  return ax.length - bx.length;
}

/** 回复是否是政策拒绝 */
export function isRefusal(text: string): boolean {
  const x = (text || '').trim();
  return x.length < 600 && /违反了我们的使用政策|可能违反|使用政策/.test(x);
}

/** 回复是否可用 */
export function isUsable(text: string, minChars: number): boolean {
  const x = (text || '').trim();
  return x.length >= minChars && !isRefusal(x);
}

/** 格式化数字（加千分位） */
export function formatNum(n: number): string {
  return n.toLocaleString('zh-CN');
}

/** 格式化百分比 */
export function formatPercent(done: number, total: number): string {
  if (!total) return '0%';
  return `${((done / total) * 100).toFixed(1)}%`;
}

/** 格式化时长 */
export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${sec}s`;
  return `${sec}s`;
}

/** 深度合并对象 */
export function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key in source) {
    if (source[key] instanceof Object && !Array.isArray(source[key])) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>,
      ) as T[Extract<keyof T, string>];
    } else if (source[key] !== undefined) {
      result[key] = source[key] as T[Extract<keyof T, string>];
    }
  }
  return result;
}

export { COLORS };
