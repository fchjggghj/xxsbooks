/**
 * 批次工具函数（拆大纲 + 改编大纲共用）
 *
 * - buildBatches：构建重叠批次计划（改编大纲用）
 * - buildBatchPrompt：把 M 章拼成带分隔标记的提示
 * - splitBatch：按分隔标记把回复切成 M 段
 */
import type { OutlineItem, Batch } from '@novel-pipeline/shared';

/**
 * 构建重叠批次计划（改编大纲用）。
 *
 * 策略：
 * - 第一批：取 batchSize 章，保留前 keepCount 章
 * - 后续批次：从上一批保留的最后一章开始，取 batchSizeNext 章，保留中间 keepCount 章（跳过第一章重叠章）
 * - 只剩 1 章时作为单章批次处理
 *
 * 例如 batchSize=6, batchSizeNext=7, keepCount=5：
 *   批次1: 章1-6, 保留1-5
 *   批次2: 章5-11, 保留6-10
 *   批次3: 章10-16, 保留11-15
 *   ...
 */
export function buildBatches(
  pending: OutlineItem[],
  batchSize: number,
  batchSizeNext: number,
  keepCount: number,
): Batch[] {
  const batches: Batch[] = [];
  let i = 0;
  let isFirst = true;

  while (i < pending.length) {
    const size = isFirst ? batchSize : batchSizeNext;
    const end = Math.min(i + size, pending.length);
    const toSend = pending.slice(i, end);
    const isLastBatch = end >= pending.length; // 本批覆盖所有剩余章节，无需重叠

    // 只剩 1 章：作为单章批次
    if (toSend.length < 2) {
      batches.push({ toSend, keepIndices: toSend.map((_, idx) => idx), isSingle: true });
      break;
    }

    let keepIndices: number[];
    if (isFirst) {
      // 首批：保留前 keepCount 章（最后一批保留全部，避免末尾章节丢失）
      const keepLen = isLastBatch ? toSend.length : Math.min(keepCount, toSend.length);
      keepIndices = Array.from({ length: keepLen }, (_, j) => j);
    } else {
      // 后续批次：跳过第一章（重叠章），保留第 2 到 keepCount+1 章（最后一批保留第 2 到末尾）
      const keepLen = isLastBatch ? toSend.length - 1 : Math.min(keepCount, toSend.length - 1);
      keepIndices = Array.from({ length: keepLen }, (_, j) => j + 1);
    }

    batches.push({ toSend, keepIndices, isSingle: false });

    // 最后一批已覆盖所有剩余章节，结束循环
    if (isLastBatch) break;

    // 推进到保留的最后一章的索引，确保下一批从该章开始（重叠上下文）
    i += keepIndices[keepIndices.length - 1];
    isFirst = false;
  }

  return batches;
}

/**
 * 把 M 章拼成一个带分隔标记的提示。
 *
 * GPT 实测能按 =====CHAPTER-k===== 乖乖分段，程序据此自动切分。
 *
 * @param items   章节条目数组
 * @param reader  读取章节内容的函数（拆大纲读正文，改编读大纲）
 * @param prefix  可选前缀（改编大纲的 promptPrefix）；有前缀时用改编风格提示，无前缀时用拆大纲风格提示
 */
export function buildBatchPrompt(
  items: OutlineItem[],
  reader: (item: OutlineItem) => string,
  prefix?: string,
): string {
  const M = items.length;
  const hasPrefix = !!(prefix && prefix.trim());

  const head = hasPrefix
    ? `${prefix}\n\n我一次发给你 ${M} 个章节的大纲。请按你的规则逐章处理。输出时务必严格按下面格式（我要用程序自动切分）：\n` +
      `- 第 k 章（k 从 1 到 ${M}）开头，单独占一行只写分隔标记：=====CHAPTER-k=====（把 k 换成数字，如第1章写 =====CHAPTER-1=====）\n` +
      `- 紧接着另起一行，写该章处理后的内容。\n` +
      `- 必须正好输出 ${M} 段，顺序与我给的一致。\n\n` +
      `以下是 ${M} 个章节的大纲：\n`
    : `请将以下小说章节内容按原剧情顺序拆解为8–10条高密度摘要。\n\n` +
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

  let body = '';
  items.forEach((c, i) => {
    body += `\n----- 章节${i + 1}（${c.base}）-----\n${reader(c)}\n`;
  });

  return head + body;
}

/**
 * 按分隔标记把回复切成 M 段。
 *
 * 标记格式：=====CHAPTER-k=====（k 为数字，允许空格/横线变体）
 *
 * @param text  GPT 回复文本
 * @param M     期望的段数
 * @returns     切分后的 M 段文本（已 trim）；标记数 ≠ M 时返回 null（宁可整批作废重发，绝不写错位）
 */
export function splitBatch(text: string, M: number): string[] | null {
  const re = /=====\s*CHAPTER[-\s]*\d+\s*=====/gi;
  const pos: { at: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  const src = text || '';
  while ((m = re.exec(src))) {
    pos.push({ at: m.index, end: re.lastIndex });
  }
  if (pos.length !== M) return null;

  const segs: string[] = [];
  for (let i = 0; i < M; i++) {
    const s = pos[i].end;
    const e = i + 1 < M ? pos[i + 1].at : src.length;
    segs.push(src.slice(s, e).trim());
  }
  return segs;
}
