/**
 * server 单元测试 — 可独立测试的纯函数
 *
 * 覆盖：
 * - config.ts: validateConfig
 * - logs.ts: speedFromEvents
 * - router.ts: sendJson, readBody
 *
 * 注意：server 模块在 import 时会读取真实 config.json，
 * 但测试的函数本身是纯函数，不依赖外部状态。
 */
import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { validateConfig } from './config.js';
import { speedFromEvents } from './logs.js';
import { sendJson, readBody } from './router.js';
import type { LogEvent } from './types.js';

// ============================================================
// validateConfig
// ============================================================
describe('validateConfig', () => {
  it('有效配置返回 null', () => {
    const cfg = {
      libraryRoot: '/data/raw',
      gptUrl: 'https://chatgpt.com',
      novels: [],
    };
    expect(validateConfig(cfg)).toBeNull();
  });

  it('null 返回 "不是对象"', () => {
    expect(validateConfig(null)).toBe('不是对象');
  });

  it('undefined 返回 "不是对象"', () => {
    expect(validateConfig(undefined)).toBe('不是对象');
  });

  it('数字返回 "不是对象"', () => {
    expect(validateConfig(42)).toBe('不是对象');
  });

  it('字符串返回 "不是对象"', () => {
    expect(validateConfig('config')).toBe('不是对象');
  });

  it('libraryRoot 为空字符串报错', () => {
    expect(validateConfig({ libraryRoot: '', gptUrl: 'https://x.com', novels: [] })).toBe(
      'libraryRoot 不能为空',
    );
  });

  it('libraryRoot 只有空白报错', () => {
    expect(validateConfig({ libraryRoot: '   ', gptUrl: 'https://x.com', novels: [] })).toBe(
      'libraryRoot 不能为空',
    );
  });

  it('libraryRoot 不是字符串报错', () => {
    expect(validateConfig({ libraryRoot: 123, gptUrl: 'https://x.com', novels: [] })).toBe(
      'libraryRoot 不能为空',
    );
  });

  it('gptUrl 不是字符串报错', () => {
    expect(validateConfig({ libraryRoot: '/data', gptUrl: 123, novels: [] })).toBe(
      'gptUrl 必须是字符串',
    );
  });

  it('novels 不是数组报错', () => {
    expect(validateConfig({ libraryRoot: '/data', gptUrl: 'https://x.com', novels: 'all' })).toBe(
      'novels 必须是数组',
    );
  });
});

// ============================================================
// speedFromEvents
// ============================================================
describe('speedFromEvents', () => {
  it('空数组返回 null + 0 samples', () => {
    const result = speedFromEvents([]);
    expect(result.avgSecPerChapter).toBeNull();
    expect(result.samples).toBe(0);
  });

  it('无 ok 事件返回 null', () => {
    const events: LogEvent[] = [
      { time: '10:00:00', kind: 'info', text: '开始' },
      { time: '10:00:05', kind: 'fail', text: '失败' },
    ];
    const result = speedFromEvents(events);
    expect(result.avgSecPerChapter).toBeNull();
    expect(result.samples).toBe(0);
  });

  it('单个 ok 事件无 delta 返回 null', () => {
    const events: LogEvent[] = [{ time: '10:00:00', kind: 'ok', text: '完成' }];
    const result = speedFromEvents(events);
    expect(result.avgSecPerChapter).toBeNull();
    expect(result.samples).toBe(0);
  });

  it('两个 ok 事件计算 delta', () => {
    const events: LogEvent[] = [
      { time: '10:00:00', kind: 'ok', text: '完成' },
      { time: '10:01:00', kind: 'ok', text: '完成' }, // 60s 后
    ];
    const result = speedFromEvents(events);
    expect(result.avgSecPerChapter).toBe(60);
    expect(result.samples).toBe(1);
  });

  it('多个 ok 事件取最近 30 个 delta 的平均', () => {
    const events: LogEvent[] = [];
    for (let i = 0; i < 10; i++) {
      events.push({ time: `10:0${i}:00`, kind: 'ok', text: '完成' }); // 每 60s
    }
    const result = speedFromEvents(events);
    expect(result.avgSecPerChapter).toBe(60);
    expect(result.samples).toBe(9); // 10 个事件 → 9 个 delta
  });

  it('delta > 300s 被过滤', () => {
    const events: LogEvent[] = [
      { time: '10:00:00', kind: 'ok', text: '完成' },
      { time: '10:10:00', kind: 'ok', text: '完成' }, // 600s 后，超过 300s 上限
    ];
    const result = speedFromEvents(events);
    expect(result.avgSecPerChapter).toBeNull();
    expect(result.samples).toBe(0);
  });

  it('跨午夜（时间回绕）自动 +86400', () => {
    const events: LogEvent[] = [
      { time: '23:59:30', kind: 'ok', text: '完成' },
      { time: '00:00:30', kind: 'ok', text: '完成' }, // 次日，60s 后
    ];
    const result = speedFromEvents(events);
    expect(result.avgSecPerChapter).toBe(60);
    expect(result.samples).toBe(1);
  });

  it('只取最近 30 个 delta', () => {
    const events: LogEvent[] = [];
    // 生成 40 个 ok 事件，每个间隔 10s
    for (let i = 0; i < 40; i++) {
      const totalSec = i * 10;
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      events.push({
        time: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`,
        kind: 'ok',
        text: '完成',
      });
    }
    const result = speedFromEvents(events);
    expect(result.samples).toBe(30); // 最多 30 个
    expect(result.avgSecPerChapter).toBe(10);
  });
});

// ============================================================
// sendJson
// ============================================================
describe('sendJson', () => {
  function mockResponse(): {
    res: http.ServerResponse;
    state: {
      headers: Record<string, string | number>;
      body: string;
      statusCode: number;
    };
  } {
    const state = {
      headers: {} as Record<string, string | number>,
      body: '',
      statusCode: 0,
    };
    const res = {
      writeHead(code: number, headers?: Record<string, string | number>) {
        state.statusCode = code;
        if (headers) Object.assign(state.headers, headers);
      },
      end(data?: string) {
        if (data) state.body = data;
      },
    } as unknown as http.ServerResponse;
    return { res, state };
  }

  it('发送 200 + JSON 数据', () => {
    const { res, state } = mockResponse();
    sendJson(res, 200, { ok: true, msg: '成功' });
    expect(state.statusCode).toBe(200);
    expect(state.headers['Content-Type']).toBe('application/json; charset=utf-8');
    expect(state.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(state.body)).toEqual({ ok: true, msg: '成功' });
  });

  it('发送 404 错误', () => {
    const { res, state } = mockResponse();
    sendJson(res, 404, { error: '未找到' });
    expect(state.statusCode).toBe(404);
    expect(JSON.parse(state.body)).toEqual({ error: '未找到' });
  });

  it('发送 500 错误', () => {
    const { res, state } = mockResponse();
    sendJson(res, 500, { error: '服务器内部错误' });
    expect(state.statusCode).toBe(500);
    expect(JSON.parse(state.body).error).toBe('服务器内部错误');
  });

  it('发送 null 数据', () => {
    const { res, state } = mockResponse();
    sendJson(res, 200, null);
    expect(JSON.parse(state.body)).toBeNull();
  });

  it('发送数组数据', () => {
    const { res, state } = mockResponse();
    sendJson(res, 200, [1, 2, 3]);
    expect(JSON.parse(state.body)).toEqual([1, 2, 3]);
  });
});

// ============================================================
// readBody
// ============================================================
describe('readBody', () => {
  function mockRequest(data: string): http.IncomingMessage {
    const ee = new EventEmitter();
    (ee as any).setEncoding = (_enc: string) => {};
    // 异步触发 data 和 end 事件
    setImmediate(() => {
      if (data) (ee as any).emit('data', data);
      (ee as any).emit('end');
    });
    return ee as unknown as http.IncomingMessage;
  }

  it('解析 JSON 请求体', async () => {
    const req = mockRequest(JSON.stringify({ action: 'start', count: 5 }));
    const body = await readBody(req);
    expect(body.action).toBe('start');
    expect(body.count).toBe(5);
  });

  it('空请求体返回空对象', async () => {
    const req = mockRequest('');
    const body = await readBody(req);
    expect(body).toEqual({});
  });

  it('无效 JSON 返回空对象', async () => {
    const req = mockRequest('not json at all');
    const body = await readBody(req);
    expect(body).toEqual({});
  });

  it('请求体过大被拒绝', async () => {
    const ee = new EventEmitter();
    (ee as any).setEncoding = () => {};
    (ee as any).destroy = () => {
      // 模拟 socket 销毁后不再触发事件
      ee.removeAllListeners();
    };
    const req = ee as unknown as http.IncomingMessage;
    setImmediate(() => {
      // 发送超过 4MB 的数据
      (ee as any).emit('data', 'x'.repeat(5 * 1024 * 1024));
    });
    await expect(readBody(req)).rejects.toThrow('请求体过大');
  });
});
