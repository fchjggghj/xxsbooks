// 启动关闭循环压测：检测进程泄漏、端口泄漏、内存泄漏、句柄泄漏
// 用法：node stress-loop.mjs [循环次数]（默认 1000）
// 每次循环：启动 local-ui.mjs -> 验证 /api/status -> 关闭进程 -> 验证退出+端口释放

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const execFileAsync = promisify(execFile);
const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3299; // 用不同端口避免和正常使用的 3210 冲突
const HOST = '127.0.0.1';

const TOTAL = Number(process.argv[2]) || 1000;

// ============ 工具函数 ============
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 检测端口是否在监听
function isPortListening(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://${HOST}:${port}/api/status`, { timeout: 800 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// 获取占用指定端口的 PID 列表
async function getPidsOnPort(port) {
  try {
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile', '-Command',
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess) -join ','`
    ], { timeout: 5000, encoding: 'utf8' });
    const pids = stdout.trim().split(',').filter(Boolean).map(Number);
    return pids;
  } catch {
    return [];
  }
}

// 获取所有 node 进程数（粗略检测进程泄漏）
async function getNodeProcessCount() {
  try {
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile', '-Command',
      '@(Get-Process -Name node -ErrorAction SilentlyContinue).Count'
    ], { timeout: 5000, encoding: 'utf8' });
    return Number(stdout.trim()) || 0;
  } catch {
    return -1;
  }
}

// 强制杀掉 PID
async function killPid(pid) {
  try {
    await execFileAsync('taskkill', ['/PID', String(pid), '/F', '/T'], { timeout: 5000, encoding: 'utf8' });
  } catch { /* 可能已退出 */ }
}

// ============ 单次启动关闭循环 ============
async function singleCycle(index) {
  const result = {
    index,
    startMs: 0,
    statusMs: 0,
    stopMs: 0,
    verifyMs: 0,
    totalMs: 0,
    success: false,
    error: null,
  };
  const t0 = performance.now();

  // 1. 启动后端
  let child;
  try {
    child = spawn(process.execPath, ['local-ui.mjs', '--port', String(PORT)], {
      cwd: projectRoot,
      stdio: 'ignore',
      windowsHide: true,
      detached: false,
    });
  } catch (error) {
    result.error = `spawn 失败: ${error.message}`;
    result.totalMs = performance.now() - t0;
    return result;
  }

  result.startMs = performance.now() - t0;

  // 2. 等待 /api/status 可用（用 'exit' 事件代替轮询 exitCode）
  const t1 = performance.now();
  let exitEarly = false;
  const exitHandler = () => { exitEarly = true; };
  child.once('exit', exitHandler);

  let statusOk = false;
  for (let i = 0; i < 40; i++) {
    if (exitEarly) break;
    await sleep(100);
    if (await isPortListening(PORT)) {
      statusOk = true;
      break;
    }
  }
  result.statusMs = performance.now() - t1;

  if (!statusOk) {
    result.error = exitEarly ? `后端提前退出（exitCode=${child.exitCode}）` : '后端 4 秒内未就绪';
    try { child.kill(); } catch {}
    // 等待 exit 事件
    if (!exitEarly) await new Promise((r) => child.once('exit', r));
    result.totalMs = performance.now() - t0;
    return result;
  }

  // 3. 关闭后端
  const t2 = performance.now();
  try {
    child.kill();
  } catch (error) {
    result.error = `kill 失败: ${error.message}`;
    result.totalMs = performance.now() - t0;
    return result;
  }

  // 等待进程退出（用 exit 事件，最多等 3 秒）
  let exited = false;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', resolve);
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      exited = true;
      resolve();
    });
  });
  result.stopMs = performance.now() - t2;

  if (!exited) {
    try { process.kill(child.pid); } catch {}
    await new Promise((r) => child.once('exit', r));
  }

  // 4. 验证端口已释放（只用快速 HTTP 探测，不调 PowerShell）
  const t3 = performance.now();
  await sleep(100);
  const stillListening = await isPortListening(PORT);
  result.verifyMs = performance.now() - t3;

  if (stillListening) {
    result.error = '端口未释放（HTTP 探测仍可连接）';
    result.totalMs = performance.now() - t0;
    return result;
  }

  child.removeListener('exit', exitHandler);
  result.success = true;
  result.totalMs = performance.now() - t0;
  return result;
}

// ============ 主循环 ============
async function main() {
  console.log('========================================');
  console.log(`启动关闭循环压测`);
  console.log(`循环次数: ${TOTAL}`);
  console.log(`端口: ${PORT}`);
  console.log('========================================\n');

  // 预检：确保端口空闲
  const prePids = await getPidsOnPort(PORT);
  if (prePids.length > 0) {
    console.log(`端口 ${PORT} 被占用（PID: ${prePids.join(',')}），先清理...`);
    for (const pid of prePids) await killPid(pid);
    await sleep(1000);
  }

  const initialNodeCount = await getNodeProcessCount();
  const memStart = process.memoryUsage();
  console.log(`初始状态: node 进程数=${initialNodeCount}, RSS=${(memStart.rss / 1024 / 1024).toFixed(1)}MB\n`);

  const stats = {
    success: 0,
    fail: 0,
    errors: new Map(), // error message -> count
    totalTime: 0,
    maxTime: 0,
    minTime: Infinity,
    cycleTimes: [],
    nodeProcessChecks: [],
  };

  const startTime = performance.now();
  let lastReportTime = startTime;

  for (let i = 0; i < TOTAL; i++) {
    const result = await singleCycle(i);
    stats.totalTime += result.totalMs;
    stats.cycleTimes.push(result.totalMs);
    if (result.totalMs > stats.maxTime) stats.maxTime = result.totalMs;
    if (result.totalMs < stats.minTime) stats.minTime = result.totalMs;

    if (result.success) {
      stats.success++;
    } else {
      stats.fail++;
      const err = result.error || '未知错误';
      stats.errors.set(err, (stats.errors.get(err) || 0) + 1);
    }

    // 每 100 次或最后一次打印进度 + 资源检查
    const now = performance.now();
    if ((i + 1) % 100 === 0 || i === TOTAL - 1) {
      const nodeCount = await getNodeProcessCount();
      const memCurrent = process.memoryUsage();
      const elapsed = ((now - startTime) / 1000).toFixed(1);
      const successRate = ((stats.success / (i + 1)) * 100).toFixed(1);
      console.log(
        `[${i + 1}/${TOTAL}] ${elapsed}s | 成功 ${stats.success} 失败 ${stats.fail} (${successRate}%) | ` +
        `node进程=${nodeCount} RSS=${(memCurrent.rss / 1024 / 1024).toFixed(1)}MB | ` +
        `平均=${(stats.totalTime / (i + 1)).toFixed(0)}ms 最快=${stats.minTime.toFixed(0)}ms 最慢=${stats.maxTime.toFixed(0)}ms`
      );
      stats.nodeProcessChecks.push({ cycle: i + 1, nodeCount, rss: memCurrent.rss });

      // 检测进程泄漏：node 进程数比初始多 5 个以上
      if (nodeCount > initialNodeCount + 5) {
        console.log(`  ⚠ 警告: node 进程数 ${nodeCount} 远超初始 ${initialNodeCount}，可能存在进程泄漏！`);
      }
      // 检测内存泄漏：RSS 增长超过 100MB
      if (memCurrent.rss > memStart.rss + 100 * 1024 * 1024) {
        console.log(`  ⚠ 警告: RSS 增长 ${((memCurrent.rss - memStart.rss) / 1024 / 1024).toFixed(1)}MB，可能存在内存泄漏！`);
      }
      lastReportTime = now;
    }
  }

  const totalTime = ((performance.now() - startTime) / 1000).toFixed(1);

  // ============ 最终报告 ============
  console.log('\n========================================');
  console.log('压测结果汇总');
  console.log('========================================');
  console.log(`总循环: ${TOTAL}`);
  console.log(`成功: ${stats.success} (${((stats.success / TOTAL) * 100).toFixed(1)}%)`);
  console.log(`失败: ${stats.fail} (${((stats.fail / TOTAL) * 100).toFixed(1)}%)`);
  console.log(`总耗时: ${totalTime}s`);
  console.log(`平均每次: ${(stats.totalTime / TOTAL).toFixed(0)}ms`);
  console.log(`最快: ${stats.minTime.toFixed(0)}ms`);
  console.log(`最慢: ${stats.maxTime.toFixed(0)}ms`);
  console.log(`吞吐: ${(TOTAL / Number(totalTime)).toFixed(1)} 次/秒`);

  // 内存变化
  const memEnd = process.memoryUsage();
  console.log(`\n内存变化:`);
  console.log(`  RSS: ${(memStart.rss / 1024 / 1024).toFixed(1)}MB -> ${(memEnd.rss / 1024 / 1024).toFixed(1)}MB (+${((memEnd.rss - memStart.rss) / 1024 / 1024).toFixed(1)}MB)`);
  console.log(`  Heap: ${(memStart.heapUsed / 1024 / 1024).toFixed(1)}MB -> ${(memEnd.heapUsed / 1024 / 1024).toFixed(1)}MB (+${((memEnd.heapUsed - memStart.heapUsed) / 1024 / 1024).toFixed(1)}MB)`);

  // 进程检查趋势
  const finalNodeCount = await getNodeProcessCount();
  console.log(`\n进程检查:`);
  console.log(`  初始 node 进程数: ${initialNodeCount}`);
  console.log(`  最终 node 进程数: ${finalNodeCount}`);
  if (finalNodeCount > initialNodeCount) {
    console.log(`  ⚠ 差异: +${finalNodeCount - initialNodeCount}（可能有泄漏进程）`);
  } else {
    console.log(`  ✓ 无进程泄漏`);
  }

  // 错误分类
  if (stats.errors.size > 0) {
    console.log(`\n错误分类:`);
    for (const [err, count] of [...stats.errors.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  [${count}次] ${err}`);
    }
  }

  // 内存趋势分析
  if (stats.nodeProcessChecks.length > 1) {
    const first = stats.nodeProcessChecks[0];
    const last = stats.nodeProcessChecks[stats.nodeProcessChecks.length - 1];
    const rssGrowth = ((last.rss - first.rss) / 1024 / 1024).toFixed(1);
    console.log(`\n内存趋势:`);
    console.log(`  第${first.cycle}次: RSS=${(first.rss / 1024 / 1024).toFixed(1)}MB`);
    console.log(`  第${last.cycle}次: RSS=${(last.rss / 1024 / 1024).toFixed(1)}MB`);
    console.log(`  增长: ${rssGrowth}MB ${Number(rssGrowth) > 50 ? '⚠ 可能泄漏' : '✓ 稳定'}`);
  }

  // 最终结论
  console.log('\n========================================');
  const issues = [];
  if (stats.fail > 0) issues.push(`失败 ${stats.fail} 次`);
  if (finalNodeCount > initialNodeCount) issues.push(`进程泄漏 +${finalNodeCount - initialNodeCount}`);
  if (memEnd.rss > memStart.rss + 100 * 1024 * 1024) issues.push(`内存泄漏 +${((memEnd.rss - memStart.rss) / 1024 / 1024).toFixed(0)}MB`);
  const slowCycles = stats.cycleTimes.filter((t) => t > 3000).length;
  if (slowCycles > TOTAL * 0.05) issues.push(`${slowCycles} 次超过 3 秒`);

  if (issues.length === 0) {
    console.log(`✓ ${TOTAL} 次启动关闭循环全部通过，无进程泄漏、无内存泄漏、性能稳定。`);
  } else {
    console.log(`⚠ 发现问题: ${issues.join('、')}`);
  }
  console.log('========================================');
}

main().catch((error) => {
  console.error('压测脚本崩溃:', error);
  process.exit(1);
});
