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

/* 零依赖 ANSI 彩色（SEA 环境下 stdout 通常是 TTY） */
const USE_COLOR = !process.env.NO_COLOR && process.stdout.isTTY !== false;
const c = (code) => (s) => (USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const C = {
  bold: c(1), dim: c(2), red: c(31), green: c(32), yellow: c(33),
  blue: c(34), magenta: c(35), cyan: c(36), gray: c(90),
};

function usage() {
  return `
${C.bold('CoAgent Hub')} — 单文件版（serve + agent CLI 二合一）

${C.cyan('主机（开组的那台电脑）：')}
  coagent.exe                       双击或 serve：启动 Hub，数据在 exe 同目录 data\\
  coagent.exe serve --port 9000     换端口
  coagent.exe serve --dir D:\\coagent-data   换数据目录

${C.cyan('同学（每台开发机）：')}
  coagent.exe init ./my-work        首次拉取项目并建立私有分支
  coagent.exe sync                  每天开工：拉取全组最新 + 看任务板
  coagent.exe push                  把本地改动分享给全组
  coagent.exe note "标题" --body …   上墙共享笔记
  coagent.exe task "标题"           建任务；coagent.exe claim <id> 认领
  coagent.exe comment "…" --task <id>  给任务/PR 发评论
  coagent.exe search "关键词"       全局搜索任务和上下文
  coagent.exe log                   查看事件历史
  coagent.exe diff [branch]         查看分支 diff
  coagent.exe watch --live          实时监听组内动态
  coagent.exe help                  完整命令表

${C.gray('Agent 自助接入：浏览器或 curl 打开  http://<主机IP>:8787/guide')}
`.trim();
}

/** 解析 serve 子命令的 --port/--dir/--no-browser */
function parseServeFlags(argv) {
  const out = { port: undefined, dir: undefined, noBrowser: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') out.port = Number(argv[++i]);
    else if (argv[i] === '--dir') out.dir = argv[++i];
    else if (argv[i] === '--no-browser') out.noBrowser = true;
  }
  return out;
}

/** 尝试监听端口，冲突时自动递增（最多试 10 个） */
function listenWithFallback(server, preferredPort) {
  return new Promise((resolve, reject) => {
    let port = preferredPort;
    let attempts = 0;
    const tryListen = () => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempts < 10) {
          attempts++;
          port++;
          console.log(`  ${C.yellow('端口 ' + (port - 1) + ' 被占用，尝试 ' + port + '…')}`);
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

async function serve(argv) {
  const flags = parseServeFlags(argv);
  if (Number.isFinite(flags.port) && flags.port > 0) process.env.COAGENT_PORT = String(flags.port);
  if (flags.dir) process.env.COAGENT_DATA = flags.dir;

  // git 依赖检测：缺 git 时给可执行指引（代码协作层无法工作）
  const cp = await import('node:child_process');
  const g = cp.spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (g.status !== 0 || g.error) {
    console.error(
      '✗ 本机没有安装 git（或不在 PATH），Hub 无法启动代码协作层。\n' +
      '  → 下载安装：https://git-scm.com/download/win （一路默认即可）\n' +
      '  → 装完重新运行本程序。',
    );
    process.exit(1);
  }

  const [{ createHub }, config, auth, os] = await Promise.all([
    import('../src/server.js'),
    import('../src/config.js'),
    import('../src/auth.js'),
    import('node:os'),
  ]);
  const { PATHS, HUB_VERSION } = config;

  const { server, close } = createHub();

  // 优雅关闭：关窗 / Ctrl+C 时先关连接再退
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n  ${C.yellow('收到 ' + signal + '，正在关闭…')}`);
    await close();
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const actualPort = await listenWithFallback(server, config.PORT);

  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n?.family === 'IPv4' && !n.internal)
    .map((n) => n.address);

  const bootstrap = auth.getBootstrapInfo();

  console.log('');
  console.log(`  ${C.magenta('╭──────────────────────────────────────────────╮')}`);
  console.log(`  ${C.magenta('│')}  ${C.bold('CoAgent Hub')} ${C.cyan(HUB_VERSION.padEnd(14))}（单文件版）  ${C.magenta('│')}`);
  console.log(`  ${C.magenta('╰──────────────────────────────────────────────╯')}`);
  console.log('');
  console.log(`  ${C.gray('本机访问')}     ${C.green('http://localhost:' + actualPort)}`);
  for (const ip of ips) console.log(`  ${C.gray('局域网访问')}   ${C.green('http://' + ip + ':' + actualPort)}   ${C.yellow('← 同学们的 agent 用这个')}`);
  console.log('');
  console.log(`  ${C.gray('数据目录')}     ${C.dim(PATHS.data)}`);
  console.log(`  ${C.gray('网页面板')}     ${C.cyan('http://localhost:' + actualPort + '/panel')}`);
  console.log(`  ${C.gray('Agent 接入')}   把这句话发给同学的 agent：`);
  console.log(`               ${C.dim('「fetch http://<上面任意地址>/guide 并照做」')}`);
  console.log('');

  // 首次启动引导：显示种子管理员 token，降低上手门槛
  if (bootstrap.firstRun) {
    console.log(`  ${C.green('╭────────── 首次启动快速开始 ──────────╮')}`);
    console.log(`  ${C.green('│')}  ${C.bold('管理员账号：')}${C.cyan(bootstrap.adminId)}`);
    console.log(`  ${C.green('│')}  ${C.bold('接入 Token：')}${C.yellow(bootstrap.adminToken)}`);
    console.log(`  ${C.green('│')}  面板已自动填充，打开浏览器即可登录`);
    console.log(`  ${C.green('╰──────────────────────────────────────╯')}`);
    console.log('');
  }

  console.log(`  ${C.gray('开户')}         coagent.exe adduser <id> "显示名" --token <管理员token>`);
  console.log(`  ${C.gray('关闭服务')}     直接关掉本窗口（数据已实时落盘）`);
  console.log('');

  const defaultUsers = auth.defaultTokensActive();
  if (defaultUsers.length && !bootstrap.firstRun) {
    console.warn(
      `  ${C.red('⚠️ 以下账号仍在使用「种子默认 token」：')}${defaultUsers.join(', ')}\n` +
      `    ${C.red('任何能连上本 Hub 的人都可冒充管理员，正式使用前请立即轮换：')}\n` +
      `    ${C.dim('coagent.exe adduser 或 POST /users/:id/rotate')}\n`,
    );
  }

  // 自动打开浏览器（首次启动或非 --no-browser）
  if (!flags.noBrowser) {
    const panelUrl = `http://localhost:${actualPort}/panel`;
    setTimeout(() => {
      try {
        const { exec } = cp;
        const cmd = process.platform === 'win32' ? `start "" "${panelUrl}"` :
          process.platform === 'darwin' ? `open "${panelUrl}"` : `xdg-open "${panelUrl}"`;
        exec(cmd, { shell: true });
      } catch { /* 自动开浏览器失败不影响服务 */ }
    }, 500);
  }
}

async function cli(argv) {
  const hub = await import('./hub.mjs');
  try {
    const out = await hub.run(argv);
    if (out) console.log(out);
  } catch (err) {
    if (err instanceof hub.CliError) {
      console.error(C.red('✗ ' + err.message));
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
