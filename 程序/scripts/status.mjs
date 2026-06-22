// 各阶段进度速览（dry-run 复算，只读）。用法：node scripts/status.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STAGES = [
  { id: 'step1_break_outline', cn: '拆大纲', runnerDir: 'gpt-outline-runner' },
  { id: 'step2_adapt',         cn: '改编  ', runnerDir: 'gpt-adapt-runner' },
];

function getStageInfo(stage) {
  const runnerDir = path.join(__dirname, stage.runnerDir);
  const r = spawnSync('node', ['run.mjs', '--dry-run'], { cwd: runnerDir, encoding: 'utf8', timeout: 30000 });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const g = (re) => (out.match(re) || [])[1] ?? '?';
  const pend = g(/__PENDING__=(\d+)/);
  const total = g(/全部大纲\s*:\s*(\d+)/);
  const novels = g(/小说总数\s*:\s*(\d+)/);
  return { pend, total, novels };
}

console.log('  阶段      待处理  全部大纲  小说数');
console.log('  ────────  ──────  ───────  ──────');
for (const stage of STAGES) {
  const info = getStageInfo(stage);
  const done = info.total !== '?' && info.pend !== '?' ? Number(info.total) - Number(info.pend) : '?';
  console.log(`  ${stage.cn}    ${String(info.pend).padStart(5)}  ${String(info.total).padStart(7)}  ${String(info.novels).padStart(5)}`);
}
