import * as fs from 'node:fs';
import * as path from 'node:path';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const BOOKS_DIR = path.join(PROJECT_ROOT, 'data', '00_raw_chapters');
const DIRECTIONS_DIR = path.join(PROJECT_ROOT, 'data', '01_5_directions');

console.log('=== Test Mock Data Generator ===');
console.log('PROJECT_ROOT:', PROJECT_ROOT);
console.log('BOOKS_DIR:', BOOKS_DIR);

try {
  const books = fs.readdirSync(BOOKS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
  
  console.log('\nFound books:', books.length);
  books.forEach(b => console.log('  -', b));
  
  if (!fs.existsSync(DIRECTIONS_DIR)) {
    fs.mkdirSync(DIRECTIONS_DIR, { recursive: true });
    console.log('\nCreated DIRECTIONS_DIR:', DIRECTIONS_DIR);
  }
  
  for (const bookName of books.slice(0, 2)) {
    const bookId = bookName.match(/^(\d{4})/)?.[1] || bookName.slice(0, 4);
    const bookDir = path.join(DIRECTIONS_DIR, bookName);
    
    if (!fs.existsSync(bookDir)) {
      fs.mkdirSync(bookDir, { recursive: true });
    }
    
    const testFile = path.join(bookDir, 'test.json');
    fs.writeFileSync(testFile, JSON.stringify({ bookId, bookName }, null, 2), 'utf8');
    console.log('\nCreated test file:', testFile);
  }
  
  console.log('\n=== Test Complete ===');
} catch (err: any) {
  console.error('Error:', err.message);
  process.exit(1);
}