import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  bootstrapCampaign,
  campaignStatus,
  decideCampaignLane,
  enrollCampaignBook,
  recordCampaignMetrics,
} from './lib/campaign.mjs';
import { readQueueLock } from './queue-lock.mjs';
import { inspectFanqieLock } from './lib/fanqie-lock.mjs';

export function campaignUsage() {
  return `XXSBooks 月度投放控制

用法:
  node control.mjs campaign status [--json]
  node control.mjs campaign tick [--apply] [--publish] [--json]
  node control.mjs campaign bootstrap [--month YYYY-MM --cycle 1|2|3] [--apply] [--json]
  node control.mjs campaign enroll --lane N --source main --file <素材相对路径> --book <新书名> [--apply]
  node control.mjs campaign metrics --lane N --readers N --read-through-rate N [--followers N --revenue-cny N --comments N --note 文本] [--apply]
  node control.mjs campaign decide --lane N --decision <continue|replace> --reason <原因> [--override] [--apply]

所有写操作默认只预览。拆改编和写仍由原 chai/xie 队列执行；status 会给出每条投放线的下一步。`;
}

export function parseCampaignArgs(argv) {
  const options = { command: '', apply: false, json: false, override: false, publish: false, sourceId: 'main' };
  const valueOptions = new Set(['--month', '--cycle', '--today', '--lane', '--source', '--file', '--book', '--readers', '--read-through-rate', '--followers', '--revenue-cny', '--comments', '--note', '--decision', '--reason']);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!options.command && !arg.startsWith('--')) options.command = arg;
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--override') options.override = true;
    else if (arg === '--publish') options.publish = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (valueOptions.has(arg)) {
      const value = argv[++index];
      if (value == null) throw new Error(`${arg} 缺少参数。`);
      const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      options[key === 'source' ? 'sourceId' : key === 'file' ? 'relativePath' : key] = value;
    } else throw new Error(`未知参数: ${arg}`);
  }
  return options;
}

function launchDetached(projectRoot, args) {
  const child = spawn(process.execPath, args, {
    cwd: projectRoot, windowsHide: true, detached: true, stdio: 'ignore',
  });
  child.unref();
  return child.pid;
}

export async function runCampaignTick(projectRoot, options = {}) {
  const root = path.resolve(projectRoot);
  const status = await campaignStatus(root, options);
  if (!status.initialized) return { ...status, command: 'campaign tick', action: 'bootstrap_required' };
  const queueLock = await readQueueLock(root);
  const fanqieLock = await inspectFanqieLock(root);
  if (queueLock.active || fanqieLock.active) {
    return {
      ok: true, command: 'campaign tick', readOnly: true, applied: false, action: 'wait',
      detail: queueLock.active ? `GPTS 队列 PID ${queueLock.info?.pid || '未知'} 正在运行` : `番茄发布 PID ${fanqieLock.info?.pid || '未知'} 正在运行`,
    };
  }
  const chai = status.lanes.filter((lane) => lane.phase === 'chai_pending');
  const xie = status.lanes.filter((lane) => lane.phase === 'xie_pending');
  const publish = status.lanes.filter((lane) => ['ready_to_publish', 'publishing'].includes(lane.phase));
  let action = 'idle';
  let args = [];
  let books = [];
  if (chai.length) {
    action = 'start_chai'; books = chai.map((lane) => lane.current.book);
    args = ['control.mjs', 'start', 'chai', ...books.flatMap((book) => ['--book', book]), '--json'];
  } else if (xie.length) {
    action = 'start_xie'; books = xie.map((lane) => lane.current.book);
    args = ['control.mjs', 'start', 'xie', ...books.flatMap((book) => ['--book', book]), '--json'];
  } else if (publish.length) {
    action = options.publish ? 'publish_fanqie' : 'publish_ready';
    books = [publish[0].current.book];
    if (options.publish) args = ['control.mjs', 'fanqie', 'upload', '--book', books[0], '--apply', '--json'];
  } else if (status.lanes.some((lane) => lane.phase === 'awaiting_fanqie_binding')) action = 'binding_required';
  else if (status.lanes.some((lane) => ['metrics_due', 'decision_due'].includes(lane.phase))) action = 'human_decision_required';
  else if (status.lanes.some((lane) => lane.phase === 'awaiting_replacement')) action = 'replacement_required';
  else if (status.lanes.every((lane) => lane.phase === 'observing')) action = 'observing';

  const result = {
    ok: true, command: 'campaign tick', readOnly: options.apply !== true, applied: false,
    action, books, args, blockers: status.lanes.filter((lane) => ['source_incomplete', 'awaiting_fanqie_binding', 'account_binding_mismatch', 'publish_attention', 'metrics_due', 'decision_due', 'awaiting_replacement'].includes(lane.phase)).map((lane) => ({ lane: lane.lane, book: lane.current?.book || null, phase: lane.phase, nextAction: lane.nextAction })),
  };
  if (!options.apply || !args.length) return result;
  if (action === 'publish_fanqie' && !options.publish) throw new Error('自动发布还需要显式 --publish。');
  result.pid = launchDetached(root, args);
  result.applied = true;
  result.readOnly = false;
  return result;
}

export async function runCampaignControl(argv, projectRoot) {
  const options = parseCampaignArgs(argv);
  if (options.help || !options.command || options.command === 'help') return { ok: true, help: campaignUsage() };
  if (options.command === 'status') return campaignStatus(projectRoot, options);
  if (options.command === 'tick') return runCampaignTick(projectRoot, options);
  if (options.command === 'bootstrap') return bootstrapCampaign(projectRoot, options);
  if (options.command === 'enroll') return enrollCampaignBook(projectRoot, options);
  if (options.command === 'metrics') return recordCampaignMetrics(projectRoot, options);
  if (options.command === 'decide') return decideCampaignLane(projectRoot, options);
  throw new Error(`未知投放命令: ${options.command}\n\n${campaignUsage()}`);
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  const projectRoot = path.resolve(process.env.XXSBOOKS_PROJECT_ROOT || path.dirname(fileURLToPath(import.meta.url)));
  runCampaignControl(process.argv.slice(2), projectRoot).then((result) => {
    console.log(result.help || JSON.stringify(result, null, 2));
  }).catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  });
}
