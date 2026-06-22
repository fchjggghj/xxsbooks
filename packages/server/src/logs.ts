/**
 * 日志解析
 *
 * 解析 run.log 和 daemon.log，提取事件。
 * 提供状态快照和速度统计。
 * 支持多任务（outline/adapt/generate），每个任务有独立的 run.log。
 */
import fs from 'node:fs';
import type { DaemonLogEntry, LogEvent, SpeedInfo, StatusSnapshot } from './types.js';
import { PATHS, readJson, readText, safeMtime, processAlive, getTaskPaths, TASK_DIRS } from './config.js';

/** 读取文件尾部（最多 maxBytes 字节） */
export function tailFile(file: string, maxBytes = 96 * 1024): string {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - maxBytes);
    const len = st.size - start;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    let s = buf.toString('utf8');
    if (start > 0) {
      const i = s.indexOf('\n');
      if (i >= 0) s = s.slice(i + 1);
    }
    return s;
  } catch {
    return '';
  }
}

// ---------- run.log 解析 ----------
const RE_TS = /^\[(\d{2}:\d{2}:\d{2})\]\s*(.*)$/;

/** 解析单行 run.log */
function parseRunLine(raw: string): LogEvent | null {
  const m = raw.match(RE_TS);
  if (!m) return null;
  const [, time, body] = m;
  const ev: LogEvent = { time, kind: 'info', text: body };
  let mm: RegExpMatchArray | null;
  // 成功：✓ 输入文件 -> 输出文件（N 字）— 支持任意扩展名
  if ((mm = body.match(/^✓\s*(\S+?\.\w+)\s*->\s*(\S+?\.\w+)（(\d+)\s*字）(.*)$/))) {
    ev.kind = 'ok';
    ev.chapter = mm[1];
    ev.out = mm[2];
    ev.chars = Number(mm[3]);
    ev.note = (mm[4] || '').trim();
  } else if ((mm = body.match(/^✗\s*(\S+?\.(\w+))?\s*[:：]?\s*(.*)$/))) {
    ev.kind = 'fail';
    ev.chapter = mm[1] || '';
    ev.reason = mm[3] || body;
  } else if (body.startsWith('↻')) {
    ev.kind = 'retry';
  } else if (body.startsWith('⚠')) {
    ev.kind = 'warn';
  } else if ((mm = body.match(/开始小说[:：]\s*(.+?)（待处理\s*(\d+)/))) {
    ev.kind = 'book';
    ev.book = mm[1];
    ev.pending = Number(mm[2]);
  } else if (/换新对话续发本书剩余/.test(body)) {
    ev.kind = 'rotate';
  }
  return ev;
}

/** 解析 run.log，返回最近 n 条事件（默认 outline 任务） */
export function parseRunLog(n = 300): LogEvent[] {
  const lines = tailFile(PATHS.runLog).split(/\r?\n/).filter(Boolean);
  const events: LogEvent[] = [];
  for (const ln of lines) {
    const ev = parseRunLine(ln);
    if (ev) events.push(ev);
  }
  return events.slice(-n);
}

/** 解析指定任务的 run.log */
export function parseRunLogForTask(taskId: string, n = 300): LogEvent[] {
  const paths = getTaskPaths(taskId);
  const lines = tailFile(paths.runLog).split(/\r?\n/).filter(Boolean);
  const events: LogEvent[] = [];
  for (const ln of lines) {
    const ev = parseRunLine(ln);
    if (ev) events.push(ev);
  }
  return events.slice(-n);
}

/** 解析 daemon.log，返回最近 n 条 */
export function parseDaemonLog(n = 120): DaemonLogEntry[] {
  const lines = tailFile(PATHS.daemonLog).split(/\r?\n/).filter(Boolean);
  return lines.slice(-n).map((ln) => {
    const m = ln.match(/^\[([\d-]+ [\d:]+)\]\s*(.*)$/);
    return m ? { time: m[1], text: m[2] } : { time: '', text: ln };
  });
}

/** 从事件计算速度（秒/章） */
export function speedFromEvents(events: LogEvent[]): SpeedInfo {
  const secs: number[] = [];
  for (const ev of events) {
    if (ev.kind !== 'ok') continue;
    const parts = ev.time.split(':').map(Number);
    if (parts.length !== 3) continue;
    const [h, m, s] = parts;
    secs.push(h * 3600 + m * 60 + s);
  }
  const deltas: number[] = [];
  for (let i = 1; i < secs.length; i++) {
    let d = secs[i] - secs[i - 1];
    if (d < 0) d += 86400;
    if (d > 0 && d <= 300) deltas.push(d);
  }
  const recent = deltas.slice(-30);
  const avg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : null;
  return { avgSecPerChapter: avg, samples: recent.length };
}

/** 生成状态快照（默认 outline 任务） */
export function statusSnapshot(events: LogEvent[]): StatusSnapshot {
  return statusSnapshotForTask('outline', events);
}

/** 生成指定任务的状态快照 */
export function statusSnapshotForTask(taskId: string, events: LogEvent[]): StatusSnapshot {
  const paths = getTaskPaths(taskId);
  const runLock = readJson<{ pid?: number }>(paths.runLock);
  const runnerAlive = !!(runLock?.pid && processAlive(runLock.pid));
  const daemonPidRaw = readText(paths.daemonLock).match(/pid=(\d+)/)?.[1];
  const daemonPid = daemonPidRaw ? Number(daemonPidRaw) : null;
  const daemonAlive = !!(daemonPid && processAlive(daemonPid));
  const stop = fs.existsSync(paths.stopFile);

  let lastOkTime: string | null = null;
  let activeBook: string | null = null;
  let lastEvent: LogEvent | null = null;
  let rateLimited = false;

  for (const ev of events) {
    if (ev.kind === 'book') activeBook = (ev.book as string) || null;
    if (ev.kind === 'ok') {
      lastOkTime = ev.time;
      rateLimited = false;
    }
    if (ev.kind === 'warn' && /配额墙/.test(ev.text)) rateLimited = true;
    lastEvent = ev;
  }

  return {
    runnerAlive,
    runnerPid: runLock?.pid || null,
    daemonAlive,
    daemonPid,
    stop,
    activeBook,
    lastOkTime,
    lastEvent,
    rateLimited,
    runLogMtime: safeMtime(paths.runLog),
  };
}

/** 获取所有任务的状态摘要 */
export function allTaskStatuses(): Array<{
  taskId: string;
  status: StatusSnapshot;
  speed: SpeedInfo;
  eventCount: number;
}> {
  const result: Array<{ taskId: string; status: StatusSnapshot; speed: SpeedInfo; eventCount: number }> = [];
  for (const taskId of Object.keys(TASK_DIRS)) {
    try {
      const events = parseRunLogForTask(taskId, 300);
      const status = statusSnapshotForTask(taskId, events);
      const speed = speedFromEvents(events);
      result.push({ taskId, status, speed, eventCount: events.length });
    } catch {
      // 任务目录不存在等错误跳过
    }
  }
  return result;
}
