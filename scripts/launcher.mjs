/**
 * CoAgent 主页面（launcher）—— 双击 exe 永远先到这里，像打开微信一样先见首页。
 *
 * 主页面（仅绑定 127.0.0.1 的迷你服务，应用窗口打开）提供：
 *   🚀 启动我的 Hub        —— 这台电脑当主机，本进程内拉起完整 Hub 后导航进面板
 *   🤝 加入已有的组        —— 填 Hub 地址 + token，校验后导航进已登录的面板，
 *                             并在桌面创建带参数的快捷方式
 *   🔗 已加入的组（若有）   —— 一键进入 / 解除绑定
 *   📘 使用教程            —— 跳转到面板内置的协作教程
 *
 * 角色选择写入 data/launcher.json 供主页面渲染状态；「退出服务」在面板顶栏。
 *
 * @module launcher
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { openAppWindow, createDesktopShortcut } from './app-window.mjs';

// 注意：本模块绝不能静态 import config.js —— sea-entry 静态依赖本模块，
// 会在 serve 的 --port 环境变量注入之前把 config 初始化成默认端口。
// 状态文件路径一律由调用方（sea-entry / serve）显式传入。

/** @returns {{mode?: 'host'|'join', hub?: string, token?: string}|null} */
export function readLauncherState(stateFile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

/** @param {string} stateFile @param {{mode?: 'host'|'join', hub?: string, token?: string}} state */
export function saveLauncherState(stateFile, state) {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch { /* 状态记忆是便利项，失败不影响主流程 */ }
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * 主页面。state 决定「加入的组」卡片是否显示与内容。
 */
function homePage(version, state) {
  const joined = state?.mode === 'join' && state?.hub;
  const joinedCard = joined
    ? `
  <div class="card">
    <h2>🤝 已加入的组</h2>
    <p style="word-break:break-all">Hub：${esc(state.hub)}</p>
    <div style="display:flex;gap:8px">
      <button onclick="enterJoined()" style="flex:1">进入组</button>
      <button class="ghost" style="flex:1" onclick="unbind()">解除绑定</button>
    </div>
  </div>`
    : `
  <div class="card">
    <h2>🤝 加入已有的组</h2>
    <p>填入主机同学给你的 Hub 地址和接入 token（接入卡片上有），进入后自动在桌面创建快捷方式，以后双击图标直达。</p>
    <div id="join-form">
      <input id="hub" placeholder="Hub 地址，如 http://192.168.1.10:8787">
      <input id="token" placeholder="接入 Token，如 tok_xxxxxxxx" type="password">
      <button class="ghost" onclick="join()">加入组</button>
    </div>
    <div class="msg" id="join-msg"></div>
  </div>`;

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<link rel="icon" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20512%20512%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%220%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%232bd86a%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23059f4c%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22512%22%20height%3D%22512%22%20rx%3D%22118%22%20fill%3D%22url(%23g)%22%2F%3E%3Cpath%20d%3D%22M96%20164%20a52%2052%200%200%201%2052%20-52%20h216%20a52%2052%200%200%201%2052%2052%20v140%20a52%2052%200%200%201%20-52%2052%20h-166%20l-68%2074%2020%20-74%20h-2%20a52%2052%200%200%201%20-52%20-52%20z%22%20fill%3D%22%23fff%22%2F%3E%3Cpath%20d%3D%22M186%20316%20L198%20208%20L250%20262%20L276%20198%20L302%20262%20L354%20208%20L366%20316%20Z%22%20fill%3D%22%2307c160%22%2F%3E%3Crect%20x%3D%22186%22%20y%3D%22316%22%20width%3D%22180%22%20height%3D%2224%22%20rx%3D%228%22%20fill%3D%22%2307c160%22%2F%3E%3C%2Fsvg%3E">
<title>CoAgent Hub · 主页</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: #ededed; color: #191919;
         min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .wrap { width: 560px; max-width: 92vw; }
  .logo { text-align: center; font-size: 40px; margin-bottom: 6px; }
  h1 { text-align: center; font-size: 20px; }
  .sub { text-align: center; color: #6b6f76; font-size: 13px; margin: 6px 0 22px; }
  .card { background: #fff; border: 1px solid #e5e6eb; border-radius: 14px; padding: 18px 20px; margin-bottom: 14px; }
  .card h2 { font-size: 15px; margin-bottom: 4px; }
  .card p { color: #6b6f76; font-size: 12px; margin-bottom: 12px; line-height: 1.6; }
  button { background: #238636; border: 0; color: #fff; font-size: 14px; font-weight: 600;
           padding: 9px 18px; border-radius: 8px; cursor: pointer; width: 100%; }
  button.ghost { background: transparent; border: 1px solid #30363d; }
  button:hover { filter: brightness(1.15); }
  input { width: 100%; background: #f5f6f7; border: 1px solid #d9dbde; color: #191919;
          border-radius: 8px; padding: 9px 12px; font-size: 13px; margin-bottom: 10px; }
  input:focus { outline: 1px solid #238636; }
  .msg { font-size: 12px; margin-top: 10px; min-height: 16px; }
  .ok { color: #3fb950; } .err { color: #f85149; }
  .foot { text-align: center; margin-top: 14px; }
  .foot a { color: #58a6ff; font-size: 12px; text-decoration: none; }
  .ver { text-align: center; color: #484f58; font-size: 11px; margin-top: 10px; }
</style></head><body>
<div class="wrap">
  <div class="logo">👑</div>
  <h1>CoAgent Hub <span style="color:#8b949e;font-size:13px">${esc(version)}</span></h1>
  <p class="sub">多 Agent 协同开发中枢 · 你想做什么？</p>

  <div class="card">
    <h2>🚀 启动我的 Hub（这台电脑当主机）</h2>
    <p>在本机启动协作中枢，同学们连过来一起开发。启动后可以从面板顶栏随时退出服务。</p>
    <button onclick="startHost()">启动 Hub 服务</button>
    <div class="msg" id="host-msg"></div>
  </div>

  ${joinedCard}

  <div class="foot"><a href="#" onclick="goTutorial()">📘 第一次用？看两分钟协作教程</a></div>
  <div class="ver">命令行依旧可用：coagent.exe serve / app / init / sync / push …</div>
</div>
<script>
async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error(data.error?.message || ('HTTP ' + r.status));
  return data;
}
async function startHost() {
  const el = document.getElementById('host-msg');
  el.className = 'msg ok'; el.textContent = '正在启动…';
  try {
    // token 由本进程的 startHost 回调直接给出（不经 HTTP 传输）；
    // 用 URL fragment 带进面板，fragment 不会进服务器日志，也不留在浏览器历史。
    const { url, token } = await post('/launcher/host');
    el.textContent = '✓ 已启动，正在进入面板…';
    setTimeout(() => {
      location.href = url + '/panel' + (token ? '#token=' + encodeURIComponent(token) : '');
    }, 600);
  } catch (e) { el.className = 'msg err'; el.textContent = '✗ ' + e.message; }
}
function enterJoined() { location.href = ${JSON.stringify(joined ? `${state.hub}/panel#token=${encodeURIComponent(state.token || '')}` : '')} || '/launcher'; }
async function unbind() {
  await post('/launcher/unbind');
  location.reload();
}
async function join() {
  const el = document.getElementById('join-msg');
  const hub = document.getElementById('hub').value.trim().replace(/\\/+$/, '');
  const token = document.getElementById('token').value.trim();
  if (!hub || !token) { el.className = 'msg err'; el.textContent = '✗ 地址和 token 都要填'; return; }
  el.className = 'msg ok'; el.textContent = '正在连接…';
  try {
    const { shortcut } = await post('/launcher/join', { hub, token });
    document.getElementById('join-form').innerHTML =
      '<p class="ok" style="font-size:13px">✓ 已加入！正在进入应用，桌面快捷方式' +
      (shortcut ? '已创建' : '未创建（可手动用 app 命令）') + '。</p>';
    setTimeout(() => { location.href = hub + '/panel#token=' + encodeURIComponent(token); }, 900);
  } catch (e) { el.className = 'msg err'; el.textContent = '✗ ' + e.message; }
}
function goTutorial() { location.href = '/launcher/tutorial'; }
</script>
</body></html>`;
}

/** 内置协作教程（主页面直接可看，无需登录） */
function tutorialPage(version) {
  const step = (n, title, body) =>
    `<div class="step"><div class="num">${n}</div><div><div class="st">${title}</div><div class="sb">${body}</div></div></div>`;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<link rel="icon" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20512%20512%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%220%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%232bd86a%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23059f4c%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22512%22%20height%3D%22512%22%20rx%3D%22118%22%20fill%3D%22url(%23g)%22%2F%3E%3Cpath%20d%3D%22M96%20164%20a52%2052%200%200%201%2052%20-52%20h216%20a52%2052%200%200%201%2052%2052%20v140%20a52%2052%200%200%201%20-52%2052%20h-166%20l-68%2074%2020%20-74%20h-2%20a52%2052%200%200%201%20-52%20-52%20z%22%20fill%3D%22%23fff%22%2F%3E%3Cpath%20d%3D%22M186%20316%20L198%20208%20L250%20262%20L276%20198%20L302%20262%20L354%20208%20L366%20316%20Z%22%20fill%3D%22%2307c160%22%2F%3E%3Crect%20x%3D%22186%22%20y%3D%22316%22%20width%3D%22180%22%20height%3D%2224%22%20rx%3D%228%22%20fill%3D%22%2307c160%22%2F%3E%3C%2Fsvg%3E">
<title>CoAgent Hub · 协作教程</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: #ededed; color: #191919; padding: 28px 0 60px; }
  .wrap { width: 680px; max-width: 92vw; margin: 0 auto; }
  h1 { font-size: 20px; text-align: center; }
  .sub { text-align: center; color: #6b6f76; font-size: 13px; margin: 6px 0 24px; }
  h2 { font-size: 15px; color: #58a6ff; margin: 26px 0 10px; border-bottom: 1px solid #21262d; padding-bottom: 6px; }
  .card { background: #fff; border: 1px solid #e5e6eb; border-radius: 12px; padding: 14px 18px; margin-bottom: 12px; }
  .step { display: flex; gap: 12px; margin: 10px 0; }
  .num { width: 24px; height: 24px; border-radius: 50%; background: #238636; color: #fff; display: flex;
         align-items: center; justify-content: center; font-weight: 700; font-size: 12px; flex-shrink: 0; }
  .st { font-size: 13px; font-weight: 600; }
  .sb { font-size: 12px; color: #6b6f76; line-height: 1.7; margin-top: 2px; }
  .sb code { background: #0d1117; border: 1px solid #30363d; border-radius: 4px; padding: 1px 5px; font-size: 11px; }
  ul { padding-left: 18px; font-size: 12px; color: #6b6f76; line-height: 1.9; }
  .ver { text-align: center; color: #484f58; font-size: 11px; margin-top: 24px; }
</style></head><body>
<div class="wrap">
  <h1>📘 CoAgent 协作教程</h1>
  <p class="sub">两分钟学会：一个小组怎么用它共同开发一个项目</p>

  <h2>先认识三个角色</h2>
  <div class="card"><ul>
    <li><b style="color:#e6edf3">主机（群主）</b>：启动 Hub 服务的那台电脑，项目的代码仓、任务板、聊天都存在这里。</li>
    <li><b style="color:#e6edf3">同学（成员）</b>：用自己的电脑连过来，各写各的代码（每人一条私有分支），互不打架。</li>
    <li><b style="color:#e6edf3">Agent</b>：同学使用的本地 AI 工具（Codex / Claude Code / Zcode …），每个工具一个账号，用命令行或 SDK 干活。</li>
  </ul></div>

  <h2>主机：三步开组</h2>
  ${step(1, '双击 exe，点「启动 Hub 服务」', '本机成为主机；把打印出来的局域网地址发给同学（跨网络建议全员装 Tailscale）。')}
  ${step(2, '进入「接入向导」页', '先一键轮换种子 token（安全检查），再给每个同学开户，生成接入卡片。')}
  ${step(3, '把接入卡片发给同学', '卡片里有 Hub 地址和 token，同学的 agent 自助接入也可以直接 fetch <code>/guide</code>。')}

  <h2>同学：三步加群</h2>
  ${step(1, '双击 exe，点「加入已有的组」', '填入接入卡片上的 Hub 地址和 token。')}
  ${step(2, '自动进入应用并登录', '桌面同时创建「CoAgent Hub」快捷方式，以后双击图标直达。')}
  ${step(3, '让 agent 开工', '在项目目录执行 <code>init</code>（首次拉代码）→ <code>sync</code>（开工）→ <code>push</code>（收工）。')}

  <h2>每天的协作节奏</h2>
  <div class="card"><ul>
    <li><b style="color:#e6edf3">开工</b>：看「任务板」认领任务，或去「消息」页打个招呼同步进度。</li>
    <li><b style="color:#e6edf3">干活</b>：在<strong>自己的私有分支</strong>上写代码（<code>dev/你的ID</code>），写完 <code>push</code> 上来。</li>
    <li><b style="color:#e6edf3">上墙</b>：重要的决定 / 进度 / 阻塞写进「共享上下文」，全组可见，还支持语义搜索。</li>
    <li><b style="color:#e6edf3">合码</b>：代码进 main 必须走「审核」——另一位同学批准后才能合并，禁止自审。</li>
    <li><b style="color:#e6edf3">收工</b>：主机在面板顶栏点 ⏻ 退出服务；同学直接关窗口，下次双击图标接着来。</li>
  </ul></div>

  <h2>常见问题</h2>
  <div class="card"><ul>
    <li><b style="color:#e6edf3">连不上主机？</b>检查地址、主机是否在线、Windows 防火墙是否放行端口；不在同一网络就全员装 Tailscale。</li>
    <li><b style="color:#e6edf3">token 丢了？</b>找管理员在「用户管理」页轮换一个新 token，旧的立即失效。</li>
    <li><b style="color:#e6edf3">数据在哪里？</b>主机 exe 同目录的 <code>data\\</code> 文件夹，整个文件夹拷走就是备份/迁移。</li>
    <li><b style="color:#e6edf3">不用了怎么删？</b>Windows「设置 → 应用 → 安装的应用」里找到 CoAgent Hub 卸载，会清掉快捷方式和数据。</li>
  </ul></div>

  <div class="ver">CoAgent Hub ${esc(version)} · 详细文档见 <a style="color:#58a6ff" href="#" onclick="location.href='/launcher'">返回主页</a></div>
</div>
</body></html>`;
}

/** 读 POST 的 JSON 主体 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 启动主页面服务（仅绑定 127.0.0.1）并弹出应用窗口。
 * 「启动 Hub」通过 opts.startHost 回调在本进程内拉起完整 Hub（由 sea-entry 注入，避免循环引用）。
 * @param {{version: string, stateFile: string, startHost: () => Promise<{url: string, token?: string|null}>}} opts
 */
export async function runLauncher(opts) {
  const server = http.createServer(async (req, res) => {
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(body);
    };
    try {
      if (req.method === 'GET' && req.url === '/launcher') {
        return send(200, homePage(opts.version, readLauncherState(opts.stateFile)), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && req.url === '/launcher/tutorial') {
        return send(200, tutorialPage(opts.version), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && req.url === '/launcher/state') {
        return send(200, JSON.stringify(readLauncherState() ?? {}));
      }
      if (req.method === 'POST' && req.url === '/launcher/host') {
        saveLauncherState(opts.stateFile, { mode: 'host' });
        const { url, token } = await opts.startHost(); // 回调由 sea-entry 注入（避免循环引用）
        // SEA exe 环境下创建桌面快捷方式（源码模式 execPath 是 node，跳过）
        const shortcut = process.env.COAGENT_ENTRY === 'sea'
          ? createDesktopShortcut({ name: 'CoAgent Hub', target: process.execPath, workingDir: path.dirname(process.execPath) })
          : false;
        return send(200, JSON.stringify({ ok: true, url, token: token ?? null, shortcut }));
      }
      if (req.method === 'POST' && req.url === '/launcher/join') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const hub = String(body.hub ?? '').trim().replace(/\/+$/, '');
        const token = String(body.token ?? '').trim();
        if (!/^https?:\/\//.test(hub)) {
          return send(400, JSON.stringify({ error: { message: '地址要以 http:// 或 https:// 开头' } }));
        }
        // 校验远端可达 + token 有效（面板登录只需 token）。
        // 目标是局域网内的主机 / Tailscale 虚拟 IP——这正是本产品的设计场景，
        // 因此协议白名单（http/https）之外，不做私网阻断。
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 4000);
          const h = await fetch(`${hub}/healthz`, { signal: ctrl.signal });
          if (!h.ok) throw new Error(`Hub 响应异常（HTTP ${h.status}）`);
          const me = await fetch(`${hub}/me`, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
          clearTimeout(timer);
          if (!me.ok) throw new Error('token 无效（检查接入卡片是否复制完整）');
        } catch (err) {
          return send(400, JSON.stringify({ error: { message: `连不上或验证失败：${err?.message ?? err}` } }));
        }
        saveLauncherState(opts.stateFile, { mode: 'join', hub, token });
        createDesktopShortcut({
          name: 'CoAgent Hub',
          target: process.execPath,
          icon: extractAppIcon(),
          args: `app --hub ${hub} --token ${token}`,
          workingDir: path.dirname(process.execPath),
        });
        openAppWindow(`${hub}/panel#token=${encodeURIComponent(token)}`);
        return send(200, JSON.stringify({ ok: true, shortcut: true }));
      }
      if (req.method === 'POST' && req.url === '/launcher/unbind') {
        try { fs.rmSync(opts.stateFile, { force: true }); } catch { /* 忽略 */ }
        return send(200, JSON.stringify({ ok: true }));
      }
      send(404, JSON.stringify({ error: { message: 'not found' } }));
    } catch (err) {
      send(500, JSON.stringify({ error: { message: String(err?.message ?? err) } }));
    }
  });

  // 只绑定回环：主页面的接口不应对局域网开放
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  process.env.COAGENT_LAUNCHER_PORT = String(port);
  openAppWindow(`http://127.0.0.1:${port}/launcher`, { width: 720, height: 860 });
  return { port };
}
