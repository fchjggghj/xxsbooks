/**
 * 健康检查
 *
 * 健康快照：uptime、内存、Chrome、队列、心跳。
 */
import type { HealthSnapshot } from './types.js';
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
  const store = loadQueueStore();
  const chrome = await chromeStatus();
  const health = queueHealth(store);
  const mem = process.memoryUsage();
  const runtime = getQueueRuntime();
  const hbAge = heartbeatAgeSec();

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
    recentEvents: readQueueEvents(30),
  };
}
