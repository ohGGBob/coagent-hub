/**
 * CoAgent.exe 单文件入口（Node SEA 打包专用）。
 *
 * 双模式：
 *   coagent.exe            或  coagent.exe serve [--port 8787] [--dir ./data]
 *       → 启动 Hub 主机服务（数据落在 exe 同目录的 data/，天然便携）。
 *   coagent.exe <cli命令> …
 *       → 转发给 agent CLI（init/sync/push/note/task/…，与 node scripts/hub.mjs 等价）。
 *
 * 打包：node scripts/build-exe.mjs（esbuild 单文件 CJS → SEA blob → postject 注入）。
 *
 * @module sea-entry
 */

const VERSION_TAG = 'coagent-hub exe';

function usage() {
  return `
CoAgent Hub — 单文件版（serve + agent CLI 二合一）

主机（开组的那台电脑）：
  coagent.exe                       双击或 serve：启动 Hub，数据在 exe 同目录 data\\
  coagent.exe serve --port 9000     换端口
  coagent.exe serve --dir D:\\coagent-data   换数据目录

同学（每台开发机）：
  coagent.exe init ./my-work        首次拉取项目并建立私有分支（先配好 .coagent.json）
  coagent.exe sync                  每天开工：拉取全组最新 + 看任务板
  coagent.exe push                  把本地改动分享给全组
  coagent.exe note "标题" --body …   上墙共享笔记
  coagent.exe task "标题"           建任务；coagent.exe claim <id> 认领
  coagent.exe watch --live          实时监听组内动态
  coagent.exe help                  完整命令表

Agent 自助接入：浏览器或 curl 打开  http://<主机IP>:8787/guide
`.trim();
}

/** 解析 serve 子命令的 --port/--dir */
function parseServeFlags(argv) {
  const out = { port: undefined, dir: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') out.port = Number(argv[++i]);
    else if (argv[i] === '--dir') out.dir = argv[++i];
  }
  return out;
}

async function serve(argv) {
  const flags = parseServeFlags(argv);
  if (Number.isFinite(flags.port) && flags.port > 0) process.env.COAGENT_PORT = String(flags.port);
  if (flags.dir) process.env.COAGENT_DATA = flags.dir;

  const [{ createHub }, config, auth, os] = await Promise.all([
    import('../src/server.js'),
    import('../src/config.js'),
    import('../src/auth.js'),
    import('node:os'),
  ]);
  const { PORT, PATHS, HUB_VERSION } = config;

  const { server } = createHub();
  server.listen(PORT, () => {
    const ips = Object.values(os.networkInterfaces())
      .flat()
      .filter((n) => n?.family === 'IPv4' && !n.internal)
      .map((n) => n.address);

    console.log('');
    console.log('  ╭──────────────────────────────────────────────╮');
    console.log(`  │  CoAgent Hub ${HUB_VERSION.padEnd(14)}（单文件版）  │`);
    console.log('  ╰──────────────────────────────────────────────╯');
    console.log('');
    console.log(`  本机访问     http://localhost:${PORT}`);
    for (const ip of ips) console.log(`  局域网访问   http://${ip}:${PORT}   ← 同学们的 agent 用这个`);
    console.log('');
    console.log(`  数据目录     ${PATHS.data}`);
    console.log(`  Agent 接入   把这句话发给同学的 agent：`);
    console.log(`               「fetch http://<上面任意地址>/guide 并照做」`);
    console.log('');
    console.log('  开户         coagent.exe adduser <id> "显示名" --token <管理员token>');
    console.log('  关闭服务     直接关掉本窗口（数据已实时落盘）');
    console.log('');

    const defaultUsers = auth.defaultTokensActive();
    if (defaultUsers.length) {
      console.warn(
        `  ⚠️ 以下账号仍在使用「种子默认 token」：${defaultUsers.join(', ')}\n` +
        '    任何能连上本 Hub 的人都可冒充管理员，正式使用前请立即轮换：\n' +
        '    coagent.exe adduser 或 POST /users/:id/rotate\n',
      );
    }
  });
  // 不注册任何退出钩子：关窗即退，数据全程实时落盘，无丢数据窗口。
}

async function cli(argv) {
  const hub = await import('./hub.mjs');
  try {
    const out = await hub.run(argv);
    if (out) console.log(out);
  } catch (err) {
    if (err instanceof hub.CliError) {
      console.error(`✗ ${err.message}`);
      process.exitCode = 1;
    } else {
      console.error(err?.stack ?? String(err));
      process.exitCode = 2;
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = (argv[0] ?? 'serve').toLowerCase();

  if (cmd === 'serve') return serve(argv.slice(1));
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return console.log(usage());
  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    return console.log(`${VERSION_TAG}  node ${process.version}`);
  }
  return cli(argv);
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(2);
});
