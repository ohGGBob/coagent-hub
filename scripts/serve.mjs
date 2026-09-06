#!/usr/bin/env node
/**
 * `npm start` 的启动脚本：打印面向人的欢迎横幅后拉起 Hub。
 * （SEA 打包版 coagent.exe 的 serve 模式在 scripts/sea-entry.mjs 有自己的横幅。）
 *
 * @module serve
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, exec } from 'node:child_process';

// 从 package.json 读取版本号，注入到 config.js 的 HUB_VERSION
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
process.env.COAGENT_VERSION = PKG.version;

import { createHub } from '../src/server.js';
import { PORT, PATHS, HUB_VERSION } from '../src/config.js';
import { defaultTokensActive, getBootstrapInfo } from '../src/auth.js';

// Hub 的代码协作层依赖 git 子进程；缺 git 时给出可执行的指引而不是一串堆栈
{
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (r.status !== 0 || r.error) {
    console.error(
      '✗ 本机没有安装 git（或不在 PATH），Hub 无法启动代码协作层。\n' +
      '  → 下载安装：https://git-scm.com/download/win （一路默认即可）\n' +
      '  → 装完重新运行本程序。',
    );
    process.exit(1);
  }
}

const noBrowser = process.argv.includes('--no-browser');
const { server, close } = createHub();

// 优雅关闭：Ctrl+C / 任务管理器结束时先关连接再退，避免半写数据
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[CoAgent Hub] 收到 ${signal}，准备关闭…`);
  await close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

/** 端口冲突时自动递增（最多试 10 个） */
function listenWithFallback(preferred) {
  return new Promise((resolve, reject) => {
    let port = preferred;
    let attempts = 0;
    const tryListen = () => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempts < 10) {
          attempts++;
          port++;
          console.log(`[CoAgent Hub] 端口 ${port - 1} 被占用，尝试 ${port}…`);
          tryListen();
        } else {
          reject(err);
        }
      });
      server.listen(port, () => {
        server.removeAllListeners('error');
        resolve(port);
      });
    };
    tryListen();
  });
}

const actualPort = await listenWithFallback(PORT);

console.log(`[CoAgent Hub] ${HUB_VERSION} 监听 :${actualPort}（所有网卡）`);
console.log(`[CoAgent Hub] 数据目录：${PATHS.data}`);
console.log(`[CoAgent Hub] 裸仓：${PATHS.repo}`);
const nets = os.networkInterfaces();
const ips = Object.values(nets)
  .flat()
  .filter((n) => n?.family === 'IPv4' && !n.internal)
  .map((n) => n.address);
console.log('[CoAgent Hub] 同学们的 agent 用以下地址接入（同一网络时）：');
for (const ip of ips) console.log(`[CoAgent Hub]   http://${ip}:${actualPort}`);
console.log(`[CoAgent Hub] Agent 自助接入指南：http://<本机IP>:${actualPort}/guide`);
console.log(`[CoAgent Hub] 网页管理面板：http://localhost:${actualPort}/panel`);
console.log('[CoAgent Hub] 跨网络接入见 README.md（Tailscale 虚拟局域网）');
console.log('[CoAgent Hub] 给同学开户：npm run hub -- adduser <userId> "显示名" --token <管理员token>');
console.log('[CoAgent Hub] API 文档：README.md ｜ 冒烟自检：npm run smoke');

// 首次启动引导
const bootstrap = getBootstrapInfo();
if (bootstrap.firstRun) {
  console.log(`\n╭────────── 首次启动快速开始 ──────────╮`);
  console.log(`│  管理员账号：${bootstrap.adminId}`);
  console.log(`│  接入 Token：${bootstrap.adminToken}`);
  console.log(`│  面板已自动填充，打开浏览器即可登录`);
  console.log(`╰──────────────────────────────────────╯`);
}

// 只要还有账号在用种子默认 token（且非首次），就警告更换
const defaultUsers = defaultTokensActive();
if (defaultUsers.length && !bootstrap.firstRun) {
  console.warn(
    `\n⚠️  以下账号仍在使用「种子默认 token」：${defaultUsers.join(', ')}\n` +
    '    这些口令写死并存于公开源码，任何能连上本 Hub 的人都可冒充管理员。\n' +
    '    → 正式使用前请立即轮换：POST /users/:id/rotate，或面板用户管理页一键换。\n',
  );
}

// 自动打开浏览器
if (!noBrowser) {
  setTimeout(() => {
    try {
      const url = `http://localhost:${actualPort}/panel`;
      const cmd = process.platform === 'win32' ? `start "" "${url}"` :
        process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
      exec(cmd, { shell: true });
    } catch { /* 忽略 */ }
  }, 500);
}
