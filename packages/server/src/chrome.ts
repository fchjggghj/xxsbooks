/**
 * Chrome CDP 状态检测
 *
 * 检测 Chrome CDP 是否在线，获取标签页数。
 */
import http from 'node:http';
import type { ChromeStatus } from './types.js';
import { getConfig } from './config.js';

/** 检测 Chrome CDP 是否在线 */
export function chromeStatus(): Promise<ChromeStatus> {
  return new Promise((resolve) => {
    const cfg = getConfig();
    const url = (cfg.cdpUrl || 'http://localhost:9222').replace(/\/$/, '') + '/json/version';
    const req = http.get(url, { timeout: 2500 }, (res) => {
      let d = '';
      res.on('data', (c) => {
        d += c;
      });
      res.on('end', () => {
        try {
          const j = JSON.parse(d) as { Browser?: string };
          resolve({ up: true, browser: j.Browser || '' });
        } catch {
          resolve({ up: res.statusCode === 200 });
        }
      });
    });
    req.on('error', () => resolve({ up: false }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ up: false });
    });
  });
}

/** 获取 Chrome 标签页数 */
export function chromeTabCount(): Promise<number> {
  return new Promise((resolve) => {
    const cfg = getConfig();
    const url = (cfg.cdpUrl || 'http://localhost:9222').replace(/\/$/, '') + '/json/list';
    const req = http.get(url, { timeout: 2500 }, (res) => {
      let d = '';
      res.on('data', (c) => {
        d += c;
      });
      res.on('end', () => {
        try {
          const arr = JSON.parse(d) as unknown[];
          resolve(Array.isArray(arr) ? arr.length : 0);
        } catch {
          resolve(0);
        }
      });
    });
    req.on('error', () => resolve(0));
    req.on('timeout', () => {
      req.destroy();
      resolve(0);
    });
  });
}
