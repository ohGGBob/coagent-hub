/**
 * 开机自启（零第三方依赖）。
 *
 * Windows：HKCU\Software\Microsoft\Windows\CurrentVersion\Run 写注册表，
 *   Run 值指向「exe serve --autostart」；卸载时删除该值。
 * macOS：~/Library/LaunchAgents/com.coagent.hub.plist（LaunchAgent）。
 * 非 SEA 打包环境（源码跑 node）不支持自启——exe 路径才有意义。
 *
 * @module autostart
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** 注册表值名 / LaunchAgent 标签 */
export const AUTOSTART_NAME = 'CoAgentHub';

/** 当前是否支持开机自启（仅 SEA 单文件应用 + Windows/macOS） */
export function supported() {
  return process.env.COAGENT_ENTRY === 'sea' && (process.platform === 'win32' || process.platform === 'darwin');
}

/** 启动命令（自启触发时直接进 serve，跳过主页面） */
function autostartCommand() {
  const exe = process.execPath;
  if (process.platform === 'win32') {
    return `"${exe}" serve --autostart`;
  }
  // macOS：包内可执行文件路径
  return `"${exe}" serve --autostart`;
}

/** 查询自启状态 */
export function getAutostart() {
  if (!supported()) {
    return { supported: false, enabled: false, platform: process.platform, reason: '仅打包版（exe/.app）支持开机自启' };
  }
  let enabled = false;
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', AUTOSTART_NAME], { encoding: 'utf8' });
      enabled = out.includes(AUTOSTART_NAME);
    } else {
      enabled = fs.existsSync(launchAgentPath());
    }
  } catch {
    enabled = false;
  }
  return { supported: true, enabled, platform: process.platform };
}

/** 设置 / 取消开机自启 */
export function setAutostart(enabled) {
  if (!supported()) {
    throw new Error(getAutostart().reason);
  }
  if (process.platform === 'win32') {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
    if (enabled) {
      execFileSync('reg', ['add', key, '/v', AUTOSTART_NAME, '/t', 'REG_SZ', '/d', autostartCommand(), '/f'], { stdio: 'ignore' });
    } else {
      try { execFileSync('reg', ['delete', key, '/v', AUTOSTART_NAME, '/f'], { stdio: 'ignore' }); } catch { /* 值不存在也视为成功 */ }
    }
    return { supported: true, enabled, platform: 'win32' };
  }
  // macOS LaunchAgent
  const plistPath = launchAgentPath();
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  if (enabled) {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.coagent.hub</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>serve</string>
    <string>--autostart</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict>
</plist>
`;
    fs.writeFileSync(plistPath, plist);
  } else {
    try { fs.rmSync(plistPath, { force: true }); } catch { /* 忽略 */ }
  }
  return { supported: true, enabled, platform: 'darwin' };
}

/** 卸载时清除自启（静默，失败不阻塞卸载） */
export function clearAutostart() {
  try { setAutostart(false); } catch { /* 忽略 */ }
}

/** macOS LaunchAgent 路径 */
function launchAgentPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.coagent.hub.plist');
}
