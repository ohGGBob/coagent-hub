/**
 * Windows「安装应用」注册与卸载（让 CoAgent 出现在 设置 → 应用 → 安装的应用）。
 *
 * 原理：写 HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\CoAgentHub
 * 注册表项（无需管理员权限）， DisplayName / UninstallString 指向
 * `coagent.exe uninstall`。仅 SEA exe 环境调用（源码模式无意义）。
 *
 * @module install-reg
 */

import childProcess from 'node:child_process';

const cp = childProcess;
const REG_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CoAgentHub';

function ps(script, timeout = 15_000) {
  const r = cp.spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    timeout,
  });
  return r.status === 0;
}

/**
 * 注册到「安装的应用」列表。失败静默（不影响使用）。
 * @param {{exePath: string, version: string, displayName?: string}} opts
 */
export function registerInstall({ exePath, version, displayName = 'CoAgent Hub' }) {
  if (process.platform !== 'win32') return false;
  const q = (s) => String(s).replace(/'/g, "''");
  return ps(
    `New-Item -Path '${REG_KEY}' -Force | Out-Null;` +
    `Set-ItemProperty -Path '${REG_KEY}' -Name 'DisplayName' -Value '${q(displayName)}';` +
    `Set-ItemProperty -Path '${REG_KEY}' -Name 'DisplayVersion' -Value '${q(version)}';` +
    `Set-ItemProperty -Path '${REG_KEY}' -Name 'Publisher' -Value 'CoAgent';` +
    `Set-ItemProperty -Path '${REG_KEY}' -Name 'DisplayIcon' -Value '${q(exePath)}';` +
    `Set-ItemProperty -Path '${REG_KEY}' -Name 'InstallLocation' -Value '${q(exePath.replace(/\\[^\\]+$/, ''))}';` +
    `Set-ItemProperty -Path '${REG_KEY}' -Name 'UninstallString' -Value '"${q(exePath)}" uninstall';` +
    `Set-ItemProperty -Path '${REG_KEY}' -Name 'NoModify' -Value 1 -Type DWord;`,
  );
}

/** 从「安装的应用」列表移除注册。 */
export function unregisterInstall() {
  if (process.platform !== 'win32') return false;
  return ps(`Remove-Item -Path '${REG_KEY}' -Recurse -Force -ErrorAction SilentlyContinue;`);
}
