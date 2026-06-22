// 编排器：严格顺序执行 拆 → 改，任一处出错/未全部完成即停，绝不进入后续。
// 下载已移除（改为手动下载）；正文生成暂未实现。
// 阶段门：每个阶段跑完后用 --dry-run 复算 __PENDING__，必须为 0 才放行。
// 用法：
//   node scripts/pipeline.mjs                              拆 → 改
//   node scripts/pipeline.mjs --from step2_adapt           从改编起
//   node scripts/pipeline.mjs --only step1_break_outline   只跑拆大纲
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 每个阶段对应自己的 runner 目录
const STAGES = [
  { id: 'step1_break_outline', cn: '拆大纲', runnerDir: 'gpt-outline-runner' },
  { id: 'step2_adapt',         cn: '改编',   runnerDir: 'gpt-adapt-runner' },
];

function hasFlag(f) { return process.argv.includes(f); }
function flagVal(f) { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : null; }

function log(msg) { console.log(`[pipeline ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`); }
function halt(msg) { log(`⛔ 停止：${msg}`); process.exit(1); }

// 跑一个子进程（继承 stdout/stderr）；返回退出码。
function runInherit(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false });
  if (r.error) return { code: 1, error: r.error };
  return { code: r.status == null ? 1 : r.status };
}

// 阶段门：dry-run 复算该阶段的 pending。
function stageGate(stage) {
  const runnerDir = path.join(__dirname, stage.runnerDir);
  const r = spawnSync('node', ['run.mjs', '--dry-run'], { cwd: runnerDir, encoding: 'utf8' });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const pend = Number((out.match(/__PENDING__=(\d+)/) || [])[1]);
  if (!Number.isFinite(pend)) return { ok: false, pend: NaN, raw: out.slice(0, 500) };
  return { ok: pend === 0, pend };
}

function main() {
  const only = flagVal('--only');
  const from = flagVal('--from');

  let stages = STAGES;
  if (only) {
    const s = STAGES.find((s) => s.id === only);
    if (!s) halt(`未知阶段 --only ${only}，可选：${STAGES.map((s) => s.id).join(', ')}`);
    stages = [s];
  } else if (from) {
    const i = STAGES.findIndex((s) => s.id === from);
    if (i < 0) halt(`未知阶段 --from ${from}，可选：${STAGES.map((s) => s.id).join(', ')}`);
    stages = STAGES.slice(i);
  }

  log(`计划顺序：${stages.map((s) => s.cn).join(' → ')}`);

  for (const stage of stages) {
    const runnerDir = path.join(__dirname, stage.runnerDir);
    log(`==== 阶段 ${stage.cn}（${stage.id}）====`);

    // 先检查是否还有待处理
    const preGate = stageGate(stage);
    if (preGate.ok) {
      log(`✓ 阶段「${stage.cn}」已全部完成，跳过。`);
      continue;
    }
    log(`  待处理 ${preGate.pend} 章，开始运行…`);

    const r = runInherit('node', ['run.mjs'], runnerDir);
    if (r.code !== 0) halt(`阶段「${stage.cn}」运行非正常退出（码 ${r.code}）。不进入下一阶段。`);

    const gate = stageGate(stage);
    if (!Number.isFinite(gate.pend)) halt(`阶段门复算失败（读不到 __PENDING__）。\n${gate.raw || ''}`);
    if (!gate.ok) halt(`阶段「${stage.cn}」未全部完成：待处理 ${gate.pend}。严格顺序：不进入下一阶段。先排查后重跑本阶段。`);
    log(`✓ 阶段「${stage.cn}」全部完成（pending=0），放行。`);
  }

  log('🎉 全部阶段完成。');
}

main();
