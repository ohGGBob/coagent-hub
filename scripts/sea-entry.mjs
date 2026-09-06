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

/* 静态导入（esbuild 打 CJS 时转为 require；此文件不能有顶层 await） */
import childProcess from 'node:child_process';
import path from 'node:path';
import { openAppWindow, createDesktopShortcut, isHubAlreadyRunning } from './app-window.mjs';

/* 零依赖 ANSI 彩色（SEA 环境下 stdout 通常是 TTY） */
const USE_COLOR = !process.env.NO_COLOR && process.stdout.isTTY !== false;
const c = (code) => (s) => (USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const C = {
  bold: c(1), dim: c(2), red: c(31), green: c(32), yellow: c(33),
  blue: c(34), magenta: c(35), cyan: c(36), gray: c(90),
};

function usage() {
  return `
${C.bold('CoAgent Hub')} — 单文件版（应用窗口 + Hub 服务 + agent CLI 三合一）

${C.cyan('主机（开组的那台电脑）：')}
  coagent.exe                       双击即用：启动 Hub 并弹出应用窗口
                                    （重复双击不会起第二个服务，直接再弹窗）
  coagent.exe serve --port 9000     换端口
  coagent.exe serve --dir D:\\coagent-data   换数据目录
  coagent.exe serve --no-browser    不自动弹窗

${C.cyan('同学（每台开发机）：')}
  coagent.exe app --hub http://<主机IP>:8787 --token <接入卡片里的token>
                                    弹出应用窗口并登录，同时在桌面创建
                                    「CoAgent Hub」快捷方式，以后双击直达
  coagent.exe init ./my-work --hub <地址> --token <token>
                                    首次拉取项目并建立私有分支（agent 用）
  coagent.exe sync                  每天开工：拉取全组最新 + 看任务板
  coagent.exe push                  把本地改动分享给全组
  coagent.exe note "标题" --body …   上墙共享笔记
  coagent.exe task "标题"           建任务；coagent.exe claim <id> 认领
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

const cp = childProcess;

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
  const g = cp.spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (g.status !== 0 || g.error) {
    console.error(
      '✗ 本机没有安装 git（或不在 PATH），Hub 无法启动代码协作层。\n' +
      '  → 下载安装：https://git-scm.com/download/win （一路默认即可）\n' +
      '  → 装完重新运行本程序。',
    );
    process.exit(1);
  }

  // 单实例检测：重复双击 exe 时不起第二个服务，直接唤起应用窗口
  const preferredPort = Number(process.env.COAGENT_PORT ?? 8787);
  if (await isHubAlreadyRunning(preferredPort)) {
    console.log(`  ${C.green('✓ CoAgent Hub 已在运行（端口 ' + preferredPort + '），直接打开应用窗口')}`);
    openAppWindow(`http://localhost:${preferredPort}/panel`);
    return;
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

  // 自动打开应用窗口（独立窗口形态；--no-browser 可禁用）
  if (!flags.noBrowser) {
    const panelUrl = `http://localhost:${actualPort}/panel`;
    setTimeout(() => {
      const how = openAppWindow(panelUrl);
      if (how === 'app') console.log(`  ${C.gray('应用窗口已弹出（关闭本窗口即退出服务）')}`);
    }, 500);

    // 首次运行成功后在桌面创建快捷方式，下次双击桌面图标直达
    if (bootstrap.firstRun && process.platform === 'win32') {
      setTimeout(() => {
        const ok = createDesktopShortcut({
          name: 'CoAgent Hub',
          target: process.execPath,
          workingDir: path.dirname(process.execPath),
        });
        if (ok) console.log(`  ${C.green('✓ 已在桌面创建「CoAgent Hub」快捷方式，下次双击图标直达')}`);
      }, 1200);
    }
  }
}

/**
 * 同学侧「双击直达」：coagent.exe app --hub <url> --token <tok>
 * 校验 Hub 可达 → 弹已登录的应用窗口 → 默认创建桌面快捷方式（--no-save 关闭）。
 */
async function appMode(argv) {
  const opts = { hub: '', token: '', save: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--hub') opts.hub = argv[++i];
    else if (argv[i] === '--token') opts.token = argv[++i];
    else if (argv[i] === '--no-save') opts.save = false;
  }
  if (!opts.hub || !opts.token) {
    console.error('用法：coagent.exe app --hub http://<主机IP>:8787 --token <接入卡片里的token>');
    console.error('  （接入卡片由主机同学开户时生成；--no-save 表示不创建桌面快捷方式）');
    process.exitCode = 1;
    return;
  }
  const hubUrl = opts.hub.replace(/\/+$/, '');
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`${hubUrl}/healthz`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error(`✗ 连不上 Hub（${hubUrl}）：${err?.message ?? err}`);
    console.error('  → 检查地址是否正确、主机是否开机、防火墙是否放行端口。');
    process.exitCode = 1;
    return;
  }

  // token 走 URL fragment：不进服务器日志、不进浏览器历史，进面板后立即清除
  const how = openAppWindow(`${hubUrl}/panel#token=${encodeURIComponent(opts.token)}`);
  console.log(`  ${C.green('✓ 应用窗口已打开（' + (how === 'app' ? '独立窗口' : '默认浏览器') + '模式）')}`);

  if (opts.save && process.platform === 'win32') {
    const ok = createDesktopShortcut({
      name: 'CoAgent Hub',
      target: process.execPath,
      args: `app --hub ${hubUrl} --token ${opts.token}`,
      workingDir: path.dirname(process.execPath),
    });
    if (ok) console.log(`  ${C.green('✓ 已在桌面创建「CoAgent Hub」快捷方式，下次双击图标直达')}`);
  }
  console.log(`  ${C.gray('本窗口可以关掉，不影响使用（浏览器窗口独立于本进程）')}`);
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
  if (cmd === 'app') return appMode(argv.slice(1));
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
