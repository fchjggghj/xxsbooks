/**
 * GPTS 提示词 Dry-Run 测试脚本
 *
 * 功能：构造三个阶段（拆大纲/改编大纲/生成正文）的完整提示词，输出到控制台和文件。
 * 不实际调用 ChatGPT，只验证提示词构造是否正确。
 *
 * 用法：tsx 程序/scripts/test-gpts-prompt.ts [小说目录名] [章节base名]
 * 默认：0001_快穿之我替人渣走正途【在读：25.1万人在读】 / 第001章_古代白眼狼书生1
 */
import fs from 'node:fs';
import path from 'node:path';

// ============ 配置 ============
const ROOT = 'C:/Users/Administrator/Desktop/novel_pipeline';
const RAW_ROOT = path.join(ROOT, 'data/00_raw_chapters');
const BROKEN_ROOT = path.join(ROOT, 'data/01_broken_outlines');
const ADAPTED_ROOT = path.join(ROOT, 'data/02_adapted');
const ADAPT_CONFIG = path.join(ROOT, '程序/scripts/gpt-adapt-runner/config.json');
const GENERATE_CONFIG = path.join(ROOT, '程序/scripts/gpt-generate-runner/config.json');
const OUT_DIR = path.join(ROOT, '程序/scripts/test-output');

// ============ 参数 ============
const novelName = process.argv[2] || '0001_快穿之我替人渣走正途【在读：25.1万人在读】';
const chapterBase = process.argv[3] || '第001章_古代白眼狼书生1';

console.log('═'.repeat(80));
console.log('GPTS 提示词 Dry-Run 测试');
console.log('═'.repeat(80));
console.log(`小说: ${novelName}`);
console.log(`章节: ${chapterBase}`);
console.log();

// ============ 工具函数 ============
function readFileSync(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function ensureDir(p: string): void {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

/** 读取参考原文前 N 字（模拟 generate-runner.ts 的 readRawOpening） */
function readRawOpening(maxChars = 200): string {
  const candidates = [
    path.join(RAW_ROOT, novelName, '章节', chapterBase + '.txt'),
    path.join(RAW_ROOT, novelName, chapterBase + '.txt'),
  ];
  for (const p of candidates) {
    const text = readFileSync(p);
    if (text) return text.trim().slice(0, maxChars);
  }
  return '';
}

/** 构造拆大纲提示词（模拟 batch-utils.ts 的 buildBatchPrompt，单章） */
function buildOutlinePrompt(rawText: string): string {
  const M = 1;
  const head =
    `请将以下小说章节内容按原剧情顺序拆解为8–10条高密度摘要。\n\n` +
    `【摘要要求】\n` +
    `- 每条必须包含：关键事件 + 因果关系 + 人物行为\n` +
    `- 严格按剧情推进顺序，不得跳跃或重组\n` +
    `- 不得遗漏关键信息（没有它就看不懂故事的细节）\n` +
    `- 不得加入原文不存在的内容\n` +
    `- 保持信息最大完整度\n\n` +
    `【必须捕捉的要素】\n` +
    `- 事理逻辑：事件之间的因果链条（前提→行动→结果）\n` +
    `- 情理逻辑：人物动机、心理变化、性格表现\n` +
    `- 文化逻辑：道德规则、价值判断、社会背景\n` +
    `- 冲突点：人物与人物/环境/自我的冲突\n` +
    `- 关键转折：改变故事走向的小事\n\n` +
    `我一次发给你 ${M} 个章节，请逐章处理。务必严格按下面格式输出（我要用程序自动切分，格式不对会作废重发）：\n` +
    `- 第 k 章（k 从 1 到 ${M}）开头，单独占一行只写分隔标记：=====CHAPTER-k=====（把 k 换成数字，如第1章写 =====CHAPTER-1=====）\n` +
    `- 紧接着另起一行，写该章的8–10条高密度摘要。\n` +
    `- 必须正好输出 ${M} 段，顺序与我给的一致；不要写任何前言、过渡语、总结或目录。\n\n` +
    `以下是 ${M} 个章节的正文：\n`;
  const body = `\n----- 章节1（${chapterBase}）-----\n${rawText}\n`;
  return head + body;
}

/** 构造改编大纲提示词（模拟 batch-utils.ts 的 buildBatchPrompt，单章，带 prefix） */
function buildAdaptPrompt(brokenText: string, prefix: string): string {
  const M = 1;
  const head =
    `${prefix}\n\n我一次发给你 ${M} 个章节的大纲。请按你的规则逐章处理。输出时务必严格按下面格式（我要用程序自动切分）：\n` +
    `- 第 k 章（k 从 1 到 ${M}）开头，单独占一行只写分隔标记：=====CHAPTER-k=====（把 k 换成数字，如第1章写 =====CHAPTER-1=====）\n` +
    `- 紧接着另起一行，写该章处理后的内容。\n` +
    `- 必须正好输出 ${M} 段，顺序与我给的一致。\n\n` +
    `以下是 ${M} 个章节的大纲：\n`;
  const body = `\n----- 章节1（${chapterBase}）-----\n${brokenText}\n`;
  return head + body;
}

/** 构造生成正文提示词（模拟 generate-runner.ts 的 sendSingle） */
function buildGeneratePrompt(adaptedText: string, prefix: string, rawOpening: string): string {
  return rawOpening
    ? `${prefix}\n\n【参考原文开头（基调）】\n${rawOpening}\n\n【改编大纲】\n${adaptedText}`
    : prefix
      ? `${prefix}\n\n${adaptedText}`
      : adaptedText;
}

// ============ 读取文件 ============
const rawPath = path.join(RAW_ROOT, novelName, '章节', chapterBase + '.txt');
const brokenPath = path.join(BROKEN_ROOT, novelName, chapterBase + '.md');
const adaptedPath = path.join(ADAPTED_ROOT, novelName, chapterBase + '.md');

const rawText = readFileSync(rawPath);
const brokenText = readFileSync(brokenPath);
const adaptedText = readFileSync(adaptedPath);
const adaptCfg = JSON.parse(readFileSync(ADAPT_CONFIG) || '{}');
const generateCfg = JSON.parse(readFileSync(GENERATE_CONFIG) || '{}');

console.log('─'.repeat(80));
console.log('文件检查:');
console.log(`  参考原文: ${rawText ? '✓ ' + rawText.length + ' 字' : '✗ 未找到'}`);
console.log(`  拆大纲输出: ${brokenText ? '✓ ' + brokenText.length + ' 字' : '✗ 未找到'}`);
console.log(`  改编大纲输出: ${adaptedText ? '✓ ' + adaptedText.length + ' 字' : '✗ 未找到'}`);
console.log(`  改编 promptPrefix: ${adaptCfg.promptPrefix ? '✓ ' + adaptCfg.promptPrefix.length + ' 字' : '✗ 未配置'}`);
console.log(`  生成 promptPrefix: ${generateCfg.promptPrefix ? '✓ ' + generateCfg.promptPrefix.length + ' 字' : '✗ 未配置'}`);
console.log(`  rawRoot: ${generateCfg.rawRoot ? '✓ ' + generateCfg.rawRoot : '✗ 未配置'}`);
console.log();

// ============ 构造三个阶段的提示词 ============
const rawOpening = readRawOpening(200);

const stage1Prompt = rawText ? buildOutlinePrompt(rawText) : '(缺少参考原文，无法构造)';
const stage2Prompt = brokenText ? buildAdaptPrompt(brokenText, adaptCfg.promptPrefix || '') : '(缺少拆大纲输出，无法构造)';
const stage3Prompt = adaptedText ? buildGeneratePrompt(adaptedText, generateCfg.promptPrefix || '', rawOpening) : '(缺少改编大纲输出，无法构造)';

// ============ 输出到控制台 ============
function printStage(title: string, prompt: string): void {
  console.log('═'.repeat(80));
  console.log(title);
  console.log('═'.repeat(80));
  console.log(`长度: ${prompt.length} 字符`);
  console.log('─'.repeat(80));
  console.log(prompt);
  console.log();
}

printStage('阶段1: 拆大纲 提示词', stage1Prompt);
printStage('阶段2: 改编大纲 提示词', stage2Prompt);
printStage('阶段3: 生成正文 提示词', stage3Prompt);

// ============ 保存到文件 ============
ensureDir(OUT_DIR);
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outFile = path.join(OUT_DIR, `gpts-prompt-${ts}.txt`);

let output = '';
output += '═'.repeat(80) + '\n';
output += `GPTS 提示词 Dry-Run 测试\n`;
output += `时间: ${new Date().toLocaleString('zh-CN')}\n`;
output += `小说: ${novelName}\n`;
output += `章节: ${chapterBase}\n`;
output += '═'.repeat(80) + '\n\n';

output += '═══ 阶段1: 拆大纲 ═══\n';
output += `长度: ${stage1Prompt.length} 字符\n`;
output += '─'.repeat(80) + '\n';
output += stage1Prompt + '\n\n';

output += '═══ 阶段2: 改编大纲 ═══\n';
output += `长度: ${stage2Prompt.length} 字符\n`;
output += '─'.repeat(80) + '\n';
output += stage2Prompt + '\n\n';

output += '═══ 阶段3: 生成正文 ═══\n';
output += `长度: ${stage3Prompt.length} 字符\n`;
output += `参考原文开头: ${rawOpening ? rawOpening.length + ' 字' : '未找到'}\n`;
output += '─'.repeat(80) + '\n';
output += stage3Prompt + '\n';

fs.writeFileSync(outFile, output, 'utf8');

console.log('═'.repeat(80));
console.log(`✓ 提示词已保存到: ${outFile}`);
console.log('═'.repeat(80));
console.log();
console.log('使用方法:');
console.log('  1. 打开保存的文件，复制对应阶段的提示词');
console.log('  2. 粘贴到对应的 ChatGPT GPTS 对话中');
console.log('  3. 查看 GPT 的回复，验证提示词效果');
console.log();
console.log('自定义测试章节:');
console.log('  tsx 程序/scripts/test-gpts-prompt.ts "小说目录名" "章节base名"');
