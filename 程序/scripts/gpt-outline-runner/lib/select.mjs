// 选择逻辑：按「在读人数」分档 + N=200 + 弧边界（不打断世界剧情）。
// 弧边界从章节文件名重建（世界名变化 / 内部编号归 1），不依赖「按故事合并」。

/** 从小说文件夹名解析在读人数；无则返回 null。 */
export function parseReaders(name) {
  let m = String(name).match(/在读[:：]\s*([\d.]+)\s*万/);
  if (m) return Math.round(parseFloat(m[1]) * 10000);
  m = String(name).match(/在读[:：]\s*(\d+)\s*人/);
  if (m) return parseInt(m[1], 10);
  return null;
}

/** 分档：big=全书拆；small=在读<阈值取前N；nodata=无在读取前N。 */
export function tierOf(readers, cfg) {
  const big = cfg?.selection?.bigThreshold ?? 50000;
  if (readers == null) return 'nodata';
  return readers >= big ? 'big' : 'small';
}

/** 从章节名提取「世界名」：去掉「第NNN章_」前缀和结尾的内部编号。 */
export function arcNameOf(chapterName) {
  let s = String(chapterName).replace(/\.[^.]+$/, '');        // 去扩展名
  s = s.replace(/^第?\s*\d+\s*章[_\s]*/, '');                  // 去「第NNN章_」
  s = s.replace(/[\s_]*[（(]\s*\d+\s*[)）]\s*$/, '');           // 去结尾「（12）」
  s = s.replace(/[\s_]*\d+\s*$/, '');                          // 去结尾纯数字
  return s.trim();
}

/** 按「世界名」把连续章节分组成弧。 */
export function groupArcs(chapters) {
  const arcs = [];
  let cur = null;
  for (const ch of chapters) {
    const a = arcNameOf(ch.base || ch.name);
    if (!cur || cur.name !== a) {
      cur = { name: a, chapters: [] };
      arcs.push(cur);
    }
    cur.chapters.push(ch);
  }
  return arcs;
}

/** 取前 N 章：roundToArc=true 时按弧边界不切断世界（永远至少含第一个弧，之后整弧整弧加，不超过 N）。 */
export function pickFirstN(chapters, N, roundToArc = true) {
  if (!(N > 0)) return [];
  if (!roundToArc) return chapters.slice(0, N);
  const arcs = groupArcs(chapters);
  const selected = [];
  for (const arc of arcs) {
    if (selected.length === 0 || selected.length + arc.chapters.length <= N) {
      selected.push(...arc.chapters);
    } else {
      break;
    }
  }
  return selected;
}

/** 对一本书应用规则，返回 { tier, selected }。 */
export function selectForNovel(novel, chapters, cfg) {
  const tier = tierOf(novel.readers, cfg);
  const roundToArc = cfg?.selection?.roundToArc ?? true;

  // 统一规则：每本只取前 firstNPerNovel 章（>0 时对所有书生效，无视分档）。
  const uniform = Number(cfg?.selection?.firstNPerNovel ?? 0);
  if (uniform > 0) {
    const selected = pickFirstN(chapters, uniform, roundToArc);
    return { tier, selected, cut: selected.length };
  }

  // 旧的分档规则（firstNPerNovel 未设或为 0 时回退）：big=全书；small/nodata=前 N。
  if (tier === 'big') return { tier, selected: chapters, cut: chapters.length };
  const N = tier === 'small'
    ? (cfg?.selection?.firstNForSmall ?? 200)
    : (cfg?.selection?.firstNForNoData ?? 200);
  const selected = pickFirstN(chapters, N, roundToArc);
  return { tier, selected, cut: selected.length };
}
