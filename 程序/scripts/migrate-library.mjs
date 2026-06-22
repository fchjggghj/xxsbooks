// 迁移：把旧素材库 C:\Users\Administrator\Desktop\novel_pipeline\data\00_raw_chapters 的每本小说 COPY 到 data/00_raw_chapters。
//   <本>/章节        → data/00_raw_chapters/<本>/章节        （原样）
//   <本>/改编大纲     → data/00_raw_chapters/<本>/拆大纲       （改名：这文件夹装的其实是①拆大纲产物）
// 非破坏：COPY 不删 legacy 备份。幂等：目标已存在且非空的文件跳过。跳过 .lock 残留。
// 用法：node scripts/migrate-library.mjs [--src <dir>] [--dest <dir>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function argVal(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SRC = argVal('--src', path.join(__dirname, '..', 'legacy', '快穿小说项目准备', '02_素材库'));
const DEST = argVal('--dest', path.join(__dirname, '..', '..', 'data', '00_raw_chapters')); // data 在项目顶层（../../）

// 子目录映射：源子目录名 → 目标子目录名
const SUBDIR_MAP = [
  ['章节', '章节'],
  ['改编大纲', '拆大纲'],
];

let copied = 0;
let skipped = 0;

/** 递归复制目录；跳过 .lock；目标已存在且大小一致则跳过（幂等）。 */
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) { copyDir(s, d); continue; }
    if (!ent.isFile()) continue;
    if (ent.name.toLowerCase().endsWith('.lock')) continue; // 不迁移残留锁
    try {
      const ss = fs.statSync(s);
      let needCopy = true;
      try { const ds = fs.statSync(d); if (ds.isFile() && ds.size === ss.size) needCopy = false; } catch {}
      if (needCopy) { fs.copyFileSync(s, d); copied++; } else { skipped++; }
    } catch (err) {
      console.error(`  ⚠ 复制失败 ${s}: ${err?.message || err}`);
    }
  }
}

function countByExt(dir, ext) { try { return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(ext)).length; } catch { return 0; } }

// 校验门：删 D: 前复核 data/ 是否已完整覆盖 D: 素材库（章节.txt 数、拆大纲/改编大纲.md 数逐本相等）。
function verifyMode() {
  if (!fs.existsSync(SRC)) { console.error(`源不存在: ${SRC}（可能已删）`); process.exit(1); }
  const novels = fs.readdirSync(SRC, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  let allOk = true;
  for (const name of novels) {
    const sCh = countByExt(path.join(SRC, name, '章节'), '.txt');
    const dCh = countByExt(path.join(DEST, name, '章节'), '.txt');
    const sOut = countByExt(path.join(SRC, name, '改编大纲'), '.md');
    const dOut = countByExt(path.join(DEST, name, '拆大纲'), '.md');
    const ok = sCh === dCh && sOut === dOut;
    if (!ok) allOk = false;
    console.log(`${ok ? '✓' : '✗'} ${name}  章节 ${dCh}/${sCh}  拆大纲 ${dOut}/${sOut}`);
  }
  console.log(allOk
    ? '\n✅ 全部一致，data/ 已完整覆盖 D: 素材库，可安全删除 D:。'
    : '\n❌ 有不一致，禁止删除 D:！请先排查（可重跑 node migrate-library.mjs 补齐）。');
  process.exit(allOk ? 0 : 2);
}

function main() {
  if (process.argv.includes('--verify')) return verifyMode();
  if (!fs.existsSync(SRC)) { console.error(`源不存在: ${SRC}`); process.exit(1); }
  fs.mkdirSync(DEST, { recursive: true });
  const novels = fs.readdirSync(SRC, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  console.log(`迁移 ${novels.length} 本：${SRC}\n              → ${DEST}\n`);

  for (const name of novels) {
    const srcNovel = path.join(SRC, name);
    const dstNovel = path.join(DEST, name);
    const parts = [];
    for (const [srcSub, dstSub] of SUBDIR_MAP) {
      const s = path.join(srcNovel, srcSub);
      if (!fs.existsSync(s)) continue;
      const before = copied;
      copyDir(s, path.join(dstNovel, dstSub));
      const cntTxt = fs.readdirSync(s, { withFileTypes: true }).filter((x) => x.isFile()).length;
      parts.push(`${srcSub}→${dstSub}(${cntTxt}个, 新拷${copied - before})`);
    }
    console.log(`  ✓ ${name}  ${parts.join('  ') || '(无 章节/改编大纲)'}`);
  }
  console.log(`\n完成。新复制 ${copied} 个文件，跳过(已存在) ${skipped} 个。D: 原库保留作备份，验证后可自行删除。`);
}

main();

