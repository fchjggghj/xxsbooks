/**
 * 编排器主入口（TypeScript 版）
 *
 * 替代 程序/scripts/pipeline.mjs。
 *
 * 严格顺序执行 拆 → 改，任一处出错/未全部完成即停，绝不进入后续。
 * - 支持 --from step2_adapt（从某阶段起）
 * - 支持 --only step1_break_outline（只跑某一阶段）
 * - 阶段门：dry-run 复算 __PENDING__，必须为 0 才放行
 * - 调用 @novel-pipeline/runners 的 runOutline 和 runAdapt
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  type OutlineConfig,
  type AdaptConfig,
  type StageId,
  loadConfig as loadConfigFile,
  getConfigPath,
  log,
} from '@novel-pipeline/shared';
import { runOutline, runAdapt, type RunResult } from '@novel-pipeline/runners';

// ---------- 路径常量 ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

// ---------- 阶段定义 ----------
interface StageDef {
  id: StageId;
  cn: string;
  runner: 'outline' | 'adapt';
}

const STAGES: StageDef[] = [
  { id: 'step1_break_outline', cn: '拆大纲', runner: 'outline' },
  { id: 'step2_adapt', cn: '改编', runner: 'adapt' },
];

// ---------- 命令行参数 ----------
function hasFlag(f: string): boolean {
  return process.argv.includes(f);
}

function flagVal(f: string): string | null {
  const i = process.argv.indexOf(f);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

function halt(msg: string): never {
  log(`⛔ 停止：${msg}`);
  process.exit(1);
}

// ---------- 加载阶段配置 ----------
function loadStageConfig(stage: StageDef): OutlineConfig | AdaptConfig {
  const cfgPath = getConfigPath(stage.runner, PROJECT_ROOT);
  return loadConfigFile<OutlineConfig | AdaptConfig>(cfgPath);
}

// ---------- 运行阶段 ----------
async function runStage(stage: StageDef, dryRun: boolean): Promise<RunResult> {
  const cfg = loadStageConfig(stage);
  if (stage.runner === 'outline') {
    return await runOutline(cfg as OutlineConfig, dryRun);
  } else {
    return await runAdapt(cfg as AdaptConfig, dryRun);
  }
}

// ---------- 阶段门：dry-run 复算 pending ----------
async function stageGate(stage: StageDef): Promise<RunResult> {
  return await runStage(stage, true);
}

// ---------- 主流程 ----------
async function main(): Promise<void> {
  const only = flagVal('--only');
  const from = flagVal('--from');
  const dryRun = hasFlag('--dry-run');

  let stages = STAGES;
  if (only) {
    const s = STAGES.find((s) => s.id === only);
    if (!s) {
      halt(`未知阶段 --only ${only}，可选：${STAGES.map((s) => s.id).join(', ')}`);
    }
    stages = [s];
  } else if (from) {
    const i = STAGES.findIndex((s) => s.id === from);
    if (i < 0) {
      halt(`未知阶段 --from ${from}，可选：${STAGES.map((s) => s.id).join(', ')}`);
    }
    stages = STAGES.slice(i);
  }

  log(`计划顺序：${stages.map((s) => s.cn).join(' → ')}`);

  for (const stage of stages) {
    log(`==== 阶段 ${stage.cn}（${stage.id}）====`);

    // 先检查是否还有待处理
    const preGate = await stageGate(stage);
    if (preGate.pending === 0) {
      log(`✓ 阶段「${stage.cn}」已全部完成，跳过。`);
      continue;
    }
    log(`  待处理 ${preGate.pending} 章，开始运行…`);

    if (dryRun) {
      log(`[dry-run] 跳过实际运行阶段「${stage.cn}」。`);
      continue;
    }

    // 实际运行阶段
    try {
      await runStage(stage, false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      halt(`阶段「${stage.cn}」运行出错：${msg}。不进入下一阶段。`);
    }

    // 阶段门复算
    const gate = await stageGate(stage);
    if (gate.pending > 0) {
      halt(
        `阶段「${stage.cn}」未全部完成：待处理 ${gate.pending}。严格顺序：不进入下一阶段。先排查后重跑本阶段。`,
      );
    }
    log(`✓ 阶段「${stage.cn}」全部完成（pending=0），放行。`);
  }

  log('🎉 全部阶段完成。');
}

// ---------- 入口 ----------
const isMain =
  import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/') ||
  process.argv[1]?.endsWith('index.ts') ||
  process.argv[1]?.endsWith('index.js');

if (isMain) {
  main().catch((err) => {
    console.error('编排器运行出错:', err);
    process.exit(1);
  });
}

export { main as runPipeline };
