/**
 * web/src/lib/utils.ts 单元测试
 *
 * 覆盖前端工具函数：cn, formatNum, formatPercent, formatDuration, timestamp, readersTxt, secsHuman
 */
import { describe, it, expect } from 'vitest';
import {
  cn,
  formatNum,
  formatPercent,
  formatDuration,
  timestamp,
  readersTxt,
  secsHuman,
} from './utils.js';

// ============================================================
// cn（className 合并）
// ============================================================
describe('cn', () => {
  it('合并多个类名', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  it('过滤 falsy 值', () => {
    expect(cn('foo', '', null, undefined, false, 'bar')).toBe('foo bar');
  });

  it('条件类名（对象语法）', () => {
    expect(cn('base', { active: true, disabled: false })).toBe('base active');
  });

  it('合并冲突的 Tailwind 类（后者胜出）', () => {
    // twMerge 会去掉冲突的前一个
    expect(cn('px-2', 'px-4')).toBe('px-4');
  });

  it('无参数返回空字符串', () => {
    expect(cn()).toBe('');
  });
});

// ============================================================
// formatNum
// ============================================================
describe('formatNum', () => {
  it('千分位格式化', () => {
    expect(formatNum(1234567)).toBe('1,234,567');
  });

  it('0', () => {
    expect(formatNum(0)).toBe('0');
  });

  it('负数', () => {
    expect(formatNum(-9999)).toBe('-9,999');
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
  it('秒级', () => {
    expect(formatDuration(45_000)).toBe('45s');
  });

  it('分钟级', () => {
    expect(formatDuration(125_000)).toBe('2m5s');
  });

  it('小时级', () => {
    expect(formatDuration(3_725_000)).toBe('1h2m');
  });

  it('0ms', () => {
    expect(formatDuration(0)).toBe('0s');
  });
});

// ============================================================
// timestamp
// ============================================================
describe('timestamp', () => {
  it('返回非空字符串', () => {
    const ts = timestamp();
    expect(ts).toBeTruthy();
    expect(typeof ts).toBe('string');
  });

  it('格式为 HH:MM:SS', () => {
    const ts = timestamp();
    expect(ts).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});

// ============================================================
// readersTxt（读者数格式化）
// ============================================================
describe('readersTxt', () => {
  it('null 返回 "—"（em dash）', () => {
    expect(readersTxt(null)).toBe('—');
  });

  it('undefined 返回 "—"（em dash）', () => {
    expect(readersTxt(undefined)).toBe('—');
  });

  it('< 10000 显示原数 + "人"', () => {
    expect(readersTxt(9999)).toBe('9999人');
  });

  it('10000 显示 "1万"', () => {
    expect(readersTxt(10000)).toBe('1万');
  });

  it('15000 显示 "1.5万"', () => {
    expect(readersTxt(15000)).toBe('1.5万');
  });

  it('10000 的整数倍不显示小数', () => {
    expect(readersTxt(20000)).toBe('2万');
    expect(readersTxt(50000)).toBe('5万');
  });

  it('非整数万显示一位小数', () => {
    expect(readersTxt(12300)).toBe('1.2万');
  });

  it('0 显示 "0人"', () => {
    expect(readersTxt(0)).toBe('0人');
  });
});

// ============================================================
// secsHuman（秒数人性化）
// ============================================================
describe('secsHuman', () => {
  it('null 返回 "—"（em dash）', () => {
    expect(secsHuman(null)).toBe('—');
  });

  it('NaN 返回 "—"（em dash）', () => {
    expect(secsHuman(NaN)).toBe('—');
  });

  it('Infinity 返回 "—"（em dash）', () => {
    expect(secsHuman(Infinity)).toBe('—');
  });

  it('分钟级（< 1小时）', () => {
    expect(secsHuman(300)).toBe('5 分');
  });

  it('小时级（< 1天）', () => {
    expect(secsHuman(3600)).toBe('1 小时 0 分');
    expect(secsHuman(3660)).toBe('1 小时 1 分');
  });

  it('天级（>= 1天）', () => {
    expect(secsHuman(86400)).toBe('1 天 0 小时');
    expect(secsHuman(90000)).toBe('1 天 1 小时');
  });

  it('0 秒', () => {
    expect(secsHuman(0)).toBe('0 分');
  });

  it('小数被四舍五入', () => {
    expect(secsHuman(59.7)).toBe('1 分');
  });
});
