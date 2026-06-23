import * as fs from 'node:fs';
import * as path from 'node:path';

const PROJECT_ROOT = path.resolve(__dirname, '..');

const BOOKS_DIR = path.join(PROJECT_ROOT, 'data', '00_raw_chapters');
const DIRECTIONS_DIR = path.join(PROJECT_ROOT, 'data', '01_5_directions');
const POOL_DIR = path.join(PROJECT_ROOT, 'data', '02_5_pool');
const COMPOSED_DIR = path.join(PROJECT_ROOT, 'data', '03_composed');

const GENRES = ['古代言情', '现代都市', '玄幻奇幻', '科幻末世', '悬疑惊悚', '穿越重生'];

const DIRECTION_TEMPLATES: Record<string, any> = {
  '古代言情': { coreConflict: '家族恩怨与皇权斗争交织', tone: '深情虐恋，权谋博弈', readerTarget: '喜欢古代言情的女性读者', theme: '真爱与权力的博弈' },
  '现代都市': { coreConflict: '职场竞争与情感纠葛', tone: '现实励志，都市情感', readerTarget: '关注职场的年轻读者', theme: '梦想与现实的平衡' },
  '玄幻奇幻': { coreConflict: '正邪势力对抗', tone: '热血激昂，奇幻冒险', readerTarget: '喜欢玄幻的年轻读者', theme: '勇气与成长' },
  '科幻末世': { coreConflict: '末世生存危机', tone: '紧张刺激，末世求生', readerTarget: '喜欢科幻的读者', theme: '人性与生存' },
  '悬疑惊悚': { coreConflict: '连环谜案背后隐藏秘密', tone: '悬疑紧张，烧脑推理', readerTarget: '喜欢悬疑推理的读者', theme: '真相与谎言' },
  '穿越重生': { coreConflict: '重生归来改写命运', tone: '爽文逆袭，重生复仇', readerTarget: '喜欢重生流的读者', theme: '命运与选择' },
};

const PROTAGONIST_TEMPLATES: Record<string, any> = {
  '古代言情': { name: '苏婉清', personality: '温婉聪慧', motivation: '守护家族', arc: '从闺阁少女到女主人' },
  '现代都市': { name: '林晓', personality: '独立坚强', motivation: '实现理想', arc: '从职场小白到精英' },
  '玄幻奇幻': { name: '叶辰', personality: '坚毅果敢', motivation: '复仇雪恨', arc: '从废柴到天骄' },
  '科幻末世': { name: '陈峰', personality: '冷静理智', motivation: '保护幸存者', arc: '从青年到领袖' },
  '悬疑惊悚': { name: '秦明', personality: '敏锐细致', motivation: '揭开真相', arc: '从警员到专家' },
  '穿越重生': { name: '沈若曦', personality: '冷静睿智', motivation: '改变命运', arc: '从懦弱到强者' },
};

function getRandomGenre(): string {
  return GENRES[Math.floor(Math.random() * GENRES.length)];
}

function createMockDirections() {
  console.log('=== 创建改编方向数据 ===');
  
  const books = fs.readdirSync(BOOKS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
  
  for (const bookName of books.slice(0, 3)) {
    const bookId = bookName.match(/^(\d{4})/)?.[1] || bookName.slice(0, 4);
    const bookDir = path.join(DIRECTIONS_DIR, bookName);
    
    if (!fs.existsSync(bookDir)) {
      fs.mkdirSync(bookDir, { recursive: true });
    }
    
    const worldNames = ['奸臣', '末世', '戏子', '道士', '孤王'];
    
    worldNames.forEach((worldName, index) => {
      const genre = getRandomGenre();
      const template = DIRECTION_TEMPLATES[genre];
      const protagonist = PROTAGONIST_TEMPLATES[genre];
      
      const direction = {
        id: `${bookId}-dir-${index + 1}`,
        bookId,
        worldName,
        worldIndex: index + 1,
        coreConflict: template.coreConflict,
        protagonist: {
          name: protagonist.name,
          personality: protagonist.personality,
          motivation: protagonist.motivation,
          arc: protagonist.arc,
        },
        tone: template.tone,
        readerTarget: template.readerTarget,
        keyTwists: ['身份秘密', '信任背叛', '关键反转'],
        theme: template.theme,
        createdAt: new Date().toISOString(),
      };
      
      const filePath = path.join(bookDir, `${worldName}.json`);
      fs.writeFileSync(filePath, JSON.stringify(direction, null, 2), 'utf8');
    });
    
    console.log(`  完成: ${bookName}`);
  }
  
  console.log('改编方向数据创建完成！');
}

function createMockPool() {
  console.log('\n=== 创建大纲池数据 ===');
  
  const books = fs.readdirSync(BOOKS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
  
  const poolItems: any[] = [];
  
  for (const bookName of books.slice(0, 3)) {
    const bookId = bookName.match(/^(\d{4})/)?.[1] || bookName.slice(0, 4);
    const chapterCount = Math.floor(Math.random() * 20) + 10;
    const genre = getRandomGenre();
    
    for (let i = 1; i <= chapterCount; i++) {
      const outlineName = `第${String(i).padStart(3, '0')}章_${genre}${i}`;
      poolItems.push({
        id: `${bookId}-pool-${i}`,
        bookId,
        outlineName,
        chapterNumber: i,
        genre,
        quality: Math.floor(Math.random() * 3) + 3,
        wordCount: Math.floor(Math.random() * 500) + 100,
        adapted: true,
        sourcePath: `data/02_adapted/${bookId}/${outlineName}.md`,
        createdAt: new Date().toISOString(),
      });
    }
    
    console.log(`  完成: ${bookName} (${chapterCount}条)`);
  }
  
  if (!fs.existsSync(POOL_DIR)) {
    fs.mkdirSync(POOL_DIR, { recursive: true });
  }
  
  fs.writeFileSync(path.join(POOL_DIR, 'pool.json'), JSON.stringify(poolItems, null, 2), 'utf8');
  console.log('大纲池数据创建完成！');
}

function createMockComposedBooks() {
  console.log('\n=== 创建新书组稿数据 ===');
  
  if (!fs.existsSync(path.join(POOL_DIR, 'pool.json'))) {
    console.error('错误：请先运行 createMockPool()');
    return;
  }
  
  const poolData = JSON.parse(fs.readFileSync(path.join(POOL_DIR, 'pool.json'), 'utf8'));
  
  const newBooks = [
    { id: 'newbook-001', title: '凤舞九天：权谋皇后', author: '佚名', genre: '古代言情', description: '女主从闺阁少女成长为一代皇后的传奇故事', chapters: [], totalChapters: 0, wordCount: 0, createdAt: new Date().toISOString() },
    { id: 'newbook-002', title: '末世重生：崛起之路', author: '佚名', genre: '科幻末世', description: '重生回到末世降临前，组建幸存者基地', chapters: [], totalChapters: 0, wordCount: 0, createdAt: new Date().toISOString() },
    { id: 'newbook-003', title: '都市巅峰：从草根到传奇', author: '佚名', genre: '现代都市', description: '普通年轻人在都市中奋斗拼搏的故事', chapters: [], totalChapters: 0, wordCount: 0, createdAt: new Date().toISOString() },
  ];
  
  const genrePool = new Map<string, any[]>();
  poolData.forEach((item: any) => {
    const list = genrePool.get(item.genre) || [];
    list.push(item);
    genrePool.set(item.genre, list);
  });
  
  newBooks.forEach((book) => {
    const items = genrePool.get(book.genre) || poolData;
    const selectedItems = items.slice(0, Math.min(8, items.length));
    
    selectedItems.forEach((item: any, index: number) => {
      book.chapters.push({
        id: `${item.id}-ch-${index + 1}`,
        index: index + 1,
        title: item.outlineName,
        content: `这是第${index + 1}章的大纲内容，来自${item.genre}题材的${item.bookId}书籍。主要情节包括...`,
        sourcePoolItemId: item.id,
      });
      book.wordCount += Math.floor(Math.random() * 500) + 100;
    });
    
    book.totalChapters = book.chapters.length;
    
    const bookDir = path.join(COMPOSED_DIR, book.id);
    if (!fs.existsSync(bookDir)) {
      fs.mkdirSync(bookDir, { recursive: true });
    }
    
    fs.writeFileSync(path.join(bookDir, 'book.json'), JSON.stringify(book, null, 2), 'utf8');
    console.log(`  完成: ${book.title} (${book.chapters.length}章, ${book.wordCount}字)`);
  });
  
  console.log('新书组稿数据创建完成！');
}

console.log('=== 开始生成模拟数据 ===\n');

if (!fs.existsSync(DIRECTIONS_DIR)) fs.mkdirSync(DIRECTIONS_DIR, { recursive: true });
if (!fs.existsSync(POOL_DIR)) fs.mkdirSync(POOL_DIR, { recursive: true });
if (!fs.existsSync(COMPOSED_DIR)) fs.mkdirSync(COMPOSED_DIR, { recursive: true });

createMockDirections();
createMockPool();
createMockComposedBooks();

console.log('\n=== 所有模拟数据创建完成！ ===');
console.log(`改编方向: ${DIRECTIONS_DIR}`);
console.log(`大纲池: ${POOL_DIR}`);
console.log(`新书组稿: ${COMPOSED_DIR}`);