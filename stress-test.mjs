// 压力测试：模拟 1000 万字项目（~3333 章）
// 生成虚拟文件结构 + 大 state.json，测试 control.mjs status / local-ui listBooks 性能
// 用法：node stress-test.mjs
// 测试结束后自动清理临时目录

import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const testRoot = path.join(projectRoot, 'stress-test-data');

// 测试规模：1000 万字 ≈ 3333 章
const BOOK_COUNT = 17;
const VOLUMES_PER_BOOK = 4;
const CHAPTERS_PER_VOLUME = 50;
const TOTAL_CHAPTERS = BOOK_COUNT * VOLUMES_PER_BOOK * CHAPTERS_PER_VOLUME; // 3400

const chineseNumerals = ['一','二','三','四','五','六','七','八','九','十','十一','十二','十三','十四','十五','十六','十七'];

function pad4(n) { return String(n).padStart(4, '0'); }

async function timeit(label, fn) {
  const start = performance.now();
  const result = await fn();
  const elapsed = (performance.now() - start).toFixed(0);
  console.log(`  ${label}: ${elapsed}ms`);
  return { result, elapsed };
}

async function generateTestFiles() {
  console.log(`\n[1/4] 生成 ${TOTAL_CHAPTERS} 个章节文件（${BOOK_COUNT} 本书 × ${VOLUMES_PER_BOOK} 卷 × ${CHAPTERS_PER_VOLUME} 章）...`);
  const start = performance.now();

  // 清理旧数据
  await fs.rm(testRoot, { force: true, recursive: true });
  await fs.mkdir(testRoot, { recursive: true });

  let fileCount = 0;
  for (let b = 0; b < BOOK_COUNT; b++) {
    const bookName = `测试书${chineseNumerals[b] || b}`;
    for (let v = 0; v < VOLUMES_PER_BOOK; v++) {
      const volName = `第${chineseNumerals[v] || v}卷`;
      const volDir = path.join(testRoot, bookName, volName);
      // 原文/拆分/正文 三个子目录
      for (const sub of ['原文', '拆分', '正文']) {
        await fs.mkdir(path.join(volDir, sub), { recursive: true });
      }
      // 原文：全部 50 章
      for (let c = 0; c < CHAPTERS_PER_VOLUME; c++) {
        const chNum = b * VOLUMES_PER_BOOK * CHAPTERS_PER_VOLUME + v * CHAPTERS_PER_VOLUME + c + 1;
        await fs.writeFile(path.join(volDir, '原文', `${pad4(chNum)}.txt`), `第${chNum}章 测试内容\n`);
        fileCount++;
      }
      // 拆分：模拟 80% 完成
      const chaiDone = Math.floor(CHAPTERS_PER_VOLUME * 0.8);
      for (let c = 0; c < chaiDone; c++) {
        const chNum = b * VOLUMES_PER_BOOK * CHAPTERS_PER_VOLUME + v * CHAPTERS_PER_VOLUME + c + 1;
        await fs.writeFile(path.join(volDir, '拆分', `${pad4(chNum)}.md`), `# 第${chNum}章\n拆文结果\n`);
        fileCount++;
      }
      // 正文：模拟 50% 完成
      const xieDone = Math.floor(CHAPTERS_PER_VOLUME * 0.5);
      for (let c = 0; c < xieDone; c++) {
        const chNum = b * VOLUMES_PER_BOOK * CHAPTERS_PER_VOLUME + v * CHAPTERS_PER_VOLUME + c + 1;
        await fs.writeFile(path.join(volDir, '正文', `${pad4(chNum)}.md`), `# 第${chNum}章\n正文内容\n`);
        fileCount++;
      }
    }
  }
  const elapsed = (performance.now() - start).toFixed(0);
  console.log(`  生成 ${fileCount} 个文件，耗时 ${elapsed}ms`);
  return fileCount;
}

async function generateStateJson() {
  console.log(`\n[2/4] 生成大 state.json（${TOTAL_CHAPTERS} 个任务记录）...`);
  const start = performance.now();

  const stateDir = path.join(testRoot, '.state');
  for (const sub of ['chai', 'xie']) {
    await fs.mkdir(path.join(stateDir, sub), { recursive: true });
  }

  // chai state：80% done, 20% pending
  const chaiState = { novelConversations: {}, tasks: {} };
  for (let b = 0; b < BOOK_COUNT; b++) {
    const bookName = `测试书${chineseNumerals[b] || b}`;
    for (let v = 0; v < VOLUMES_PER_BOOK; v++) {
      const volName = `第${chineseNumerals[v] || v}卷`;
      const novelKey = `${bookName}/${volName}`;
      chaiState.novelConversations[novelKey] = `https://chatgpt.com/c/test-${b}-${v}`;
      for (let c = 0; c < CHAPTERS_PER_VOLUME; c++) {
        const chNum = b * VOLUMES_PER_BOOK * CHAPTERS_PER_VOLUME + v * CHAPTERS_PER_VOLUME + c + 1;
        const taskId = `${bookName}/${volName}/${pad4(chNum)}.txt`;
        const isDone = c < Math.floor(CHAPTERS_PER_VOLUME * 0.8);
        chaiState.tasks[taskId] = {
          status: isDone ? 'done' : 'pending',
          attempts: isDone ? 1 : 0,
          conversationUrl: isDone ? `https://chatgpt.com/c/test-${b}-${v}` : '',
          startedAt: isDone ? '2026-07-10T10:00:00Z' : '',
          completedAt: isDone ? '2026-07-10T10:05:00Z' : '',
          outputPath: isDone ? `书籍/${bookName}/${volName}/拆分/${pad4(chNum)}.md` : '',
        };
      }
    }
  }
  const chaiJson = JSON.stringify(chaiState, null, 2);
  await fs.writeFile(path.join(stateDir, 'chai', 'state.json'), chaiJson);
  console.log(`  chai state.json: ${(Buffer.byteLength(chaiJson) / 1024).toFixed(1)} KB, ${Object.keys(chaiState.tasks).length} tasks`);

  // xie state：50% done
  const xieState = { novelConversations: {}, tasks: {} };
  for (let b = 0; b < BOOK_COUNT; b++) {
    const bookName = `测试书${chineseNumerals[b] || b}`;
    for (let v = 0; v < VOLUMES_PER_BOOK; v++) {
      const volName = `第${chineseNumerals[v] || v}卷`;
      const novelKey = `${bookName}/${volName}`;
      xieState.novelConversations[novelKey] = `https://chatgpt.com/c/test-xie-${b}-${v}`;
      for (let c = 0; c < CHAPTERS_PER_VOLUME; c++) {
        const chNum = b * VOLUMES_PER_BOOK * CHAPTERS_PER_VOLUME + v * CHAPTERS_PER_VOLUME + c + 1;
        const taskId = `${bookName}/${volName}/${pad4(chNum)}.md`;
        const isDone = c < Math.floor(CHAPTERS_PER_VOLUME * 0.5);
        xieState.tasks[taskId] = {
          status: isDone ? 'done' : 'pending',
          attempts: isDone ? 1 : 0,
          conversationUrl: isDone ? `https://chatgpt.com/c/test-xie-${b}-${v}` : '',
          startedAt: isDone ? '2026-07-10T12:00:00Z' : '',
          completedAt: isDone ? '2026-07-10T12:05:00Z' : '',
          outputPath: isDone ? `书籍/${bookName}/${volName}/正文/${pad4(chNum)}.md` : '',
        };
      }
    }
  }
  const xieJson = JSON.stringify(xieState, null, 2);
  await fs.writeFile(path.join(stateDir, 'xie', 'state.json'), xieJson);
  console.log(`  xie state.json: ${(Buffer.byteLength(xieJson) / 1024).toFixed(1)} KB, ${Object.keys(xieState.tasks).length} tasks`);

  const elapsed = (performance.now() - start).toFixed(0);
  console.log(`  耗时 ${elapsed}ms`);
}

async function createTestConfig() {
  // control.mjs 固定读项目根的 config-chai.json / config-xie.json
  // 需要备份真实配置，替换为指向测试目录的临时配置
  const realChai = path.join(projectRoot, 'config-chai.json');
  const realXie = path.join(projectRoot, 'config-xie.json');
  const backupChai = path.join(testRoot, 'backup-config-chai.json');
  const backupXie = path.join(testRoot, 'backup-config-xie.json');

  // 备份
  await fs.copyFile(realChai, backupChai);
  await fs.copyFile(realXie, backupXie);

  // 写入测试配置到项目根（control.mjs 读取的位置）
  const chaiConfig = {
    cdpUrl: 'http://127.0.0.1:9222',
    gptUrl: 'https://chatgpt.com/g/test',
    inputDir: testRoot,
    outputDir: testRoot,
    inputSubdir: '原文',
    outputSubdir: '拆分',
    volumeMode: true,
    stateFile: path.join(testRoot, '.state', 'chai', 'state.json'),
    logFile: path.join(testRoot, '.state', 'chai', 'run.log'),
    promptTemplate: '{{content}}',
    fileExtensions: ['.txt'],
    outputExtension: '.md',
  };
  const xieConfig = {
    cdpUrl: 'http://127.0.0.1:9222',
    gptUrl: 'https://chatgpt.com/g/test',
    inputDir: testRoot,
    outputDir: testRoot,
    inputSubdir: '拆分',
    outputSubdir: '正文',
    volumeMode: true,
    stateFile: path.join(testRoot, '.state', 'xie', 'state.json'),
    logFile: path.join(testRoot, '.state', 'xie', 'run.log'),
    promptTemplate: '{{content}}',
    fileExtensions: ['.md'],
    outputExtension: '.md',
  };
  await fs.writeFile(realChai, JSON.stringify(chaiConfig, null, 2));
  await fs.writeFile(realXie, JSON.stringify(xieConfig, null, 2));
  console.log('  已备份真实配置并替换为测试配置');
}

async function restoreConfig() {
  const realChai = path.join(projectRoot, 'config-chai.json');
  const realXie = path.join(projectRoot, 'config-xie.json');
  const backupChai = path.join(testRoot, 'backup-config-chai.json');
  const backupXie = path.join(testRoot, 'backup-config-xie.json');
  try {
    await fs.copyFile(backupChai, realChai);
    await fs.copyFile(backupXie, realXie);
    console.log('  已恢复真实配置');
  } catch (error) {
    console.error('  ⚠ 恢复配置失败:', error.message);
  }
}

async function testControlStatus() {
  console.log(`\n[3/4] 测试 control.mjs status 性能（大 state.json）...`);
  try {
    const { result, elapsed } = await timeit('control.mjs status --json', async () => {
      const { stdout } = await execFileAsync(process.execPath, [
        path.join(projectRoot, 'control.mjs'), 'status', '--json'
      ], {
        cwd: projectRoot,
        timeout: 60_000,
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8',
      });
      return JSON.parse(stdout);
    });
    const stages = result.stages || {};
    for (const [name, stage] of Object.entries(stages)) {
      console.log(`    ${name}: ${stage.counts?.done || 0}/${stage.taskCount} done, ${stage.counts?.pending || 0} pending`);
    }
    return elapsed;
  } catch (error) {
    console.log(`    失败: ${error.message}`);
    return null;
  }
}

async function testListBooks() {
  console.log(`\n[4/4] 测试 listBooks 性能（遍历 ${BOOK_COUNT * VOLUMES_PER_BOOK} 个卷目录）...`);
  // 模拟 local-ui 的 listBooks 逻辑
  const start = performance.now();
  const books = [];
  const entries = await fs.readdir(testRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const bookDir = path.join(testRoot, entry.name);
    const book = { name: entry.name, volumes: [] };
    const vols = (await fs.readdir(bookDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
    for (const volName of vols) {
      const counts = { 原文: 0, 拆分: 0, 正文: 0 };
      for (const sub of Object.keys(counts)) {
        const subDir = path.join(bookDir, volName, sub);
        if (!fssync.existsSync(subDir)) continue;
        const files = (await fs.readdir(subDir, { withFileTypes: true }))
          .filter((e) => e.isFile() && ['.txt', '.md'].includes(path.extname(e.name).toLowerCase()));
        counts[sub] = files.length;
      }
      book.volumes.push({ name: volName, fileCounts: counts });
    }
    books.push(book);
  }
  const elapsed = (performance.now() - start).toFixed(0);
  console.log(`    listBooks: ${elapsed}ms, ${books.length} 本书, ${books.reduce((s, b) => s + b.volumes.length, 0)} 个卷`);
  return elapsed;
}

async function testReconcile() {
  console.log(`\n[额外] 测试 control.mjs reconcile 性能...`);
  try {
    const { result, elapsed } = await timeit('control.mjs reconcile all --json', async () => {
      const { stdout } = await execFileAsync(process.execPath, [
        path.join(projectRoot, 'control.mjs'), 'reconcile', 'all', '--json'
      ], {
        cwd: projectRoot,
        timeout: 120_000,
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8',
      });
      return JSON.parse(stdout);
    });
    const stages = result.stages || {};
    for (const [name, info] of Object.entries(stages)) {
      console.log(`    ${name}: stateExists=${info.stateExists}, changes=${info.changes?.length || 0}`);
    }
    return elapsed;
  } catch (error) {
    console.log(`    失败: ${error.message?.slice(0, 200)}`);
    return null;
  }
}

async function cleanup() {
  console.log(`\n清理临时目录 ${testRoot} ...`);
  await fs.rm(testRoot, { force: true, recursive: true });
  console.log('完成。');
}

async function main() {
  console.log('========================================');
  console.log(`压力测试：模拟 1000 万字项目`);
  console.log(`规模：${BOOK_COUNT} 本书 × ${VOLUMES_PER_BOOK} 卷 × ${CHAPTERS_PER_VOLUME} 章 = ${TOTAL_CHAPTERS} 章`);
  console.log('========================================');

  const memBefore = process.memoryUsage();
  console.log(`初始内存: RSS ${(memBefore.rss / 1024 / 1024).toFixed(1)} MB`);

  try {
    await generateTestFiles();
    await generateStateJson();
    await createTestConfig();

    const statusTime = await testControlStatus();
    const listTime = await testListBooks();
    await testReconcile();

    const memAfter = process.memoryUsage();
    console.log(`\n========================================`);
    console.log('测试结果汇总：');
    console.log(`  control.mjs status:  ${statusTime || '失败'}ms`);
    console.log(`  listBooks:           ${listTime || '失败'}ms`);
    console.log(`  峰值内存: RSS ${(memAfter.rss / 1024 / 1024).toFixed(1)} MB`);
    console.log('========================================');

    // 性能阈值检查
    const issues = [];
    if (statusTime && Number(statusTime) > 5000) issues.push('⚠ status 超过 5 秒，大项目下前端轮询会卡');
    if (listTime && Number(listTime) > 3000) issues.push('⚠ listBooks 超过 3 秒，书籍列表加载慢');
    if (memAfter.rss > 200 * 1024 * 1024) issues.push('⚠ 内存超过 200MB');

    if (issues.length) {
      console.log('\n发现潜在问题：');
      issues.forEach((i) => console.log(`  ${i}`));
    } else {
      console.log('\n✓ 所有性能指标在可接受范围内。');
    }
  } finally {
    // 必须先恢复配置，再清理临时目录（backup 在临时目录里）
    await restoreConfig();
    await cleanup();
  }
}

main().catch((error) => {
  console.error('测试失败:', error);
  process.exit(1);
});
