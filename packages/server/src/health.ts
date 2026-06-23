/**
 * 健康检查
 *
 * 健康快照：uptime、内存、Chrome、队列、心跳。
 */
import type { HealthSnapshot, ChromeStatus } from './types.js';
import { chromeStatus } from './chrome.js';
import {
  heartbeatAgeSec,
  getQueueRuntime,
  loadQueueStore,
  queueHealth,
  readQueueEvents,
} from './queue.js';

/** 生成健康快照 */
export async function healthSnapshot(): Promise<HealthSnapshot> {
  const mem = process.memoryUsage();

  const [store, chrome, runtime, hbAge] = await Promise.all([
    Promise.resolve(loadQueueStore()),
    Promise.race([chromeStatus(), new Promise<ChromeStatus>((resolve) => setTimeout(() => resolve({ up: false }), 500))]),
    Promise.resolve(getQueueRuntime()),
    Promise.resolve(heartbeatAgeSec()),
  ]);

  const health = queueHealth(store);
  const recentEvents = readQueueEvents(30);

  return {
    ok: health.ok && (!runtime.running || hbAge == null || hbAge < 120),
    uptimeSec: Math.round(process.uptime()),
    pid: process.pid,
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
    },
    chrome,
    queue: health,
    runtime: { ...runtime, heartbeatAgeSec: hbAge },
    recentEvents,
  };
}
