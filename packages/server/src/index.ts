/**
 * 服务端入口
 *
 * 启动 HTTP 服务器，监听 127.0.0.1:8787。
 */
import http from 'node:http';
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
  console.info(`控制中心已启动: http://localhost:${PORT}`);
  console.info(`素材库: ${cfg.libraryRoot}`);
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

// 优雅退出
process.on('SIGINT', () => {
  console.info('收到 SIGINT，正在关闭...');
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  console.info('收到 SIGTERM，正在关闭...');
  server.close(() => process.exit(0));
});
