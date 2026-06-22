/**
 * shared/src/utils.ts 单元测试
 *
 * 覆盖所有工具函数的边界场景：
 * - errorMessage / isBrowserClosedError / isTransientPageError
 * - boundedMs / sleep
 * - naturalCompare
 * - isRefusal / isUsable
 * - formatNum / formatPercent / formatDuration
 * - deepMerge
 */
import { describe, it, expect } from 'vitest';
import {
  errorMessage,
  isBrowserClosedError,
  isTransientPageError,
  boundedMs,
  sleep,
  naturalCompare,
  isRefusal,
  isUsable,
  formatNum,
  formatPercent,
  formatDuration,
  deepMerge,
  log,
  logInfo,
  logOk,
  logWarn,
  logError,
  logDebug,
  timestamp,
} from './utils.js';

// ============================================================
// errorMessage
// ============================================================
describe('errorMessage', () => {
  it('Error 实例提取 message', () => {
    expect(errorMessage(new Error('测试错误'))).toBe('测试错误');
  });

  it('字符串直接返回', () => {
    expect(errorMessage('字符串错误')).toBe('字符串错误');
  });

  it('数字转字符串', () => {
    expect(errorMessage(42)).toBe('42');
  });

  it('null 返回空字符串', () => {
    expect(errorMessage(null)).toBe('');
  });

  it('undefined 返回空字符串', () => {
    expect(errorMessage(undefined)).toBe('');
  });

  it('对象转字符串', () => {
    expect(errorMessage({ code: 500 })).toBe('[object Object]');
  });
});

// ============================================================
// isBrowserClosedError
// ============================================================
describe('isBrowserClosedError', () => {
  it('识别 "browser has been closed"', () => {
    expect(isBrowserClosedError(new Error('browser has been closed'))).toBe(true);
  });

  it('识别 "target page, context or browser has been closed"', () => {
    expect(isBrowserClosedError('target page, context or browser has been closed')).toBe(true);
  });

  it('识别 "target closed"', () => {
    expect(isBrowserClosedError('target closed')).toBe(true);
  });

  it('识别 "ECONNREFUSED"', () => {
    expect(isBrowserClosedError('connect ECONNREFUSED 127.0.0.1:9222')).toBe(true);
  });

  it('识别 "websocket.*closed"（大小写不敏感）', () => {
    expect(isBrowserClosedError('WebSocket was closed')).toBe(true);
  });

  it('普通错误返回 false', () => {
    expect(isBrowserClosedError(new Error('网络超时'))).toBe(false);
  });

  it('非错误类型返回 false', () => {
    expect(isBrowserClosedError(null)).toBe(false);
  });
});

// ============================================================
// isTransientPageError
// ============================================================
describe('isTransientPageError', () => {
  it('识别 "timeout"', () => {
    expect(isTransientPageError('page.goto timeout')).toBe(true);
  });

  it('识别 "navigation"', () => {
    expect(isTransientPageError('navigation failed')).toBe(true);
  });

  it('识别 "net::ERR"', () => {
    expect(isTransientPageError('net::ERR_CONNECTION_RESET')).toBe(true);
  });

  it('识别 "session expired"', () => {
    expect(isTransientPageError('session has expired')).toBe(true);
  });

  it('识别 "load failed"', () => {
    expect(isTransientPageError('load failed')).toBe(true);
  });

  it('非瞬时错误返回 false', () => {
    expect(isTransientPageError('browser has been closed')).toBe(false);
  });

  it('null 返回 false', () => {
    expect(isTransientPageError(null)).toBe(false);
  });
});

// ============================================================
// boundedMs
// ============================================================
describe('boundedMs', () => {
  it('正常值直接返回', () => {
    expect(boundedMs(5000, 1000)).toBe(5000);
  });

  it('无效值用 fallback', () => {
    expect(boundedMs(NaN, 3000)).toBe(3000);
    expect(boundedMs(-1, 3000)).toBe(3000);
    expect(boundedMs(0, 3000)).toBe(3000);
    expect(boundedMs('abc', 3000)).toBe(3000);
    expect(boundedMs(undefined, 3000)).toBe(3000);
  });

  it('小于 1000ms 被提升到 1000ms', () => {
    expect(boundedMs(500, 1000)).toBe(1000);
    expect(boundedMs(1, 1000)).toBe(1000);
  });

  it('超过 maxValue 被截断', () => {
    expect(boundedMs(999_999_999, 1000)).toBe(86_400_000); // 24h
  });

  it('自定义 maxValue', () => {
    expect(boundedMs(60_000, 1000, 30_000)).toBe(30_000);
  });

  it('字符串数字被解析', () => {
    expect(boundedMs('5000', 1000)).toBe(5000);
  });

  it('Infinity 用 fallback', () => {
    expect(boundedMs(Infinity, 2000)).toBe(2000);
  });
});

// ============================================================
// sleep
// ============================================================
describe('sleep', () => {
  it('等待指定毫秒后 resolve', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(200);
  });

  it('返回 Promise', () => {
    expect(sleep(1)).toBeInstanceOf(Promise);
  });
});

// ============================================================
// naturalCompare
// ============================================================
describe('naturalCompare', () => {
  it('数字排序：第2章 < 第10章', () => {
    expect(naturalCompare('第2章', '第10章')).toBeLessThan(0);
  });

  it('数字排序：第10章 > 第2章', () => {
    expect(naturalCompare('第10章', '第2章')).toBeGreaterThan(0);
  });

  it('相同字符串返回 0', () => {
    expect(naturalCompare('第5章', '第5章')).toBe(0);
  });

  it('纯数字排序', () => {
    expect(naturalCompare('1', '2')).toBeLessThan(0);
    expect(naturalCompare('10', '2')).toBeGreaterThan(0);
  });

  it('字母排序', () => {
    expect(naturalCompare('abc', 'abd')).toBeLessThan(0);
  });

  it('混合数字和字母', () => {
    expect(naturalCompare('chapter2b', 'chapter2a')).toBeGreaterThan(0);
  });

  it('前缀相同数字不同', () => {
    expect(naturalCompare('第001章_test', '第002章_test')).toBeLessThan(0);
    expect(naturalCompare('第100章_test', '第099章_test')).toBeGreaterThan(0);
  });

  it('长度不同时短的排前面', () => {
    expect(naturalCompare('ab', 'abc')).toBeLessThan(0);
  });
});

// ============================================================
// isRefusal
// ============================================================
describe('isRefusal', () => {
  it('识别 "违反了我们的使用政策"', () => {
    expect(isRefusal('此内容违反了我们的使用政策')).toBe(true);
  });

  it('识别 "可能违反"', () => {
    expect(isRefusal('这可能违反使用政策')).toBe(true);
  });

  it('长文本不被判定为拒绝（即使含关键词）', () => {
    const long = '违反了我们的使用政策' + 'x'.repeat(700);
    expect(isRefusal(long)).toBe(false);
  });

  it('正常长文本返回 false', () => {
    expect(isRefusal('这是一段正常的大纲内容，包含很多文字' + 'x'.repeat(100))).toBe(false);
  });

  it('空字符串返回 false', () => {
    expect(isRefusal('')).toBe(false);
  });

  it('null 安全处理', () => {
    expect(isRefusal(null as unknown as string)).toBe(false);
  });
});

// ============================================================
// isUsable
// ============================================================
describe('isUsable', () => {
  it('长度达标且非拒绝 → true', () => {
    expect(isUsable('这是一段足够长的可用回复内容', 10)).toBe(true);
  });

  it('长度不足 → false', () => {
    expect(isUsable('短', 100)).toBe(false);
  });

  it('是拒绝内容 → false', () => {
    expect(isUsable('违反了我们的使用政策', 1)).toBe(false);
  });

  it('空字符串 → false', () => {
    expect(isUsable('', 1)).toBe(false);
  });

  it('null 安全处理', () => {
    expect(isUsable(null as unknown as string, 1)).toBe(false);
  });

  it('minChars=0 时非拒绝文本可用', () => {
    expect(isUsable('任意内容', 0)).toBe(true);
  });
});

// ============================================================
// formatNum
// ============================================================
describe('formatNum', () => {
  it('千分位格式化', () => {
    expect(formatNum(1234567)).toBe('1,234,567');
  });

  it('0 返回 "0"', () => {
    expect(formatNum(0)).toBe('0');
  });

  it('负数', () => {
    expect(formatNum(-1234)).toBe('-1,234');
  });
});

// ============================================================
// formatPercent
// ============================================================
describe('formatPercent', () => {
  it('正常百分比', () => {
    expect(formatPercent(50, 100)).toBe('50.0%');
  });

  it('total=0 返回 "0%"', () => {
    expect(formatPercent(0, 0)).toBe('0%');
  });

  it('100%', () => {
    expect(formatPercent(100, 100)).toBe('100.0%');
  });

  it('小数百分比', () => {
    expect(formatPercent(1, 3)).toBe('33.3%');
  });
});

// ============================================================
// formatDuration
// ============================================================
describe('formatDuration', () => {
  it('秒级（< 60s）', () => {
    expect(formatDuration(45_000)).toBe('45s');
  });

  it('分钟级', () => {
    expect(formatDuration(125_000)).toBe('2m5s'); // 2分5秒
  });

  it('小时级', () => {
    expect(formatDuration(3_725_000)).toBe('1h2m'); // 1小时2分
  });

  it('0ms → "0s"', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  it('正好 60s → "1m0s"', () => {
    expect(formatDuration(60_000)).toBe('1m0s');
  });

  it('正好 3600s → "1h0m"', () => {
    expect(formatDuration(3_600_000)).toBe('1h0m');
  });
});

// ============================================================
// deepMerge
// ============================================================
describe('deepMerge', () => {
  it('浅层合并', () => {
    const target = { a: 1, b: 2 };
    const source = { b: 3, c: 4 };
    expect(deepMerge(target, source)).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('深层合并（不覆盖整个对象）', () => {
    const target = { nested: { x: 1, y: 2 } };
    const source = { nested: { y: 3 } };
    expect(deepMerge(target, source)).toEqual({ nested: { x: 1, y: 3 } });
  });

  it('不修改原对象', () => {
    const target = { a: 1, nested: { x: 1 } };
    const source = { b: 2 };
    const result = deepMerge(target, source);
    expect(target).toEqual({ a: 1, nested: { x: 1 } });
    expect(result).not.toBe(target);
  });

  it('source 中 undefined 不覆盖', () => {
    const target = { a: 1, b: 2 };
    const source = { b: undefined };
    expect(deepMerge(target, source)).toEqual({ a: 1, b: 2 });
  });

  it('数组不被深度合并（直接替换）', () => {
    const target = { arr: [1, 2, 3] };
    const source = { arr: [4] };
    expect(deepMerge(target, source)).toEqual({ arr: [4] });
  });

  it('空 source 返回 target 副本', () => {
    const target = { a: 1 };
    expect(deepMerge(target, {})).toEqual({ a: 1 });
  });
});

// ============================================================
// 日志函数（仅验证不抛异常）
// ============================================================
describe('日志函数', () => {
  it('timestamp 返回非空字符串', () => {
    expect(timestamp()).toBeTruthy();
    expect(typeof timestamp()).toBe('string');
  });

  it('log 不抛异常', () => {
    expect(() => log('测试消息')).not.toThrow();
    expect(() => log('测试消息', 'red')).not.toThrow();
    expect(() => log('测试消息', 'green')).not.toThrow();
  });

  it('logInfo / logOk / logWarn / logError 不抛异常', () => {
    expect(() => logInfo('info')).not.toThrow();
    expect(() => logOk('ok')).not.toThrow();
    expect(() => logWarn('warn')).not.toThrow();
    expect(() => logError('error')).not.toThrow();
  });

  it('logDebug 在无 DEBUG 环境变量时不输出', () => {
    expect(() => logDebug('debug')).not.toThrow();
  });

  it('logDebug 在有 DEBUG 环境变量时输出', () => {
    const orig = process.env.DEBUG;
    process.env.DEBUG = '1';
    expect(() => logDebug('debug')).not.toThrow();
    if (orig === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = orig;
  });
});
