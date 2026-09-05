#!/usr/bin/env node
/**
 * 实验：生成桌面启动器（仅在工作区内产出，不碰用户桌面）。
 *
 * 已知约束（本沙箱实测）：
 *  - cmd.exe 被沙箱完全禁用，无法在此环境实测 .bat 的双击行为；
 *  - Git Bash 的 MSYS 路径转换会把内容里的 `D:\路径` 改写为 `D:/路径`，
 *    所以内容必须由 Node 生成（写 UTF-8 临时文件），再经 iconv 转 GBK；
 *  - cmd.exe 只认系统 ANSI 代码页（中文系统 = GBK），UTF-8 直写的 .bat 会乱码。
 *
 * 产物：out/ 下的三个 .bat（GBK 编码），供用户在资源管理器里手动双击验证。
 *
 * 用法：node experiments/desktop-launcher/generate.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..'); // 项目根：D:\CoAgent项目开发
const OUT = path.join(HERE, 'out');
fs.mkdirSync(OUT, { recursive: true });

const launchers = [
  {
    name: 'coagent-hub-start.bat',
    body: `@echo off
title CoAgent Hub
cd /d "${ROOT}"
echo ================================================
echo   CoAgent Hub  starting...  (Ctrl+C to stop)
echo ================================================
node src\\server.js
echo.
echo [Hub exited] Press any key to close...
pause >nul
`,
  },
  {
    name: 'coagent-cli.bat',
    body: `@echo off
title CoAgent CLI
cd /d "${ROOT}"
echo CoAgent work terminal (try: npm run hub -- status)
%COMSPEC% /k
`,
  },
  {
    name: 'coagent-project-folder.bat',
    body: `@echo off
start "" "${ROOT}"
`,
  },
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-utf8-'));
let ok = 0;

/** Windows 批处理必须 CRLF 换行，LF 在个别语法（goto 标签）下会出错 */
const toCRLF = (text) => text.replace(/\r?\n/g, '\r\n');

for (const item of launchers) {
  // 第 1 步：Node 写 UTF-8（内容零损耗：反斜杠、中文路径原样保留；换行强制 CRLF）
  const utf8File = path.join(tmp, item.name + '.utf8');
  fs.writeFileSync(utf8File, toCRLF(item.body), 'utf8');

  // 第 2 步：iconv 转 GBK（cmd.exe 要求 ANSI 代码页）
  const out = path.join(OUT, item.name);
  const r = spawnSync('iconv', ['-f', 'UTF-8', '-t', 'GBK', utf8File], { encoding: 'buffer' });
  if (r.status !== 0 || !r.stdout?.length) {
    console.error(`✗ ${item.name}: iconv 失败 ${(r.stderr || '').toString()}`);
    continue;
  }
  fs.writeFileSync(out, r.stdout);

  // 第 3 步：回读自检（GBK → UTF-8 往返应与 CRLF 化的原文一致）
  const back = spawnSync('iconv', ['-f', 'GBK', '-t', 'UTF-8', out], { encoding: 'utf8' });
  const roundtripOk = back.status === 0 && back.stdout === toCRLF(item.body);
  console.log(`${roundtripOk ? '✓' : '✗'} ${item.name}（${fs.statSync(out).size} 字节，往返校验${roundtripOk ? '通过' : '失败'}）`);
  if (roundtripOk) ok++;
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n完成：${ok}/${launchers.length} 个启动器已生成到 ${OUT}`);
console.log('下一步：在资源管理器里双击验证（沙箱无法代跑 cmd.exe）。');
