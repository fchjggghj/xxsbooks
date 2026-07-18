import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncFanqieMarketingFiles } from '../lib/fanqie-marketing.mjs';

const projectRoot = path.resolve(process.env.XXSBOOKS_PROJECT_ROOT || path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const args = process.argv.slice(2);
let book = '';
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--book') {
    if (!args[index + 1]) throw new Error('--book 缺少参数');
    book = args[++index];
  } else throw new Error(`未知参数: ${args[index]}`);
}

syncFanqieMarketingFiles(projectRoot, { book }).then(
  (result) => console.log(JSON.stringify(result, null, 2)),
  (error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  },
);
