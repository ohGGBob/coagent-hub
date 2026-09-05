/**
 * 把整个 CoAgent Hub 打包成单个 Windows exe（Node SEA 方案）。
 *
 *   node scripts/build-exe.mjs
 *   → dist/entry.cjs（esbuild 单文件 CJS）
 *   → dist/sea-prep.blob（SEA 资源包）
 *   → dist/coagent.exe（node.exe 副本 + 注入资源，可直接分发）
 *
 * 产物是便携的：数据目录默认为 exe 同目录的 data/，拷到任何 Windows x64
 * 机器上双击即用，目标机不需要装 Node。
 *
 * @module build-exe
 */

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

// 1) esbuild 打成单文件 CJS（SEA 只认 CommonJS 入口）
fs.mkdirSync(DIST, { recursive: true });
await esbuild.build({
  entryPoints: [path.join(ROOT, 'scripts/sea-entry.mjs')],
  outfile: path.join(DIST, 'entry.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  legalComments: 'none',
  // 让 server.js / hub.mjs 的「直接运行守卫」在 exe 里全体让位，调度权归本入口
  define: { 'process.env.COAGENT_ENTRY': '"sea"' },
  minify: false, // 出问题时堆栈可读，比那点体积重要
});
console.log('[1/4] esbuild 单文件打包完成 → dist/entry.cjs');

// 2) 生成 SEA 资源包
const seaConfig = path.join(DIST, 'sea-config.json');
fs.writeFileSync(
  seaConfig,
  JSON.stringify(
    {
      main: 'dist/entry.cjs',
      output: 'dist/sea-prep.blob',
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: true,
      assets: { 'panel.html': 'src/panel.html' },
    },
    null,
    2,
  ),
);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { cwd: ROOT, stdio: 'inherit' });
console.log('[2/4] SEA blob 生成完成 → dist/sea-prep.blob');

// 3) 复制 node.exe 作为宿主
const exe = path.join(DIST, 'coagent.exe');
fs.copyFileSync(process.execPath, exe);
console.log(`[3/4] 宿主就绪：${process.execPath} → dist/coagent.exe`);

// 4) postject 注入资源
const postject = require('postject');
await postject.inject(exe, 'NODE_SEA_BLOB', fs.readFileSync(path.join(DIST, 'sea-prep.blob')), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  overwrite: true, // 重复构建时直接覆盖旧资源
});
const sizeMB = (fs.statSync(exe).size / 1024 / 1024).toFixed(1);
console.log(`[4/4] 资源注入完成 → dist/coagent.exe（${sizeMB} MB）`);
console.log('\n完成。分发 dist/coagent.exe 即可；目标机无需安装 Node。');
