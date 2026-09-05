#!/usr/bin/env node
/**
 * `npm start` 的启动脚本：打印面向人的欢迎横幅后拉起 Hub。
 * （SEA 打包版 coagent.exe 的 serve 模式在 scripts/sea-entry.mjs 有自己的横幅。）
 *
 * @module serve
 */

import os from 'node:os';
import { createHub } from '../src/server.js';
import { PORT, PATHS, HUB_VERSION } from '../src/config.js';
import { defaultTokensActive } from '../src/auth.js';

const { server } = createHub();
server.listen(PORT, () => {
  console.log(`[CoAgent Hub] ${HUB_VERSION} 监听 :${PORT}（所有网卡）`);
  console.log(`[CoAgent Hub] 数据目录：${PATHS.data}`);
  console.log(`[CoAgent Hub] 裸仓：${PATHS.repo}`);
  const nets = os.networkInterfaces();
  const ips = Object.values(nets)
    .flat()
    .filter((n) => n?.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
  console.log('[CoAgent Hub] 同学们的 agent 用以下地址接入（同一网络时）：');
  for (const ip of ips) console.log(`[CoAgent Hub]   http://${ip}:${PORT}`);
  console.log(`[CoAgent Hub] Agent 自助接入指南：http://<本机IP>:${PORT}/guide`);
  console.log('[CoAgent Hub] 跨网络接入见 README.md（Tailscale 虚拟局域网）');
  console.log('[CoAgent Hub] 给同学开户：npm run hub -- adduser <userId> "显示名" --token <管理员token>');
  console.log('[CoAgent Hub] API 文档：README.md ｜ 冒烟自检：npm run smoke');

  // 只要还有账号在用种子默认 token，就在启动时第一时间警告更换
  const defaultUsers = defaultTokensActive();
  if (defaultUsers.length) {
    console.warn(
      `\n⚠️  以下账号仍在使用「种子默认 token」：${defaultUsers.join(', ')}\n` +
      '    这些口令写死并存于公开源码，任何能连上本 Hub 的人都可冒充管理员。\n' +
      '    → 正式使用前请立即轮换：POST /users/:id/rotate，或编辑 data/users.json 后重启。\n',
    );
  }
});
