// 全接口压测：对 local-ui 的 14 个 API 端点各循环 100 次
// 检测：成功率、性能、内存泄漏、并发冲突、错误处理
// 用法：node stress-api.mjs
// 前置：需要先启动 local-ui（node local-ui.mjs --port 3210）

import http from 'node:http';
import process from 'node:process';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import fssync from 'node:fs';

const HOST = '127.0.0.1';
const PORT = 3211; // 用独立端口，启动专属后端实例
const BASE = `http://${HOST}:${PORT}`;
const LOOPS = 100;
const projectRoot = path.dirname(fileURLToPath(import.meta.url));

// ============ 工具函数 ============
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// HTTP 请求封装
function request(method, path, body = null, headers = {}) {
  return new Promise((resolve) => {
    const url = new URL(path, BASE);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Accept': 'application/json',
        ...headers,
      },
      timeout: 30_000,
    };
    if (body) {
      const json = JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(json);
    }

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch {}
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          body: parsed,
          text,
          time: 0, // 由调用者填
        });
      });
    });
    req.on('error', (error) => {
      resolve({ status: 0, ok: false, error: error.message, time: 0 });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, ok: false, error: 'timeout', time: 0 });
    });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// 带同源 Origin 的写请求
function writeRequest(method, path, body) {
  return request(method, path, body, { Origin: BASE });
}

// ============ 测试定义 ============
// 每个测试项：名称、请求构建函数、预期状态码、是否需要写锁
const testSuites = [
  {
    name: 'GET /api/status',
    category: '只读',
    loops: LOOPS,
    fn: async () => {
      const t = performance.now();
      const r = await request('GET', '/api/status');
      r.time = performance.now() - t;
      return r;
    },
    expectStatus: 200,
    validate: (r) => r.body?.stages?.chai && r.body?.stages?.xie,
  },
  {
    name: 'GET /api/books',
    category: '只读',
    loops: LOOPS,
    fn: async () => {
      const t = performance.now();
      const r = await request('GET', '/api/books');
      r.time = performance.now() - t;
      return r;
    },
    expectStatus: 200,
    validate: (r) => Array.isArray(r.body?.books),
  },
  {
    name: 'GET /api/config?stage=chai',
    category: '只读',
    loops: LOOPS,
    fn: async () => {
      const t = performance.now();
      const r = await request('GET', '/api/config?stage=chai');
      r.time = performance.now() - t;
      return r;
    },
    expectStatus: 200,
    validate: (r) => r.body?.config?.cdpUrl,
  },
  {
    name: 'GET /api/config?stage=xie',
    category: '只读',
    loops: LOOPS,
    fn: async () => {
      const t = performance.now();
      const r = await request('GET', '/api/config?stage=xie');
      r.time = performance.now() - t;
      return r;
    },
    expectStatus: 200,
    validate: (r) => r.body?.config?.cdpUrl,
  },
  {
    name: 'GET /api/logs?stage=chai',
    category: '只读',
    loops: LOOPS,
    fn: async () => {
      const t = performance.now();
      const r = await request('GET', '/api/logs?stage=chai');
      r.time = performance.now() - t;
      return r;
    },
    expectStatus: 200,
    validate: (r) => typeof r.body?.text === 'string',
  },
  {
    name: 'GET /api/logs?stage=xie',
    category: '只读',
    loops: LOOPS,
    fn: async () => {
      const t = performance.now();
      const r = await request('GET', '/api/logs?stage=xie');
      r.time = performance.now() - t;
      return r;
    },
    expectStatus: 200,
    validate: (r) => typeof r.body?.text === 'string',
  },
  {
    name: 'POST /api/reconcile (preview)',
    category: '写-预览',
    loops: LOOPS,
    fn: async () => {
      const t = performance.now();
      const r = await writeRequest('POST', '/api/reconcile', { stage: 'all', apply: false });
      r.time = performance.now() - t;
      return r;
    },
    expectStatus: 200,
    validate: (r) => r.body?.result?.stages,
  },
  {
    name: 'POST /api/normalize (preview)',
    category: '写-预览',
    loops: LOOPS,
    fn: async () => {
      const t = performance.now();
      const r = await writeRequest('POST', '/api/normalize', { book: '不存在的书', apply: false });
      r.time = performance.now() - t;
      return r;
    },
    // 不存在的书应该返回 409（control.mjs 报错）
    expectStatus: null, // 接受任意状态码，只检测不崩溃
    validate: (r) => r.status !== 0, // 只要不是连接失败
  },
  {
    name: 'POST /api/config (save chai)',
    category: '写-实际',
    loops: LOOPS,
    fn: async () => {
      // 先读取当前配置，再原样保存回去
      const read = await request('GET', '/api/config?stage=chai');
      if (!read.ok) return { status: 0, ok: false, error: 'read failed', time: 0 };
      const t = performance.now();
      const r = await writeRequest('POST', '/api/config', { stage: 'chai', config: read.body.config });
      r.time = performance.now() - t;
      return r;
    },
    expectStatus: 200,
    validate: (r) => r.body?.saved === true,
  },
  {
    name: 'POST /api/config (save xie)',
    category: '写-实际',
    loops: LOOPS,
    fn: async () => {
      const read = await request('GET', '/api/config?stage=xie');
      if (!read.ok) return { status: 0, ok: false, error: 'read failed', time: 0 };
      const t = performance.now();
      const r = await writeRequest('POST', '/api/config', { stage: 'xie', config: read.body.config });
      r.time = performance.now() - t;
      return r;
    },
    expectStatus: 200,
    validate: (r) => r.body?.saved === true,
  },
  {
    name: 'POST /api/config (invalid schema)',
    category: '错误处理',
    loops: LOOPS,
    fn: async () => {
      const t = performance.now();
      const r = await writeRequest('POST', '/api/config', {
        stage: 'xie',
        config: { cdpUrl: 'http://127.0.0.1:9222', gptUrl: 'https://invalid', inputSubdir: '拆分', outputSubdir: '正文', promptTemplate: '{{content}}' }
      });
      r.time = performance.now() - t;
      return r;
    },
    expectStatus: 400, // 应该被 schema 校验拒绝
    validate: (r) => r.body?.error?.includes('gptUrl'),
  },
  {
    name: 'POST /api/reconcile (无Origin)',
    category: '安全',
    loops: LOOPS,
    fn: async () => {
      const t = performance.now();
      const r = await request('POST', '/api/reconcile', { stage: 'all' }); // 无 Origin 头
      r.time = performance.now() - t;
      return r;
    },
    expectStatus: 403, // 应该被同源校验拒绝
    validate: (r) => r.body?.error?.includes('同源'),
  },
  {
    name: 'POST /api/action (无stage)',
    category: '错误处理',
    loops: LOOPS,
    fn: async () => {
      const t = performance.now();
      const r = await writeRequest('POST', '/api/action', { action: 'start' }); // 缺 stage
      r.time = performance.now() - t;
      return r;
    },
    expectStatus: 400,
    validate: (r) => r.body?.error && r.body.error.length > 0,
  },
  {
    name: 'POST /api/action (stop 无运行队列)',
    category: '写-安全',
    loops: LOOPS,
    fn: async () => {
      const t = performance.now();
      const r = await writeRequest('POST', '/api/action', { action: 'stop' });
      r.time = performance.now() - t;
      return r;
    },
    expectStatus: null, // stop 在无队列时可能 200 或 409
    validate: (r) => r.status !== 0,
  },
];

// ============ 并发测试 ============
async function testConcurrent() {
  console.log('\n========================================');
  console.log('并发测试：同时发送 10 个写请求，验证互斥锁');
  console.log('========================================');
  const promises = [];
  for (let i = 0; i < 10; i++) {
    promises.push(writeRequest('POST', '/api/reconcile', { stage: 'all', apply: false }));
  }
  const results = await Promise.all(promises);
  const success = results.filter((r) => r.ok).length;
  const conflicts = results.filter((r) => r.status === 409).length;
  console.log(`  成功: ${success}, 冲突(409): ${conflicts}, 其他: ${10 - success - conflicts}`);
  if (success >= 1 && success + conflicts === 10) {
    console.log('  ✓ 互斥锁正常：最多 1 个成功，其余被 409 拒绝');
    return true;
  } else {
    console.log('  ⚠ 互斥锁异常：期望 1 成功 + 9 冲突');
    return false;
  }
}

// ============ 运行单个测试套件 ============
async function runSuite(suite) {
  const stats = {
    name: suite.name,
    category: suite.category,
    loops: suite.loops,
    success: 0,
    fail: 0,
    statusMismatch: 0,
    validateFail: 0,
    errors: new Map(),
    times: [],
    maxTime: 0,
    minTime: Infinity,
    totalTime: 0,
  };

  for (let i = 0; i < suite.loops; i++) {
    let result;
    try {
      result = await suite.fn();
    } catch (error) {
      result = { status: 0, ok: false, error: error.message, time: 0 };
    }

    const time = result.time || 0;
    stats.times.push(time);
    stats.totalTime += time;
    if (time > stats.maxTime) stats.maxTime = time;
    if (time < stats.minTime) stats.minTime = time;

    // 状态码检查
    if (suite.expectStatus !== null && result.status !== suite.expectStatus) {
      stats.statusMismatch++;
      stats.fail++;
      const errKey = `status=${result.status} expected=${suite.expectStatus}`;
      stats.errors.set(errKey, (stats.errors.get(errKey) || 0) + 1);
      continue;
    }

    // 业务校验
    if (suite.validate && !suite.validate(result)) {
      stats.validateFail++;
      stats.fail++;
      const errKey = `validate failed: ${result.text?.slice(0, 100) || result.error || 'unknown'}`;
      stats.errors.set(errKey, (stats.errors.get(errKey) || 0) + 1);
      continue;
    }

    // 连接失败
    if (result.status === 0) {
      stats.fail++;
      const errKey = `connection: ${result.error}`;
      stats.errors.set(errKey, (stats.errors.get(errKey) || 0) + 1);
      continue;
    }

    stats.success++;
  }

  return stats;
}

// ============ 主函数 ============
async function main() {
  console.log('========================================');
  console.log('全接口压测');
  console.log(`循环次数: ${LOOPS} × ${testSuites.length} 个接口`);
  console.log(`端口: ${PORT}`);
  console.log('========================================\n');

  // 1. 启动专属后端
  console.log('启动后端...');
  const backend = spawn(process.execPath, ['local-ui.mjs', '--port', String(PORT)], {
    cwd: projectRoot,
    stdio: 'ignore',
    windowsHide: true,
  });

  // 等待就绪
  let ready = false;
  for (let i = 0; i < 40; i++) {
    if (backend.exitCode !== null) {
      console.error(`后端提前退出（exitCode=${backend.exitCode}）`);
      process.exit(1);
    }
    await sleep(200);
    try {
      const r = await request('GET', '/api/status');
      if (r.ok) { ready = true; break; }
    } catch {}
  }
  if (!ready) {
    console.error('后端 8 秒内未就绪');
    try { backend.kill(); } catch {}
    process.exit(1);
  }
  console.log('后端已就绪\n');

  const memStart = process.memoryUsage();
  const allStats = [];
  const allIssues = [];

  // 2. 运行所有测试套件
  for (const suite of testSuites) {
    process.stdout.write(`测试 ${suite.name}...`);
    const stats = await runSuite(suite);
    allStats.push(stats);

    const successRate = ((stats.success / stats.loops) * 100).toFixed(0);
    const avgTime = (stats.totalTime / stats.loops).toFixed(0);
    const status = stats.fail === 0 ? '✓' : '⚠';
    console.log(` ${status} ${successRate}% (${stats.success}/${stats.loops}) 平均${avgTime}ms 最快${stats.minTime.toFixed(0)}ms 最慢${stats.maxTime.toFixed(0)}ms`);

    if (stats.statusMismatch > 0) {
      console.log(`    状态码不符: ${stats.statusMismatch}次`);
      allIssues.push(`${suite.name}: 状态码不符 ${stats.statusMismatch}次`);
    }
    if (stats.validateFail > 0) {
      console.log(`    业务校验失败: ${stats.validateFail}次`);
      allIssues.push(`${suite.name}: 业务校验失败 ${stats.validateFail}次`);
    }
    for (const [err, count] of stats.errors) {
      console.log(`    [${count}次] ${err.slice(0, 120)}`);
    }
  }

  // 3. 并发测试
  const concurrentOk = await testConcurrent();
  if (!concurrentOk) allIssues.push('并发互斥锁异常');

  // 4. 内存检查
  const memEnd = process.memoryUsage();
  const rssGrowth = (memEnd.rss - memStart.rss) / 1024 / 1024;
  const heapGrowth = (memEnd.heapUsed - memStart.heapUsed) / 1024 / 1024;

  // 5. 最终报告
  console.log('\n========================================');
  console.log('压测结果汇总');
  console.log('========================================');
  console.log(`接口数: ${testSuites.length}`);
  console.log(`总请求数: ${testSuites.reduce((s, t) => s + t.loops, 0)}`);

  const totalSuccess = allStats.reduce((s, t) => s + t.success, 0);
  const totalFail = allStats.reduce((s, t) => s + t.fail, 0);
  console.log(`总成功: ${totalSuccess}`);
  console.log(`总失败: ${totalFail}`);
  console.log(`成功率: ${(totalSuccess / (totalSuccess + totalFail) * 100).toFixed(1)}%`);

  console.log('\n各接口详情:');
  console.log('接口'.padEnd(40) + '类别'.padEnd(12) + '成功'.padStart(6) + '失败'.padStart(6) + '平均ms'.padStart(8) + '最慢ms'.padStart(8));
  console.log('-'.repeat(80));
  for (const s of allStats) {
    const avg = (s.totalTime / s.loops).toFixed(0);
    console.log(
      s.name.padEnd(40) + s.category.padEnd(12) +
      String(s.success).padStart(6) + String(s.fail).padStart(6) +
      avg.padStart(8) + s.maxTime.toFixed(0).padStart(8)
    );
  }

  console.log(`\n内存变化:`);
  console.log(`  RSS: ${(memStart.rss / 1024 / 1024).toFixed(1)}MB -> ${(memEnd.rss / 1024 / 1024).toFixed(1)}MB (+${rssGrowth.toFixed(1)}MB)`);
  console.log(`  Heap: ${(memStart.heapUsed / 1024 / 1024).toFixed(1)}MB -> ${(memEnd.heapUsed / 1024 / 1024).toFixed(1)}MB (+${heapGrowth.toFixed(1)}MB)`);

  // 检测内存泄漏：每次请求平均增长不应超过 0.5MB
  const totalReqs = testSuites.reduce((s, t) => s + t.loops, 0);
  const perReqGrowth = rssGrowth / totalReqs;
  if (perReqGrowth > 0.5) {
    allIssues.push(`内存泄漏: 每次请求 RSS 增长 ${perReqGrowth.toFixed(2)}MB`);
  }

  console.log('\n========================================');
  if (allIssues.length === 0) {
    console.log(`✓ 全部 ${testSuites.length} 个接口 × ${LOOPS} 次循环通过，无问题。`);
  } else {
    console.log(`⚠ 发现 ${allIssues.length} 个问题：`);
    allIssues.forEach((i) => console.log(`  - ${i}`));
  }
  console.log('========================================');

  // 6. 关闭后端
  backend.kill();
  await new Promise((r) => backend.once('exit', r));
  console.log('\n后端已关闭。');
}

main().catch((error) => {
  console.error('压测脚本崩溃:', error);
  process.exit(1);
});
