/**
 * 语法门禁：对 assets/js 与 tests 下的所有 ES Module 做一次解析检查。
 * 目的不是替代测试，而是让"语法写错导致整页白屏"这类低级问题在 CI 里先被拦住。
 * 运行：node tests/check-syntax.mjs（或 npm run check）
 */

import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const TARGETS = ['assets/js', 'tests'];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(js|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

const files = TARGETS.flatMap((t) => walk(join(ROOT, t))).sort();
let fail = 0;

for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log(`  OK    ${rel}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL  ${rel}`);
    console.log(String(e.stderr || e.message).trim());
  }
}

console.log(`\n检查 ${files.length} 个文件，失败 ${fail} 个`);
process.exit(fail === 0 ? 0 : 1);
