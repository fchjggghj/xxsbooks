/**
 * 进度速览（TypeScript 版）
 *
 * 替代 程序/scripts/status.mjs。
 *
 * 分别调用两个 runner 的 dry-run，显示三段进度。
 *
 * 用法：tsx src/status.ts
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  type OutlineConfig,
  type AdaptConfig,
  type StageId,
  loadConfig as loadConfigFile,
  getConfigPath,
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
  { id: 'step2_adapt', cn: '改编  ', runner: 'adapt' },
];

// ---------- 获取阶段信息 ----------
async function getStageInfo(stage: StageDef): Promise<RunResult> {
  const cfgPath = getConfigPath(stage.runner, PROJECT_ROOT);
  const cfg = loadConfigFile<OutlineConfig | AdaptConfig>(cfgPath);
  if (stage.runner === 'outline') {
    return await runOutline(cfg as OutlineConfig, true);
  } else {
    return await runAdapt(cfg as AdaptConfig, true);
  }
}

// ---------- 主流程 ----------
async function main(): Promise<void> {
  console.log('  阶段      待处理  全部大纲  小说数');
  console.log('  ────────  ──────  ───────  ──────');
  for (const stage of STAGES) {
    try {
      const info = await getStageInfo(stage);
      console.log(
        `  ${stage.cn}    ${String(info.pending).padStart(5)}  ${String(info.total).padStart(7)}  ${String(info.novels).padStart(5)}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ${stage.cn}    错误: ${msg}`);
    }
  }
}

// ---------- 入口 ----------
const isMain =
  import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/') ||
  process.argv[1]?.endsWith('status.ts') ||
  process.argv[1]?.endsWith('status.js');

if (isMain) {
  main().catch((err) => {
    console.error('状态查询出错:', err);
    process.exit(1);
  });
}

export { main as showStatus };
