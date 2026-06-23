/**
 * 服务端入口
 *
 * 启动 HTTP 服务器，监听 127.0.0.1:8787。
 */
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { getConfig, getPort, SCAN_TTL, PATHS } from './config.js';
import { handleRequest } from './router.js';
import { getScan } from './scanner.js';

const PORT = getPort();
const cfg = getConfig();

async function buildFrontendIfNeeded(): Promise<void> {
  const indexHtml = `${PATHS.webDist}/index.html`;
  if (fs.existsSync(indexHtml)) {
    console.info('前端已构建，跳过构建步骤');
    return;
  }
  console.info('前端未构建，正在自动构建...');
  return new Promise((resolve, reject) => {
    const args = process.platform === 'win32'
      ? ['/c', 'pnpm', '--filter', '@novel-pipeline/web', 'build']
      : ['pnpm', '--filter', '@novel-pipeline/web', 'build'];
    const child = spawn(process.platform === 'win32' ? 'cmd' : 'sh', args, {
      cwd: PATHS.projectRoot,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('close', (code) => {
      if (code === 0) {
        console.info('前端构建成功');
        resolve();
      } else {
        reject(new Error(`前端构建失败，退出码: ${code}`));
      }
    });
    child.on('error', reject);
  });
}

async function main() {
  try {
    await buildFrontendIfNeeded();
  } catch (err) {
    console.error('前端构建失败:', err);
    process.exit(1);
  }

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

  process.on('SIGINT', () => {
    console.info('收到 SIGINT，正在关闭...');
    server.close(() => process.exit(0));
  });

  process.on('SIGTERM', () => {
    console.info('收到 SIGTERM，正在关闭...');
    server.close(() => process.exit(0));
  });
}

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

main();
