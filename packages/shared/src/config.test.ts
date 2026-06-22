/**
 * shared/src/config.ts 单元测试
 *
 * 覆盖配置加载、保存、校验、路径计算的所有边界场景。
 * 使用 os.tmpdir() 创建临时文件，测试后自动清理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadConfig,
  saveConfig,
  validateBaseConfig,
  validateOutlineConfig,
  validateAdaptConfig,
  getConfigPath,
} from './config.js';
import type { BaseConfig, OutlineConfig, AdaptConfig } from './types.js';

// ---------- 临时文件管理 ----------
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-cfg-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function tmpFile(name: string): string {
  return path.join(tmpDir, name);
}

// ---------- 有效配置工厂 ----------
function validBaseConfig(): BaseConfig {
  return {
    cdpUrl: 'http://127.0.0.1:9222',
    gptUrl: 'https://chatgpt.com/g/g-test',
    pipelineRoot: '/data/pipeline',
    maxChapters: 100,
    concurrency: 2,
    waitReplyTimeoutMs: 120000,
    replyStableMs: 3000,
    betweenChaptersMs: 5000,
    rateLimitWaitMs: 10000,
    maxRateLimitWaitMs: 300000,
    failurePauseMs: 60000,
    maxConsecutiveFailures: 5,
    stuckRetries: 3,
    minOutputChars: 800,
    deleteConversationAfterDone: false,
  };
}

function validOutlineConfig(): OutlineConfig {
  return {
    ...validBaseConfig(),
    libraryRoot: '/data/raw',
    novels: [],
    chaptersDir: '章节',
    outputDir: '拆大纲',
    outputExt: '.md',
    skipFiles: [],
    chaptersPerRequest: 5,
    promptTemplate: '请拆大纲',
    selection: {
      firstNPerNovel: 100,
      bigThreshold: 500,
      firstNForSmall: 50,
      firstNForNoData: 30,
      roundToArc: true,
    },
    webPort: 8787,
    scheduledTaskName: 'GptOutlineRunner',
  };
}

function validAdaptConfig(): AdaptConfig {
  return {
    ...validBaseConfig(),
    inputRoot: '/data/broken',
    outputRoot: '/data/adapted',
    novels: [],
    inputExt: '.md',
    outputExt: '.md',
    overlapBatchSize: 6,
    overlapBatchSizeNext: 7,
    overlapKeepCount: 5,
    promptPrefix: '请改编',
  };
}

// ============================================================
// loadConfig
// ============================================================
describe('loadConfig', () => {
  it('加载有效 JSON', () => {
    const p = tmpFile('valid.json');
    fs.writeFileSync(p, JSON.stringify({ a: 1, b: 'hello' }));
    const cfg = loadConfig<{ a: number; b: string }>(p);
    expect(cfg.a).toBe(1);
    expect(cfg.b).toBe('hello');
  });

  it('处理 BOM 头', () => {
    const p = tmpFile('bom.json');
    fs.writeFileSync(p, '\uFEFF{"key": "value"}', 'utf8');
    const cfg = loadConfig<{ key: string }>(p);
    expect(cfg.key).toBe('value');
  });

  it('无效 JSON 抛出友好错误', () => {
    const p = tmpFile('invalid.json');
    fs.writeFileSync(p, '{ invalid json }');
    expect(() => loadConfig(p)).toThrow(/解析失败/);
  });

  it('文件不存在抛出错误', () => {
    expect(() => loadConfig(tmpFile('nonexistent.json'))).toThrow();
  });
});

// ============================================================
// saveConfig
// ============================================================
describe('saveConfig', () => {
  it('保存并重新加载', () => {
    const p = tmpFile('roundtrip.json');
    const cfg = { name: 'test', value: 42, nested: { x: true } };
    saveConfig(p, cfg);
    const loaded = loadConfig<typeof cfg>(p);
    expect(loaded).toEqual(cfg);
  });

  it('覆盖已有文件', () => {
    const p = tmpFile('overwrite.json');
    saveConfig(p, { version: 1 });
    saveConfig(p, { version: 2 });
    const loaded = loadConfig<{ version: number }>(p);
    expect(loaded.version).toBe(2);
  });

  it('不留下 .tmp 文件', () => {
    const p = tmpFile('notmp.json');
    saveConfig(p, { a: 1 });
    expect(fs.existsSync(p + '.tmp')).toBe(false);
  });

  it('父目录不存在时抛出错误（saveConfig 不自动创建目录）', () => {
    const p = path.join(tmpDir, 'nonexistent-subdir', 'config.json');
    expect(() => saveConfig(p, { a: 1 })).toThrow();
  });
});

// ============================================================
// validateBaseConfig
// ============================================================
describe('validateBaseConfig', () => {
  it('有效配置返回空数组', () => {
    expect(validateBaseConfig(validBaseConfig())).toEqual([]);
  });

  it('cdpUrl 非 HTTP 报错', () => {
    const cfg = validBaseConfig();
    cfg.cdpUrl = 'ws://localhost:9222';
    expect(validateBaseConfig(cfg)).toContain('cdpUrl 必须是 HTTP URL');
  });

  it('gptUrl 非 HTTPS 报错', () => {
    const cfg = validBaseConfig();
    cfg.gptUrl = 'http://chatgpt.com';
    expect(validateBaseConfig(cfg)).toContain('gptUrl 必须是 HTTPS URL');
  });

  it('pipelineRoot 为空报错', () => {
    const cfg = validBaseConfig();
    cfg.pipelineRoot = '';
    expect(validateBaseConfig(cfg)).toContain('pipelineRoot 不能为空');
  });

  it('concurrency < 1 报错', () => {
    const cfg = validBaseConfig();
    cfg.concurrency = 0;
    expect(validateBaseConfig(cfg)).toContain('concurrency 必须 >= 1');
  });

  it('stuckRetries < 1 报错', () => {
    const cfg = validBaseConfig();
    cfg.stuckRetries = 0;
    expect(validateBaseConfig(cfg)).toContain('stuckRetries 必须 >= 1');
  });

  it('minOutputChars < 100 报错', () => {
    const cfg = validBaseConfig();
    cfg.minOutputChars = 50;
    expect(validateBaseConfig(cfg)).toContain('minOutputChars 必须 >= 100');
  });

  it('空对象收集所有错误', () => {
    const errors = validateBaseConfig({});
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  it('undefined 字段不报错（可选字段）', () => {
    const cfg = validBaseConfig();
    delete (cfg as Partial<BaseConfig>).concurrency;
    expect(validateBaseConfig(cfg)).toEqual([]);
  });
});

// ============================================================
// validateOutlineConfig
// ============================================================
describe('validateOutlineConfig', () => {
  it('有效配置返回空数组', () => {
    expect(validateOutlineConfig(validOutlineConfig())).toEqual([]);
  });

  it('libraryRoot 为空报错', () => {
    const cfg = validOutlineConfig();
    cfg.libraryRoot = '';
    expect(validateOutlineConfig(cfg)).toContain('libraryRoot 不能为空');
  });

  it('chaptersDir 为空报错', () => {
    const cfg = validOutlineConfig();
    cfg.chaptersDir = '';
    expect(validateOutlineConfig(cfg)).toContain('chaptersDir 不能为空');
  });

  it('outputDir 为空报错', () => {
    const cfg = validOutlineConfig();
    cfg.outputDir = '';
    expect(validateOutlineConfig(cfg)).toContain('outputDir 不能为空');
  });

  it('chaptersPerRequest < 1 报错', () => {
    const cfg = validOutlineConfig();
    cfg.chaptersPerRequest = 0;
    expect(validateOutlineConfig(cfg)).toContain('chaptersPerRequest 必须 >= 1');
  });

  it('继承 BaseConfig 校验', () => {
    const cfg = validOutlineConfig();
    cfg.cdpUrl = 'invalid';
    expect(validateOutlineConfig(cfg)).toContain('cdpUrl 必须是 HTTP URL');
  });
});

// ============================================================
// validateAdaptConfig
// ============================================================
describe('validateAdaptConfig', () => {
  it('有效配置返回空数组', () => {
    expect(validateAdaptConfig(validAdaptConfig())).toEqual([]);
  });

  it('inputRoot 为空报错', () => {
    const cfg = validAdaptConfig();
    cfg.inputRoot = '';
    expect(validateAdaptConfig(cfg)).toContain('inputRoot 不能为空');
  });

  it('outputRoot 为空报错', () => {
    const cfg = validAdaptConfig();
    cfg.outputRoot = '';
    expect(validateAdaptConfig(cfg)).toContain('outputRoot 不能为空');
  });

  it('overlapBatchSize < 2 报错', () => {
    const cfg = validAdaptConfig();
    cfg.overlapBatchSize = 1;
    expect(validateAdaptConfig(cfg)).toContain('overlapBatchSize 必须 >= 2');
  });

  it('overlapKeepCount < 1 报错', () => {
    const cfg = validAdaptConfig();
    cfg.overlapKeepCount = 0;
    expect(validateAdaptConfig(cfg)).toContain('overlapKeepCount 必须 >= 1');
  });

  it('overlapKeepCount >= overlapBatchSizeNext 报错', () => {
    const cfg = validAdaptConfig();
    cfg.overlapKeepCount = 7;
    cfg.overlapBatchSizeNext = 7;
    expect(validateAdaptConfig(cfg)).toContain(
      'overlapKeepCount 应 < overlapBatchSizeNext，否则后续批次无重叠章',
    );
  });

  it('继承 BaseConfig 校验', () => {
    const cfg = validAdaptConfig();
    cfg.gptUrl = 'http://invalid';
    expect(validateAdaptConfig(cfg)).toContain('gptUrl 必须是 HTTPS URL');
  });
});

// ============================================================
// getConfigPath
// ============================================================
describe('getConfigPath', () => {
  it('outline 类型返回 gpt-outline-runner 路径', () => {
    const p = getConfigPath('outline', '/project');
    expect(p).toBe(path.join('/project', '程序', 'scripts', 'gpt-outline-runner', 'config.json'));
  });

  it('adapt 类型返回 gpt-adapt-runner 路径', () => {
    const p = getConfigPath('adapt', '/project');
    expect(p).toBe(path.join('/project', '程序', 'scripts', 'gpt-adapt-runner', 'config.json'));
  });

  it('路径包含 pipelineRoot', () => {
    const p = getConfigPath('outline', '/my/pipeline');
    // Windows 上 path.join 使用反斜杠，需 normalize 后比较
    expect(p).toBe(path.join('/my/pipeline', '程序', 'scripts', 'gpt-outline-runner', 'config.json'));
    expect(p).toMatch(/my.pipeline/);
  });
});
