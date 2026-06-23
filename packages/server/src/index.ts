/**
 * 服务端入口
 *
 * 启动 HTTP 服务器，监听 127.0.0.1:8787。
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { getConfig, getPort, SCAN_TTL } from './config.js';
import { handleRequest } from './router.js';
import { getScan } from './scanner.js';

const PORT = getPort();
const cfg = getConfig();

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error('请求处理失败:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.info(`控制中心已启动: ${url}`);
  console.info(`素材库: ${cfg.libraryRoot}`);
  openBrowser(url);
  getScan(true).catch((e) => {
    console.error('首次扫描失败:', e instanceof Error ? e.message : String(e));
  });
  setInterval(
    () => {
      getScan(false).catch(() => {});
    },
    Math.round(SCAN_TTL * 0.8),
  );
});

function openBrowser(url: string) {
  try {
    const platform = process.platform;
    if (platform === 'win32') {
      spawn('cmd', ['/c', 'start', url]);
    } else if (platform === 'darwin') {
      spawn('open', [url]);
    } else {
      spawn('xdg-open', [url]);
    }
    console.info('正在打开浏览器...');
  } catch {
    console.info(`请手动打开浏览器访问: ${url}`);
  }
}

// 优雅退出
process.on('SIGINT', () => {
  console.info('收到 SIGINT，正在关闭...');
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  console.info('收到 SIGTERM，正在关闭...');
  server.close(() => process.exit(0));
});
