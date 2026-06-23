/**
 * 配置加载与校验
 */
import fs from 'node:fs';
import path from 'node:path';
import type { BaseConfig, OutlineConfig, AdaptConfig, DirectionConfig } from './types.js';

/** 加载 JSON 配置文件（带 BOM 处理和友好报错） */
export function loadConfig<T>(cfgPath: string): T {
  try {
    const raw = fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`配置文件 ${cfgPath} 解析失败: ${msg}`);
  }
}

/** 保存配置（原子写入） */
export function saveConfig<T>(cfgPath: string, config: T): void {
  const tmp = cfgPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
  fs.renameSync(tmp, cfgPath);
}

/** 校验基础配置 */
export function validateBaseConfig(cfg: Partial<BaseConfig>): string[] {
  const errors: string[] = [];
  if (!cfg.cdpUrl?.startsWith('http')) errors.push('cdpUrl 必须是 HTTP URL');
  if (!cfg.gptUrl?.startsWith('https://')) errors.push('gptUrl 必须是 HTTPS URL');
  if (!cfg.pipelineRoot) errors.push('pipelineRoot 不能为空');
  if (cfg.concurrency !== undefined && cfg.concurrency < 1) errors.push('concurrency 必须 >= 1');
  if (cfg.stuckRetries !== undefined && cfg.stuckRetries < 1) errors.push('stuckRetries 必须 >= 1');
  if (cfg.minOutputChars !== undefined && cfg.minOutputChars < 100)
    errors.push('minOutputChars 必须 >= 100');
  return errors;
}

/** 校验拆大纲配置 */
export function validateOutlineConfig(cfg: Partial<OutlineConfig>): string[] {
  const errors = validateBaseConfig(cfg);
  if (!cfg.libraryRoot) errors.push('libraryRoot 不能为空');
  if (!cfg.chaptersDir) errors.push('chaptersDir 不能为空');
  if (!cfg.outputDir) errors.push('outputDir 不能为空');
  if (cfg.chaptersPerRequest !== undefined && cfg.chaptersPerRequest < 1) {
    errors.push('chaptersPerRequest 必须 >= 1');
  }
  return errors;
}

/** 校验改编配置 */
export function validateAdaptConfig(cfg: Partial<AdaptConfig>): string[] {
  const errors = validateBaseConfig(cfg);
  if (!cfg.inputRoot) errors.push('inputRoot 不能为空');
  if (!cfg.outputRoot) errors.push('outputRoot 不能为空');
  if (cfg.overlapBatchSize !== undefined && cfg.overlapBatchSize < 2) {
    errors.push('overlapBatchSize 必须 >= 2');
  }
  if (cfg.overlapKeepCount !== undefined && cfg.overlapKeepCount < 1) {
    errors.push('overlapKeepCount 必须 >= 1');
  }
  if (
    cfg.overlapKeepCount &&
    cfg.overlapBatchSizeNext &&
    cfg.overlapKeepCount >= cfg.overlapBatchSizeNext
  ) {
    errors.push('overlapKeepCount 应 < overlapBatchSizeNext，否则后续批次无重叠章');
  }
  return errors;
}

/** 校验改编方向配置 */
export function validateDirectionConfig(cfg: Partial<DirectionConfig>): string[] {
  const errors = validateBaseConfig(cfg);
  if (!cfg.inputRoot) errors.push('inputRoot 不能为空');
  if (!cfg.outputRoot) errors.push('outputRoot 不能为空');
  return errors;
}

/** 获取默认配置路径 */
export function getConfigPath(
  runnerType: 'outline' | 'adapt' | 'generate' | 'direction',
  pipelineRoot: string,
): string {
  const scriptsDir = path.join(pipelineRoot, '程序', 'scripts');
  const dirMap: Record<string, string> = {
    outline: 'gpt-outline-runner',
    adapt: 'gpt-adapt-runner',
    generate: 'gpt-generate-runner',
    direction: 'gpt-direction-runner',
  };
  return path.join(scriptsDir, dirMap[runnerType], 'config.json');
}
