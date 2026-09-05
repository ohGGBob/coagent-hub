/**
 * 修复本机特有的「refs/remotes 幻影」问题：
 * 沙箱会把 .git/refs/remotes/ 下的松散引用吞掉，导致 push/fetch 后
 * `git status` 显示 [ahead]/[gone]。本脚本从远端取真实 sha，
 * 直接写进 packed-refs（沙箱不碰 packed-refs，实测稳定）。
 *
 *   npm run fixrefs
 *
 * @module fix-refs
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GIT = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

const packed = path.join(ROOT, '.git', 'packed-refs');
let lines = [];
if (fs.existsSync(packed)) {
  lines = fs.readFileSync(packed, 'utf8').split('\n').filter(Boolean);
}
lines = lines.filter((l) => l.startsWith('#') || !l.includes('refs/remotes/origin/'));

// ls-remote 不经过本地引用层，拿到的就是远端真相
const out = GIT(['ls-remote', 'origin']);
for (const line of out.split('\n')) {
  const [sha, ref] = line.split('\t');
  if (!sha || !ref?.startsWith('refs/heads/')) continue;
  const short = ref.replace('refs/heads/', '');
  lines.push(`${sha}\trefs/remotes/origin/${short}`);
}

fs.writeFileSync(packed, lines.join('\n') + '\n');
console.log('✓ origin 引用已刷新（packed-refs）：');
for (const l of lines.filter((l) => !l.startsWith('#'))) console.log('  ' + l.replace(/\t/, ' '));
