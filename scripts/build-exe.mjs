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
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

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
  define: {
    'process.env.COAGENT_ENTRY': '"sea"',
    'process.env.COAGENT_VERSION': `"${PKG.version}"`,
  },
  minify: false, // 出问题时堆栈可读，比那点体积重要
});
console.log(`[1/4] esbuild 单文件打包完成 → dist/entry.cjs（v${PKG.version}）`);

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
      assets: { 'panel.html': 'src/panel.html', 'icon.ico': 'dist/icon.ico' },
    },
    null,
    2,
  ),
);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { cwd: ROOT, stdio: 'inherit' });
console.log('[2/4] SEA blob 生成完成 → dist/sea-prep.blob');

// 3) 复制 node.exe 作为宿主（Windows）
const exe = path.join(DIST, 'coagent-win-x64.exe');
fs.copyFileSync(process.execPath, exe);
console.log(`[3/4] 宿主就绪：${process.execPath} → dist/coagent-win-x64.exe`);

// 4) postject 注入资源
const postject = require('postject');
await postject.inject(exe, 'NODE_SEA_BLOB', fs.readFileSync(path.join(DIST, 'sea-prep.blob')), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  overwrite: true, // 重复构建时直接覆盖旧资源
});
const sizeMB = (fs.statSync(exe).size / 1024 / 1024).toFixed(1);
console.log(`[4/4] 资源注入完成 → dist/coagent-win-x64.exe（${sizeMB} MB）`);

// 可选：嵌入 exe 图标（用本地 rcedit 二进制同步调用；不存在则跳过——
// 快捷方式图标由「释放 icon.ico + IconLocation」兜底，不依赖本步骤）
try {
  const rceditBin = path.join(ROOT, 'node_modules', 'rcedit', 'bin', process.arch === 'x64' ? 'rcedit-x64.exe' : 'rcedit.exe');
  if (process.platform === 'win32' && fs.existsSync(rceditBin)) {
    execFileSync(rceditBin, [exe, '--set-icon', path.join(DIST, 'icon.ico')], { stdio: 'pipe', timeout: 30_000 });
    console.log('[+] exe 图标已嵌入（rcedit）');
  } else {
    console.log('[!] 跳过 exe 图标嵌入（非 Windows 或 rcedit 未安装）；桌面快捷方式仍会显示应用图标');
  }
} catch (err) {
  console.warn(`[!] exe 图标未嵌入（${String(err?.message ?? err).slice(0, 60)}）；桌面快捷方式仍会显示应用图标`);
}

/* ============================================================
   macOS 版：--target=mac-arm64 / mac-x64（可叠加，--target=win,mac-arm64）
   下载对应版本的 darwin node 宿主 → 注入同一份 blob → 组装 CoAgent.app → zip。
   注意：注入会破坏 Mach-O 签名，Apple Silicon 必须 ad-hoc 重签——
   我们在 zip 里附带 sign-and-run.sh（macOS 自带 codesign，一条命令）。
   ============================================================ */
const targetArg = (process.argv.find((a) => a.startsWith('--target')) ?? '--target=').split('=')[1] ?? '';
const macArchs = targetArg.split(',').map((s) => s.trim()).filter((s) => s === 'mac-arm64' || s === 'mac-x64');

const INFO_PLIST = (version) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>CoAgent Hub</string>
  <key>CFBundleDisplayName</key><string>CoAgent Hub</string>
  <key>CFBundleExecutable</key><string>CoAgent</string>
  <key>CFBundleIdentifier</key><string>io.coagent.hub</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>coagent</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSMinimumSystemVersion</key><string>10.15</string>
</dict></plist>`;

const MAC_README = (arch) => `CoAgent Hub（macOS ${arch}）首次使用说明
=====================================

1. 解压本 zip，得到 CoAgent.app
2. 首次打开需要终端执行一次（macOS 安全机制，应用未做公证）：

     xattr -cr CoAgent.app
     codesign --force --deep --sign - CoAgent.app

3. 之后双击 CoAgent.app 即可：弹出应用主页面（创建组 / 加入组 / 教程）

数据默认存放在 ~/coagent-data（可用 COAGENT_DATA 环境变量修改）。
`;

/** 获取（带缓存）指定架构的 darwin node 宿主二进制 */
async function getDarwinNode(arch) {
  const nodeVer = process.version; // SEA blob 与 node 版本强绑定，宿主必须同版本
  const cacheDir = path.join(DIST, 'cache');
  const cached = path.join(cacheDir, `node-darwin-${arch}-${nodeVer}`);
  if (fs.existsSync(cached)) return cached;

  const url = `https://nodejs.org/dist/${nodeVer}/node-${nodeVer}-darwin-${arch}.tar.gz`;
  console.log(`[mac] 下载宿主：${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}（检查网络）`);
  fs.mkdirSync(cacheDir, { recursive: true });
  const tgz = path.join(cacheDir, `node-${nodeVer}-darwin-${arch}.tar.gz`);
  fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));

  // 解包 bin/node：优先系统 bsdtar（Win10+ 自带 tar.exe），零依赖
  // （node 官方 tar 包根目录为 node-v<ver>-darwin-<arch>/）
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32\\tar.exe') : 'tar';
  const rootPrefix = `node-${nodeVer}-darwin-${arch}`;
  execFileSync(tar, ['-xzf', tgz, '-C', cacheDir, `${rootPrefix}/bin/node`], { stdio: 'pipe' });
  fs.rmSync(tgz, { force: true });
  fs.renameSync(path.join(cacheDir, rootPrefix, 'bin/node'), cached);
  fs.rmSync(path.join(cacheDir, rootPrefix), { recursive: true, force: true });
  return cached;
}

for (const arch of macArchs) {
  const a = arch.replace('mac-', '');
  console.log(`\n[mac] 构建 macOS ${a} 版…`);
  const hostBin = await getDarwinNode(a);
  const appDir = path.join(DIST, `CoAgent.app`);
  const macosDir = path.join(appDir, 'Contents', 'MacOS');
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.mkdirSync(macosDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'Contents', 'Info.plist'), INFO_PLIST(PKG.version));
  fs.mkdirSync(path.join(appDir, 'Contents', 'Resources'), { recursive: true });
  fs.copyFileSync(path.join(DIST, 'icon.icns'), path.join(appDir, 'Contents', 'Resources', 'coagent.icns'));
  fs.writeFileSync(path.join(DIST, '首次使用说明.txt'), MAC_README(a));

  const macBin = path.join(macosDir, 'CoAgent');
  fs.copyFileSync(hostBin, macBin);
  fs.chmodSync(macBin, 0o755);
  await postject.inject(macBin, 'NODE_SEA_BLOB', fs.readFileSync(path.join(DIST, 'sea-prep.blob')), {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    overwrite: true,
  });

  // 组装 zip（bsdtar -a 按扩展名产出 zip）
  const zipName = `coagent-macos-${a}.zip`;
  const zipPath = path.join(DIST, zipName);
  fs.rmSync(zipPath, { force: true });
  execFileSync(process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32\\tar.exe') : 'tar',
    ['-a', '-c', '-f', zipPath, 'CoAgent.app', '首次使用说明.txt'],
    { cwd: DIST, stdio: 'pipe' });
  const mb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
  console.log(`[mac] 完成 → dist/${zipName}（${mb} MB）· 首次运行需按说明做一次 ad-hoc 签名`);
}
if (macArchs.length) {
  console.log('\n提示：macOS 包未做 Apple 公证，zip 内「首次使用说明.txt」含一条签名命令；Windows exe 可直接分发。');
}
console.log('\n完成。产物在 dist/：Windows 直接双击；目标机无需安装 Node。');
