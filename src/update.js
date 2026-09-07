/**
 * 应用自更新（微信式：检查 → 下载 → 自替换 → 重启）。
 *
 * 更新源：GitHub Releases（本仓库），无需额外基础设施。
 * 替换原理：Windows/macOS 都允许对运行中的可执行文件 rename（只锁删除不锁改名）——
 *   当前二进制 → *.old（回滚备份），新版落位 → 由调用方拉起新进程 → 本进程优雅退出。
 * macOS：下载 zip → 纯 Node 极简 ZIP 解析（zlib.inflateRawSync，无外部命令）→ 替换
 *   .app 内二进制。替换后 ad-hoc 签名失效：**macOS 用户首次打开需重跑一次签名命令**
 *   （与首次安装相同，见 Release 说明）。
 * 源码模式（npm start）不支持自更新，提示 git pull。
 *
 * 安全边界：
 *  - 更新包文件名来自代码内固定白名单（不含任何 HTTP 输入）；
 *  - 版本号必须通过严格格式校验后才参与任何路径/URL 拼接；
 *  - 所有动态路径统一 resolve() + 根目录边界校验；
 *  - 本模块为纯文件操作，不做任何子进程调用（新进程由 scripts/app-window.mjs 拉起）。
 *
 * @module update
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { PATHS } from './config.js';

const REPO = 'ohGGBob/coagent-hub';
const DOWNLOAD_TIMEOUT_MS = 120_000;
const CACHE_MS = 10 * 60 * 1000;
const MAX_ZIP_ENTRY = 200 * 1024 * 1024;

/** 更新工作目录：module 级固定，且必须落在数据目录内（边界校验一次，后续引用） */
const UPDATE_DIR = (() => {
  const dir = path.resolve(PATHS.data, 'update-tmp');
  const dataRoot = path.resolve(PATHS.data);
  if (dir !== dataRoot && !dir.startsWith(dataRoot + path.sep)) throw new Error('更新目录配置越界');
  return dir;
})();

/** @param {string} p p 是否落在 UPDATE_DIR 内 */
const inUpdateDir = (p) => {
  const r = path.resolve(p);
  return r === UPDATE_DIR || r.startsWith(UPDATE_DIR + path.sep);
};

let cache = { at: 0, data: null };
let applying = false;

const isSEA = () => process.env.COAGENT_ENTRY === 'sea';
const platformKey = () =>
  process.platform === 'win32' ? 'win-x64'
    : process.platform === 'darwin' ? (process.arch === 'arm64' ? 'macos-arm64' : 'macos-x64')
      : null;

/** 语义化版本比较：a > b 返回 1 */
export function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0) ? 1 : -1;
  }
  return 0;
}

/**
 * 查询最新版本（10 分钟缓存；离线/超时返回 available:false + offline:true）。
 * @param {string} currentVersion
 */
export async function checkLatest(currentVersion) {
  const supported = isSEA() && platformKey() !== null;
  if (cache.data && Date.now() - cache.at < CACHE_MS) {
    return { ...cache.data, current: currentVersion, supported };
  }
  let result = { available: false, latest: null, notes: null, offline: false };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'coagent-hub' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const j = await res.json();
      const latest = String(j.tag_name ?? '').replace(/^v/, '');
      // 严格格式校验后才允许向下传递（URL/文件名拼接的安全前提）
      if (/^\d+\.\d+\.\d+$/.test(latest)) {
        result = {
          available: compareVersions(latest, currentVersion) > 0,
          latest,
          notes: typeof j.html_url === 'string' ? j.html_url : null,
          offline: false,
        };
      }
    } else {
      result.offline = true;
    }
  } catch {
    result.offline = true;
  }
  cache = { at: Date.now(), data: result };
  return { ...result, current: currentVersion, supported };
}

/** 平台对应的 Release 资产文件名（固定白名单，唯一合法的更新包名来源） */
function assetName() {
  const k = platformKey();
  return k === 'win-x64' ? 'coagent-win-x64.exe'
    : k === 'macos-arm64' ? 'coagent-macos-arm64.zip'
      : k === 'macos-x64' ? 'coagent-macos-x64.zip' : null;
}

/** 下载更新包到固定工作目录，返回本地文件路径（含边界校验） */
async function downloadAsset(url, name) {
  // 名称必须命中固定白名单（唯一来源是 assetName()，不含任何外部输入）
  if (!/^(coagent-win-x64\.exe|coagent-macos-arm64\.zip|coagent-macos-x64\.zip)$/.test(name)) {
    throw new Error('非法的更新包文件名');
  }
  fs.mkdirSync(UPDATE_DIR, { recursive: true });
  const file = path.resolve(UPDATE_DIR, name);
  if (!inUpdateDir(file)) throw new Error('非法的下载路径');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
  const res = await fetch(url, { signal: ctrl.signal });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  clearTimeout(timer);
  return file;
}

/**
 * 极简 ZIP 单文件提取（纯 Node，零依赖零子进程）：
 * 解析 End of Central Directory → 定位目标条目 → inflateRaw 解压。
 * 只接受「精确等于 entryName 的单个文件条目」，尺寸上限 MAX_ZIP_ENTRY。
 */
function extractZipEntry(zipPath, entryName, outPath) {
  const buf = fs.readFileSync(zipPath);
  // 从尾部搜索 EOCD 签名 0x06054b50（注释最长 65535）
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('更新包不是有效的 zip');
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16); // central directory 偏移
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error('更新包目录损坏');
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    if (name === entryName) {
      // 本地文件头：跳过其名称/扩展字段拿到数据区
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataOff = localOff + 30 + lNameLen + lExtraLen;
      if (compSize > MAX_ZIP_ENTRY) throw new Error('更新包条目过大');
      const comp = buf.subarray(dataOff, dataOff + compSize);
      const data = method === 0 ? Buffer.from(comp) : zlib.inflateRawSync(comp);
      if (!inUpdateDir(outPath)) throw new Error('非法的解压路径');
      fs.writeFileSync(outPath, data);
      return;
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('更新包内容异常（未找到目标文件）');
}

/**
 * 应用更新：下载 → 自替换。替换完成后返回新二进制路径，
 * 由调用方拉起新进程并结束本进程（见 scripts/app-window.mjs 的 spawnDetached）。
 * 只能在 SEA 环境调用。
 * @param {string} currentVersion
 * @returns {Promise<{replacing: boolean, newBinary: string, version: string, macNote: boolean}>}
 */
export async function applyUpdate(currentVersion) {
  if (applying) throw new Error('已有更新正在进行');
  if (!isSEA()) throw new Error('源码模式不支持自更新，请 git pull 后重新启动');
  const platform = platformKey();
  if (!platform) throw new Error(`暂不支持的平台：${process.platform}/${process.arch}`);

  const check = await checkLatest(currentVersion);
  if (!check.available || !check.latest) throw new Error(check.offline ? '检查更新失败（网络不可达）' : '已是最新版本');
  applying = true;

  const asset = assetName();
  const url = `https://github.com/${REPO}/releases/download/v${check.latest}/${asset}`;
  const downloaded = await downloadAsset(url, asset);
  const exePath = process.execPath;
  let macNote = false;

  if (process.platform === 'win32') {
    // 运行中的 exe 可改名：当前 → .old（回滚备份），新版落位
    fs.renameSync(exePath, exePath + '.old');
    try {
      fs.copyFileSync(downloaded, exePath);
    } catch (err) {
      fs.renameSync(exePath + '.old', exePath); // 回滚
      throw new Error('新版落位失败：' + err.message);
    }
  } else if (process.platform === 'darwin') {
    const target = path.resolve(UPDATE_DIR, 'CoAgent.new');
    if (!inUpdateDir(target)) throw new Error('非法的解压路径');
    extractZipEntry(downloaded, 'CoAgent.app/Contents/MacOS/CoAgent', target);
    fs.chmodSync(target, 0o755);
    fs.renameSync(exePath, exePath + '.old');
    try {
      fs.copyFileSync(target, exePath);
      fs.chmodSync(exePath, 0o755);
    } catch (err) {
      fs.renameSync(exePath + '.old', exePath);
      throw new Error('新版落位失败：' + err.message);
    }
    macNote = true; // 签名失效，首次打开需重跑一次签名命令（同首次安装）
  } else {
    throw new Error('暂不支持的平台');
  }

  // 清理下载残留（延迟执行，避免文件占用）
  setTimeout(() => { try { fs.rmSync(UPDATE_DIR, { recursive: true, force: true }); } catch { /* 忽略 */ } }, 5000).unref();

  return { replacing: true, newBinary: exePath, version: check.latest, macNote };
}

/** 启动时清理上次更新留下的回滚备份 */
export function cleanupOldBinary(exePath) {
  const old = exePath + '.old';
  try {
    if (fs.existsSync(old)) fs.rmSync(old, { force: true });
  } catch { /* 忽略 */ }
}
