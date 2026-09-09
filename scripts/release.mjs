#!/usr/bin/env node
/**
 * 发布工具：创建 GitHub Release 并上传 dist/ 三平台产物。
 * 用法：node scripts/release.mjs <版本号如 0.12.0> [标题]
 *  - tag 自动在当前 main HEAD 打（v<版本>）
 *  - 说明文稿从 CHANGELOG.md 提取对应版本的段落
 *  - 产物：dist/coagent-win-x64.exe、dist/coagent-macos-arm64.zip、dist/coagent-macos-x64.zip
 *  - 上传前自动生成 dist/checksums.txt（三产物 SHA-256），一并上传——
 *    自更新（src/update.js）下载更新包后会对照该清单校验，缺失即拒绝更新
 *  - 凭证取自本机 git credential；上传走 multipart（国内边缘节点要求）
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('用法：node scripts/release.mjs <版本号> [标题]');
  process.exit(1);
}
const TAG = 'v' + version;
const REPO = 'ohGGBob/coagent-hub';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const cred = spawnSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });
const token = (cred.stdout.match(/password=(.+)/) || [])[1]?.trim();
if (!token) { console.error('✗ 未找到本机 github.com 凭证'); process.exit(1); }
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'coagent-hub' };

// 从 CHANGELOG 提取该版本段落作为说明
const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
const head = changelog.indexOf(`## [${version}]`);
const next = changelog.indexOf('\n## [', head + 1);
if (head < 0) { console.error(`✗ CHANGELOG 中没有 ${version} 的条目`); process.exit(1); }
const notes = changelog.slice(head, next > 0 ? next : undefined).replace(`## [${version}]`, `## ${TAG}`).trim();
const title = process.argv[3] || `${TAG} · CoAgent Hub`;

const assets = [
  ['coagent-win-x64.exe', 'application/octet-stream'],
  ['coagent-macos-arm64.zip', 'application/zip'],
  ['coagent-macos-x64.zip', 'application/zip'],
  ['checksums.txt', 'text/plain'],
];

// 生成校验和清单：三个平台产物各一行（sha256sum 格式，update.js 会解析校验）
{
  const lines = [];
  for (const name of assets.slice(0, 3).map(([n]) => n)) {
    const file = path.join(DIST, name);
    if (!fs.existsSync(file)) { console.error(`✗ 缺少产物：${file}`); process.exit(1); }
    lines.push(createHash('sha256').update(fs.readFileSync(file)).digest('hex') + '  ' + name);
  }
  fs.writeFileSync(path.join(DIST, 'checksums.txt'), lines.join('\n') + '\n');
  console.log('✓ 已生成 checksums.txt');
}

// 已存在则补传
const exist = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`, { headers });
let releaseId, uploadBase, htmlUrl;
if (exist.status === 200) {
  const j = await exist.json();
  releaseId = j.id; uploadBase = j.upload_url.replace('{?name,label}'); htmlUrl = j.html_url;
  console.log('Release 已存在，补传产物：', htmlUrl);
} else {
  const create = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: TAG, target_commitish: 'main', name: title, body: notes, draft: false, prerelease: false }),
  });
  const j = await create.json();
  if (!create.ok) { console.error('✗ 创建失败：', JSON.stringify(j).slice(0, 300)); process.exit(1); }
  releaseId = j.id; uploadBase = j.upload_url.replace('{?name,label}'); htmlUrl = j.html_url;
  console.log('✓ Release 已创建：', htmlUrl);
}

const have = new Set();
{
  const j = await fetch(`https://api.github.com/repos/${REPO}/releases/${releaseId}`, { headers }).then((r) => r.json());
  for (const a of j.assets ?? []) have.add(a.name);
}

// 上传走 curl multipart（Node fetch 的分块传输会被边缘节点判 Bad Size）。
// cwd 设为 DIST、用纯 ASCII 相对文件名——绝对路径含中文时 Windows curl 读不到文件
for (const [name] of assets) {
  if (have.has(name)) { console.log(`跳过 ${name}（已上传）`); continue; }
  const file = path.join(DIST, name);
  if (!fs.existsSync(file)) { console.error(`✗ 缺少产物：${file}`); process.exitCode = 1; continue; }
  process.stdout.write(`上传 ${name} … `);
  const r = spawnSync('curl', ['-sS', '-X', 'POST',
    '-H', `Authorization: Bearer ${token}`,
    '-H', 'Accept: application/vnd.github+json',
    '-F', `file=@${name}`,
    `${uploadBase}?name=${name}`], { encoding: 'utf8', timeout: 600_000, cwd: DIST });
  let ok = false;
  try { const j = JSON.parse(r.stdout); ok = !!j.name && j.size > 0; } catch { /* 解析失败 */ }
  console.log(ok ? '✓' : '✗ ' + (r.stdout || r.stderr || '').slice(0, 150));
  if (!ok) process.exitCode = 1;
}
console.log('\n发布地址：', htmlUrl);
