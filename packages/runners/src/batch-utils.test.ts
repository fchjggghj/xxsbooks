/**
 * batch-utils 单元测试 — 全边界覆盖
 *
 * 覆盖 buildBatches / splitBatch / buildBatchPrompt 的所有边界场景：
 * - 输入大小边界：0, 1, 2, 3, 5, 6, 7, 11, 12, 13, 14, 15, 20, 100
 * - 参数边界：keepCount=1, keepCount=max, 不同参数组合, batchSize=batchSizeNext
 * - 结构不变量：全覆盖、无重复、重叠正确、isSingle 标记、首批/后续批大小、最后一批保留全部
 * - splitBatch：M=1, M=10, 标记内嵌, 空白变体, 非顺序编号, M=0
 * - buildBatchPrompt：空前缀, 空白前缀, 单项, 特殊字符
 */
import { describe, it, expect } from 'vitest';
import { buildBatches, splitBatch, buildBatchPrompt } from '../src/batch-utils.js';
import type { OutlineItem } from '@novel-pipeline/shared';

// ---------- 测试数据工厂 ----------
function makeItem(name: string): OutlineItem {
  return {
    name,
    base: name.replace(/\.[^.]+$/, ''),
    inputPath: `/input/${name}`,
    outputPath: `/output/${name}.md`,
    novel: {
      name: 'test',
      path: '/test',
      totalChapters: 0,
      selectedChapters: 0,
      doneChapters: 0,
      failedChapters: 0,
      pendingChapters: 0,
    },
  };
}

function makeItems(n: number): OutlineItem[] {
  return Array.from({ length: n }, (_, i) =>
    makeItem(`第${String(i + 1).padStart(3, '0')}章_test.txt`),
  );
}

// ---------- 辅助验证函数 ----------
/** 收集所有批次中保留的章节名 */
function collectKept(batches: ReturnType<typeof buildBatches>): string[] {
  const kept: string[] = [];
  for (const b of batches) {
    for (const idx of b.keepIndices) {
      kept.push(b.toSend[idx].name);
    }
  }
  return kept;
}

/** 验证全覆盖 + 无重复 */
function expectFullCover(batches: ReturnType<typeof buildBatches>, items: OutlineItem[]): void {
  const kept = collectKept(batches);
  const keptSet = new Set(kept);
  expect(keptSet.size).toBe(items.length); // 无重复
  for (const item of items) {
    expect(keptSet.has(item.name)).toBe(true); // 全覆盖
  }
}

// ============================================================
// buildBatches — 输入大小边界
// ============================================================
describe('buildBatches · 输入大小边界', () => {
  const BS = 6,
    BSN = 7,
    KC = 5; // 默认参数

  it('0 章 → 空数组', () => {
    expect(buildBatches([], BS, BSN, KC)).toEqual([]);
  });

  it('1 章 → 单章批次', () => {
    const items = makeItems(1);
    const batches = buildBatches(items, BS, BSN, KC);
    expect(batches).toHaveLength(1);
    expect(batches[0].isSingle).toBe(true);
    expect(batches[0].toSend).toHaveLength(1);
    expect(batches[0].keepIndices).toEqual([0]);
  });

  it('2 章 → 首批=最后一批，全部保留', () => {
    const items = makeItems(2);
    const batches = buildBatches(items, BS, BSN, KC);
    expect(batches).toHaveLength(1);
    expect(batches[0].isSingle).toBe(false);
    expect(batches[0].toSend).toHaveLength(2);
    expect(batches[0].keepIndices).toEqual([0, 1]); // 最后一批保留全部
  });

  it('3 章（< batchSize）→ 首批=最后一批，全部保留', () => {
    const items = makeItems(3);
    const batches = buildBatches(items, BS, BSN, KC);
    expect(batches).toHaveLength(1);
    expect(batches[0].toSend).toHaveLength(3);
    expect(batches[0].keepIndices).toEqual([0, 1, 2]); // 全部保留
  });

  it('5 章（= keepCount）→ 首批=最后一批，全部保留', () => {
    const items = makeItems(5);
    const batches = buildBatches(items, BS, BSN, KC);
    expect(batches).toHaveLength(1);
    expect(batches[0].toSend).toHaveLength(5);
    expect(batches[0].keepIndices).toEqual([0, 1, 2, 3, 4]);
  });

  it('6 章（= batchSize）→ 首批=最后一批，全部保留', () => {
    const items = makeItems(6);
    const batches = buildBatches(items, BS, BSN, KC);
    expect(batches).toHaveLength(1);
    expect(batches[0].toSend).toHaveLength(6);
    expect(batches[0].keepIndices).toEqual([0, 1, 2, 3, 4, 5]); // 全部保留，不丢弃末尾
  });

  it('7 章（刚超过 batchSize）→ 2 批，第二批从重叠章开始', () => {
    const items = makeItems(7);
    const batches = buildBatches(items, BS, BSN, KC);
    expect(batches).toHaveLength(2);

    // 批次1: 发1-6, 保留1-5
    expect(batches[0].toSend).toHaveLength(6);
    expect(batches[0].keepIndices).toEqual([0, 1, 2, 3, 4]);

    // 批次2: 从章5（重叠）开始，发5-7（3章=最后一批），保留6-7
    expect(batches[1].toSend).toHaveLength(3);
    expect(batches[1].toSend[0]).toBe(items[4]); // 第5章（重叠）
    expect(batches[1].toSend[2]).toBe(items[6]); // 第7章
    expect(batches[1].keepIndices).toEqual([1, 2]); // 保留6-7（最后一批保留剩余全部）

    expectFullCover(batches, items);
  });

  it('11 章 → 2 批完整 + 最后一批保留全部', () => {
    const items = makeItems(11);
    const batches = buildBatches(items, BS, BSN, KC);
    expect(batches).toHaveLength(2);

    // 批次1: 发1-6, 保留1-5
    expect(batches[0].toSend).toHaveLength(6);
    expect(batches[0].keepIndices).toEqual([0, 1, 2, 3, 4]);

    // 批次2: 从章5（重叠），发5-11（7章=最后一批），保留6-11
    expect(batches[1].toSend).toHaveLength(7);
    expect(batches[1].toSend[0]).toBe(items[4]); // 第5章
    expect(batches[1].toSend[6]).toBe(items[10]); // 第11章
    expect(batches[1].keepIndices).toEqual([1, 2, 3, 4, 5, 6]); // 保留6-11（全部）

    expectFullCover(batches, items);
  });

  it('12 章 → 2 批 + 单章兜底', () => {
    const items = makeItems(12);
    const batches = buildBatches(items, BS, BSN, KC);
    expect(batches).toHaveLength(3);

    // 批次1: 发1-6, 保留1-5
    expect(batches[0].toSend).toHaveLength(6);
    expect(batches[0].keepIndices).toEqual([0, 1, 2, 3, 4]);

    // 批次2: 发5-11, 保留6-10
    expect(batches[1].toSend).toHaveLength(7);
    expect(batches[1].keepIndices).toEqual([1, 2, 3, 4, 5]);

    // 批次3: 从章10（重叠），只剩章10和11... 实际只剩2章
    // i=9, size=7, end=12, toSend=[9..11]（3章）, isLastBatch=true
    // keepLen=3-1=2, keepIndices=[1,2] → 保留章11,12
    expect(batches[2].toSend.length).toBeGreaterThanOrEqual(2);
    expect(batches[2].isSingle).toBe(false);

    expectFullCover(batches, items);
  });

  it('13 章 → 3 批', () => {
    const items = makeItems(13);
    const batches = buildBatches(items, BS, BSN, KC);
    expect(batches).toHaveLength(3);
    expectFullCover(batches, items);
  });

  it('14 章 → 3 批，最后一批 5 章', () => {
    const items = makeItems(14);
    const batches = buildBatches(items, BS, BSN, KC);
    expect(batches).toHaveLength(3);

    // 批次1: 发1-6, 保留1-5 → i=4
    // 批次2: 发5-11, 保留6-10 → i=9
    // 批次3: 发10-14（5章=最后一批）, 保留11-14
    expect(batches[2].toSend).toHaveLength(5);
    expect(batches[2].toSend[0]).toBe(items[9]); // 第10章（重叠）
    expect(batches[2].toSend[4]).toBe(items[13]); // 第14章
    expect(batches[2].keepIndices).toEqual([1, 2, 3, 4]); // 保留11-14

    expectFullCover(batches, items);
  });

  it('15 章 → 3 批（修复后边界验证）', () => {
    const items = makeItems(15);
    const batches = buildBatches(items, BS, BSN, KC);
    expect(batches).toHaveLength(3);

    // 批次1: 发1-6, 保留1-5
    expect(batches[0].toSend).toHaveLength(6);
    expect(batches[0].keepIndices).toEqual([0, 1, 2, 3, 4]);

    // 批次2: 发5-11, 保留6-10
    expect(batches[1].toSend).toHaveLength(7);
    expect(batches[1].toSend[0]).toBe(items[4]);
    expect(batches[1].toSend[6]).toBe(items[10]);
    expect(batches[1].keepIndices).toEqual([1, 2, 3, 4, 5]);

    // 批次3: 发10-15（6章=最后一批）, 保留11-15
    expect(batches[2].toSend).toHaveLength(6);
    expect(batches[2].toSend[0]).toBe(items[9]);
    expect(batches[2].toSend[5]).toBe(items[14]);
    expect(batches[2].keepIndices).toEqual([1, 2, 3, 4, 5]);

    expectFullCover(batches, items);
  });

  it('20 章 → 4 批（C1 bug 回归测试）', () => {
    const items = makeItems(20);
    const batches = buildBatches(items, BS, BSN, KC);
    expect(batches).toHaveLength(4);

    // 批次1: 发1-6, 保留1-5
    expect(batches[0].toSend).toHaveLength(6);
    expect(batches[0].keepIndices).toEqual([0, 1, 2, 3, 4]);

    // 批次2: 发5-11, 保留6-10
    expect(batches[1].toSend).toHaveLength(7);
    expect(batches[1].toSend[0]).toBe(items[4]);
    expect(batches[1].toSend[6]).toBe(items[10]);
    expect(batches[1].keepIndices).toEqual([1, 2, 3, 4, 5]);

    // 批次3: 发10-16, 保留11-15
    expect(batches[2].toSend).toHaveLength(7);
    expect(batches[2].toSend[0]).toBe(items[9]);
    expect(batches[2].toSend[6]).toBe(items[15]);
    expect(batches[2].keepIndices).toEqual([1, 2, 3, 4, 5]);

    // 批次4: 发15-20（6章=最后一批）, 保留16-20
    expect(batches[3].toSend).toHaveLength(6);
    expect(batches[3].toSend[0]).toBe(items[14]);
    expect(batches[3].toSend[5]).toBe(items[19]);
    expect(batches[3].keepIndices).toEqual([1, 2, 3, 4, 5]);

    expectFullCover(batches, items);
  });

  it('100 章 → 大规模正确性', () => {
    const items = makeItems(100);
    const batches = buildBatches(items, BS, BSN, KC);
    expect(batches.length).toBeGreaterThan(10);
    expectFullCover(batches, items);

    // 首批用 batchSize
    expect(batches[0].toSend).toHaveLength(6);
    // 后续批用 batchSizeNext（非最后一批）
    for (let i = 1; i < batches.length - 1; i++) {
      expect(batches[i].toSend).toHaveLength(7);
    }
  });
});

// ============================================================
// buildBatches — 参数边界
// ============================================================
describe('buildBatches · 参数边界', () => {
  it('keepCount=1（最小保留）', () => {
    const items = makeItems(10);
    const batches = buildBatches(items, 3, 4, 1);
    expect(batches.length).toBeGreaterThanOrEqual(3);
    expectFullCover(batches, items);

    // 首批保留 1 章
    expect(batches[0].keepIndices).toEqual([0]);
    // 后续批保留 1 章（跳过重叠章）
    for (let i = 1; i < batches.length - 1; i++) {
      expect(batches[i].keepIndices).toEqual([1]);
    }
  });

  it('keepCount = batchSize - 1（最大有效保留）', () => {
    const items = makeItems(15);
    const batches = buildBatches(items, 4, 5, 3); // keepCount=3=batchSize-1
    expectFullCover(batches, items);

    // 首批保留 3 章（= batchSize - 1）
    expect(batches[0].keepIndices).toEqual([0, 1, 2]);
  });

  it('不同参数组合 (3, 4, 2)', () => {
    const items = makeItems(10);
    const batches = buildBatches(items, 3, 4, 2);
    expectFullCover(batches, items);

    // 批次1: 发1-3, 保留1-2
    expect(batches[0].toSend).toHaveLength(3);
    expect(batches[0].keepIndices).toEqual([0, 1]);

    // 批次2: 从章2（重叠）, 发2-5, 保留3-4
    expect(batches[1].toSend).toHaveLength(4);
    expect(batches[1].toSend[0]).toBe(items[1]); // 第2章（重叠）
    expect(batches[1].keepIndices).toEqual([1, 2]);
  });

  it('batchSize = batchSizeNext（首尾批大小相同）', () => {
    const items = makeItems(15);
    const batches = buildBatches(items, 5, 5, 3);
    expectFullCover(batches, items);

    // 所有非最后一批的大小都是 5
    for (let i = 0; i < batches.length - 1; i++) {
      expect(batches[i].toSend).toHaveLength(5);
    }
  });

  it('最小参数 (2, 3, 1)', () => {
    const items = makeItems(8);
    const batches = buildBatches(items, 2, 3, 1);
    expectFullCover(batches, items);

    // 批次1: 发1-2, 保留1
    expect(batches[0].toSend).toHaveLength(2);
    expect(batches[0].keepIndices).toEqual([0]);

    // 批次2: 从章1（重叠）, 发1-3, 保留2
    expect(batches[1].toSend).toHaveLength(3);
    expect(batches[1].toSend[0]).toBe(items[0]);
    expect(batches[1].keepIndices).toEqual([1]);
  });

  it('batchSizeNext = keepCount + 1（最小重叠=1章）', () => {
    const items = makeItems(12);
    const batches = buildBatches(items, 3, 4, 3); // 重叠 = batchSizeNext - keepCount = 1
    expectFullCover(batches, items);

    // 后续批发 4 章，保留 3 章，重叠 1 章
    for (let i = 1; i < batches.length - 1; i++) {
      expect(batches[i].toSend).toHaveLength(4);
      expect(batches[i].keepIndices).toEqual([1, 2, 3]);
    }
  });
});

// ============================================================
// buildBatches — 结构不变量
// ============================================================
describe('buildBatches · 结构不变量', () => {
  const BS = 6,
    BSN = 7,
    KC = 5;

  it('所有章节被保留且仅保留一次（无遗漏无重复）', () => {
    for (const n of [0, 1, 2, 3, 5, 6, 7, 10, 11, 12, 13, 14, 15, 20, 50, 100]) {
      const items = makeItems(n);
      const batches = buildBatches(items, BS, BSN, KC);
      const kept = collectKept(batches);
      const keptSet = new Set(kept);
      // 无重复：kept 数组长度 === Set 大小
      expect(kept.length).toBe(keptSet.size);
      // 全覆盖：Set 大小 === 总章节数
      expect(keptSet.size).toBe(n);
    }
  });

  it('isSingle 仅在单章批次时为 true', () => {
    for (const n of [1, 2, 5, 6, 7, 15, 20]) {
      const items = makeItems(n);
      const batches = buildBatches(items, BS, BSN, KC);
      for (const b of batches) {
        if (b.isSingle) {
          expect(b.toSend).toHaveLength(1);
        } else {
          expect(b.toSend.length).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  it('首批使用 batchSize，后续批使用 batchSizeNext', () => {
    const items = makeItems(30);
    const batches = buildBatches(items, BS, BSN, KC);

    // 首批大小 = batchSize（或全部，如果 < batchSize）
    expect(batches[0].toSend).toHaveLength(BS);

    // 中间批大小 = batchSizeNext
    for (let i = 1; i < batches.length - 1; i++) {
      expect(batches[i].toSend).toHaveLength(BSN);
    }
    // 最后一批大小 <= batchSizeNext
    expect(batches[batches.length - 1].toSend.length).toBeLessThanOrEqual(BSN);
  });

  it('重叠章 = 上一批保留的最后一章', () => {
    const items = makeItems(20);
    const batches = buildBatches(items, BS, BSN, KC);

    for (let i = 1; i < batches.length; i++) {
      const prevLastKept = batches[i - 1].toSend[batches[i - 1].keepIndices.at(-1)!];
      const currFirst = batches[i].toSend[0];
      expect(currFirst).toBe(prevLastKept);
    }
  });

  it('最后一批保留所有剩余章节（无丢弃）', () => {
    for (const n of [7, 10, 11, 12, 13, 14, 15, 20, 30]) {
      const items = makeItems(n);
      const batches = buildBatches(items, BS, BSN, KC);
      const last = batches[batches.length - 1];

      // 最后一批不应是单章（除非总共只剩 1 章）
      if (n > 1) {
        expect(last.isSingle).toBe(false);
      }

      // 最后一批的 keepIndices 应覆盖 toSend 的所有章（首批）或跳过第一章（后续批）
      if (batches.length === 1) {
        // 只有一批：保留全部
        expect(last.keepIndices.length).toBe(last.toSend.length);
      } else {
        // 多批：最后一批跳过重叠章，保留其余全部
        expect(last.keepIndices.length).toBe(last.toSend.length - 1);
        expect(last.keepIndices[0]).toBe(1); // 跳过第 0 章（重叠）
        expect(last.keepIndices.at(-1)).toBe(last.toSend.length - 1); // 保留到末尾
      }
    }
  });

  it('keepIndices 始终升序且在 toSend 范围内', () => {
    for (const n of [1, 2, 5, 6, 7, 15, 20, 50]) {
      const items = makeItems(n);
      const batches = buildBatches(items, BS, BSN, KC);
      for (const b of batches) {
        for (let i = 0; i < b.keepIndices.length; i++) {
          expect(b.keepIndices[i]).toBeGreaterThanOrEqual(0);
          expect(b.keepIndices[i]).toBeLessThan(b.toSend.length);
          if (i > 0) {
            expect(b.keepIndices[i]).toBeGreaterThan(b.keepIndices[i - 1]); // 严格升序
          }
        }
      }
    }
  });
});

// ============================================================
// splitBatch — 边界
// ============================================================
describe('splitBatch · 边界', () => {
  it('M=1（单段）', () => {
    const text = '=====CHAPTER-1=====\n唯一一段内容';
    expect(splitBatch(text, 1)).toEqual(['唯一一段内容']);
  });

  it('M=10（多段）', () => {
    const parts: string[] = [];
    for (let i = 1; i <= 10; i++) {
      parts.push(`=====CHAPTER-${i}=====`);
      parts.push(`第${i}段内容`);
    }
    const segs = splitBatch(parts.join('\n'), 10);
    expect(segs).not.toBeNull();
    expect(segs).toHaveLength(10);
    expect(segs![0]).toBe('第1段内容');
    expect(segs![9]).toBe('第10段内容');
  });

  it('标记数不匹配返回 null（少了）', () => {
    const text = '=====CHAPTER-1=====\n内容1\n=====CHAPTER-2=====\n内容2';
    expect(splitBatch(text, 3)).toBeNull();
  });

  it('标记数不匹配返回 null（多了）', () => {
    const text = '=====CHAPTER-1=====\nA\n=====CHAPTER-2=====\nB\n=====CHAPTER-3=====\nC';
    expect(splitBatch(text, 2)).toBeNull();
  });

  it('无标记返回 null', () => {
    expect(splitBatch('普通文本无标记', 1)).toBeNull();
  });

  it('空文本返回 null', () => {
    expect(splitBatch('', 1)).toBeNull();
  });

  it('M=0 返回空数组（0 个标记 = 0 段）', () => {
    // pos.length(0) === M(0) → 进入切分循环但循环不执行 → 返回 []
    expect(splitBatch('无标记文本', 0)).toEqual([]);
  });

  it('内容中包含类似标记的文本不被误匹配', () => {
    // 内容里有 CHAPTER 字样但不符合 =====CHAPTER-k===== 格式
    const text = '=====CHAPTER-1=====\n我说了CHAPTER但不是标记\n=====CHAPTER-2=====\n第二段';
    const segs = splitBatch(text, 2);
    expect(segs).toEqual(['我说了CHAPTER但不是标记', '第二段']);
  });

  it('标记前后有额外空白', () => {
    const text = '  =====CHAPTER-1=====  \n第一段\n\n  =====CHAPTER-2=====  \n第二段';
    const segs = splitBatch(text, 2);
    expect(segs).toEqual(['第一段', '第二段']);
  });

  it('非顺序编号仍正确切分', () => {
    const text = '=====CHAPTER-5=====\nA\n=====CHAPTER-12=====\nB';
    const segs = splitBatch(text, 2);
    expect(segs).toEqual(['A', 'B']);
  });

  it('支持横线变体（CHAPTER-1 / CHAPTER 1）', () => {
    const text = '=====CHAPTER-1=====\nA\n=====CHAPTER-2=====\nB';
    expect(splitBatch(text, 2)).toEqual(['A', 'B']);
  });

  it('支持空格变体（===== CHAPTER 1 =====）', () => {
    const text = '===== CHAPTER 1 =====\nA\n===== CHAPTER 2 =====\nB';
    expect(splitBatch(text, 2)).toEqual(['A', 'B']);
  });

  it('内容为空字符串的段被 trim 为空字符串', () => {
    const text = '=====CHAPTER-1=====\n\n=====CHAPTER-2=====\n有内容';
    const segs = splitBatch(text, 2);
    expect(segs).toEqual(['', '有内容']);
  });

  it('最后一段内容到文本末尾（含换行）', () => {
    const text = '=====CHAPTER-1=====\nA\n=====CHAPTER-2=====\nB\n\n\n';
    const segs = splitBatch(text, 2);
    expect(segs![1]).toBe('B'); // trim 掉末尾换行
  });

  it('大小写不敏感（chapter / Chapter / CHAPTER）', () => {
    const text = '=====chapter-1=====\nA\n=====Chapter-2=====\nB';
    const segs = splitBatch(text, 2);
    expect(segs).toEqual(['A', 'B']);
  });
});

// ============================================================
// buildBatchPrompt — 边界
// ============================================================
describe('buildBatchPrompt · 边界', () => {
  it('无前缀时使用拆大纲风格', () => {
    const items = makeItems(2);
    const prompt = buildBatchPrompt(items, () => '章节内容');
    expect(prompt).toContain('2 个章节');
    expect(prompt).toContain('=====CHAPTER-k=====');
    expect(prompt).toContain('章节1');
    expect(prompt).toContain('章节2');
    expect(prompt).toContain('正文'); // 拆大纲风格
  });

  it('有前缀时使用改编风格', () => {
    const items = makeItems(2);
    const prompt = buildBatchPrompt(items, () => '大纲内容', '按照GPTS规则改编');
    expect(prompt).toContain('按照GPTS规则改编');
    expect(prompt).toContain('2 个章节的大纲');
    expect(prompt).toContain('=====CHAPTER-k=====');
  });

  it('空前缀字符串等同于无前缀', () => {
    const items = makeItems(2);
    const prompt = buildBatchPrompt(items, () => '内容', '');
    expect(prompt).toContain('2 个章节');
    expect(prompt).toContain('正文'); // 拆大纲风格
    expect(prompt).not.toContain('章节的大纲'); // 改编风格特有
    expect(prompt).not.toContain('按照GPTS规则改编');
  });

  it('纯空白前缀等同于无前缀', () => {
    const items = makeItems(2);
    const prompt = buildBatchPrompt(items, () => '内容', '   \n\t  ');
    expect(prompt).toContain('正文');
    expect(prompt).not.toContain('章节的大纲');
    expect(prompt).not.toContain('按照GPTS规则改编');
  });

  it('单项时正确生成提示', () => {
    const items = makeItems(1);
    const prompt = buildBatchPrompt(items, () => '单章内容');
    expect(prompt).toContain('1 个章节');
    expect(prompt).toContain('章节1');
    expect(prompt).toContain('单章内容');
  });

  it('reader 函数对每个 item 被调用', () => {
    const items = makeItems(3);
    const called: string[] = [];
    buildBatchPrompt(items, (item) => {
      called.push(item.name);
      return '内容';
    });
    expect(called).toEqual([items[0].name, items[1].name, items[2].name]);
  });

  it('使用 item.base 作为章节标题', () => {
    const items = [makeItem('第001章_特殊名.txt')];
    const prompt = buildBatchPrompt(items, () => '内容');
    expect(prompt).toContain('第001章_特殊名'); // base = 去掉扩展名
  });

  it('大数量章节（10章）', () => {
    const items = makeItems(10);
    const prompt = buildBatchPrompt(items, () => '内容');
    expect(prompt).toContain('10 个章节');
    expect(prompt).toContain('章节1');
    expect(prompt).toContain('章节10');
    // 确保所有章节都在 prompt 中
    for (let i = 1; i <= 10; i++) {
      expect(prompt).toContain(`章节${i}`);
    }
  });
});
