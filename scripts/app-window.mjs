/**
 * 应用窗口与桌面快捷方式工具（主机 serve 与同学 app 模式共用）。
 *
 * 应用窗口 = Edge/Chrome 的 --app 模式：无地址栏、任务栏独立图标，
 * 视觉上等同桌面应用，且不引入任何依赖、exe 仍是单文件。
 * 找不到 Edge/Chrome 时回退系统默认浏览器（普通标签页）。
 *
 * @module app-window
 */

import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const cp = childProcess;

/** 按 Edge → Chrome 顺序找本机浏览器可执行文件（Win10/11 自带 Edge） */
function findAppBrowser() {
  if (process.platform !== 'win32') return null;
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
  ];
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch { /* 忽略 */ }
  }
  return null;
}

/**
 * 以「应用窗口」形态打开 URL。
 * @param {string} url
 * @param {{width?: number, height?: number}} [size]
 * @returns {'app'|'browser'|null} 实际打开方式（null = 全部失败）
 */
export function openAppWindow(url, { width = 1280, height = 860 } = {}) {
  const browser = findAppBrowser();
  try {
    if (browser) {
      cp.spawn(browser, [`--app=${url}`, `--window-size=${width},${height}`], { detached: true, stdio: 'ignore' }).unref();
      return 'app';
    }
    const cmd = process.platform === 'win32' ? `start "" "${url}"`
      : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    cp.exec(cmd, { shell: true });
    return 'browser';
  } catch {
    return null;
  }
}

/**
 * 创建桌面快捷方式（Windows，经 PowerShell WScript.Shell COM）。
 * 失败静默——快捷方式是便利项，不是功能前提。
 * @param {{name: string, target: string, args?: string, workingDir?: string}} opts
 * @returns {boolean} 是否创建成功（已存在视为成功）
 */
export function createDesktopShortcut({ name, target, args = '', workingDir = '' }) {
  if (process.platform !== 'win32') return false;
  try {
    const desktop = path.join(process.env.USERPROFILE ?? '', 'Desktop');
    const lnk = path.join(desktop, `${name}.lnk`);
    if (fs.existsSync(lnk)) return true; // 已存在，不覆盖
    const ps =
      `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${lnk}');` +
      `$s.TargetPath = '${target}';` +
      (args ? `$s.Arguments = '${args.replace(/'/g, "''")}';` : '') +
      (workingDir ? `$s.WorkingDirectory = '${workingDir}';` : '') +
      '$s.Save()';
    const r = cp.spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8', timeout: 15_000 });
    return r.status === 0 && fs.existsSync(lnk);
  } catch {
    return false;
  }
}

/**
 * 单实例检测：探测 localhost:port 是否已有 CoAgent Hub 在跑。
 * @param {number} port
 * @returns {Promise<boolean>} true = 已在运行（调用方直接弹窗退出）
 */
export async function isHubAlreadyRunning(port) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 600);
    const res = await fetch(`http://localhost:${port}/healthz`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const body = await res.json();
    return typeof body?.version === 'string' && body?.ok === true;
  } catch {
    return false;
  }
}
