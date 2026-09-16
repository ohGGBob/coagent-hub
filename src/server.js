/**
 * Hub HTTP 服务（零第三方依赖，仅用 node:http）。
 *
 * 三条硬约束在本层落地：
 *  1. 每个写操作先经 store 落盘事件，再返回响应。
 *  2. 所有写路径强制 scope 校验；分支 / 上下文归属校验在这里做最后一道。
 *  3. `/ws` 仅占位返回 501 —— Phase 2 接 WebSocket 时事件订阅点已在 eventlog。
 *
 * @module server
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  PATHS, PORT, HUB_VERSION, ROOT, ensureDirs, privateBranch, PROTECTED_BRANCHES,
} from './config.js';
import { createEventLog } from './eventlog.js';
import { createContextStore } from './context.js';
import { createTaskStore } from './tasks.js';
import { createReviewStore } from './reviews.js';
import { createCommentStore } from './comments.js';
import { createFileStore } from './files.js';
import { createVectorStore } from './vectors.js';
import { probeEmbedder, embed, embedOne, embedStatus, embedConfig } from './embed.js';
import { checkLatest, applyUpdate } from './update.js';
import { loadUsers, verify, requireScope, createUser, listUsersPublic, rotateToken, deleteUser, setPersona, getBootstrapInfo, authenticate, emergencyReset } from './auth.js';
import { PERSONAS } from './personas.js';
import * as repo from './git-repo.js';
import { HubError, badRequest, notFound, newUpgradeRequired, forbidden } from './errors.js';
import { guideMarkdown } from './guide.js';
import { attachWebSocket } from './ws.js';
import { createWebhookStore } from './webhooks.js';
import * as license from './license.js';
import { appendAudit, recentAudit } from './audit.js';
import * as backup from './backup.js';
import * as autostart from './autostart.js';

const MAX_BODY = 128 * 1024 * 1024;

/** CORS 允许源：默认 *（开发友好），生产可通过 COAGENT_CORS_ORIGIN 限定 */
const CORS_ORIGIN = process.env.COAGENT_CORS_ORIGIN ?? '*';
/** 是否打印访问日志：默认开，设 COAGENT_ACCESS_LOG=0 关闭 */
const ACCESS_LOG = process.env.COAGENT_ACCESS_LOG !== '0';
/** 速率限制：每 IP 每分钟最多请求数（默认 600，设 0 关闭） */
const RATE_LIMIT = Number(process.env.COAGENT_RATE_LIMIT ?? 600);

/** 简易令牌桶速率限制（按 IP，每分钟重置） */
const rateBuckets = new Map();
function checkRateLimit(ip) {
  if (RATE_LIMIT <= 0) return true;
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.windowStart > 60_000) {
    rateBuckets.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  bucket.count++;
  return bucket.count <= RATE_LIMIT;
}
// 定期清理过期桶，防止内存泄漏
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of rateBuckets) {
    if (now - b.windowStart > 120_000) rateBuckets.delete(ip);
  }
}, 60_000).unref();

/** 进程级指标计数（/metrics 用） */
const metrics = {
  startedAt: new Date().toISOString(),
  requests: 0,
  requestsByStatus: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 },
  bytesIn: 0,
  bytesOut: 0,
  errors: 0,
};

/**
 * 结构化访问日志：一行一条，含方法/路径/状态/耗时/字节。
 * 生产环境可直接被 Loki / ELK 采集。
 */
function accessLog(req, res, start, bytesOut) {
  if (!ACCESS_LOG) return;
  const ms = Date.now() - start;
  const status = res.statusCode;
  const bucket = status >= 500 ? '5xx' : status >= 400 ? '4xx' : status >= 300 ? '3xx' : '2xx';
  metrics.requests++;
  metrics.requestsByStatus[bucket]++;
  metrics.bytesOut += bytesOut;
  const ua = String(req.headers['user-agent'] ?? '').slice(0, 60);
  console.log(
    `[hub] ${req.method} ${req.url} → ${status} ${ms}ms` +
    (bytesOut ? ` ${bytesOut}B` : '') +
    (ua ? `  "${ua}"` : ''),
  );
}

/**
 * 组装所有依赖并创建 HTTP 服务。
 * @returns {{server: import('node:http').Server, eventLog: any, context: any, tasks: any, reviews: any}}
 */
export function createHub() {
  ensureDirs();
  loadUsers();
  repo.ensureRepo();

  const eventLog = createEventLog();
  // 语义检索（Phase 3）：向量 sidecar + Ollama 嵌入，不可用时自动退回 BM25
  const vectors = createVectorStore();
  const context = createContextStore({
    eventLog,
    vectors,
    embedOne,
    embedModel: () => embedStatus().model,
  });
  const reviews = createReviewStore({
    eventLog,
    mergeFF: (branch, base) => repo.mergeFF(branch, base),
  });
  const tasks = createTaskStore({
    eventLog,
    getReview: (id) => {
      try {
        return reviews.get(id);
      } catch {
        return null;
      }
    },
  });

  // 评论系统（任务评论 + PR 评论）
  const comments = createCommentStore({
    eventLog,
    onTaskComment: (taskId, delta) => tasks.incComment(taskId, delta),
  });

  // 文件附件存储
  const files = createFileStore();

  // Webhook 通知（商用化集成层）：订阅事件日志，命中即异步投递
  const webhooks = createWebhookStore();
  webhooks.hookEvents(eventLog);

  // 授权与试用：启动时打印版别，供运维确认
  {
    const lic = license.current();
    if (lic.detail) console.warn(`[license] ${lic.label}：${lic.detail}`);
    else if (lic.trial) console.log(`[license] ${lic.label}（试用剩余 ${lic.trial.daysLeft} 天）`);
    else console.log(`[license] ${lic.label} · ${lic.org} · ${lic.seats} 席位 · 有效期至 ${lic.expiresAt}`);
  }

  // 启动后台回填：为缺向量的历史条目分批补嵌（Ollama 可用时才动手，任何失败静默）。
  // 每 5 分钟重查一次——Ollama 中途上线也能自动补齐。
  const EMBED_BATCH = 32;
  async function backfillVectors() {
    try {
      if (!embedStatus().available && !(await probeEmbedder()).available) return;
      for (;;) {
        const missing = context.missingEmbedTexts(EMBED_BATCH);
        if (!missing.length) break;
        const vecs = await embed(missing.map((m) => m.text));
        if (!vecs) break; // 服务中途不可用，等下轮
        missing.forEach((m, i) => vectors.append(m.id, vecs[i], embedStatus().model));
      }
    } catch { /* 回填失败不影响服务 */ }
  }
  backfillVectors();
  setInterval(() => { backfillVectors(); }, 300_000).unref();

  // 鉴权语义：scope === null 表示公开端点；'@auth' 表示需登录但不校验具体 scope。
  const PUBLIC = null;
  const AUTH_ONLY = '@auth';

  /** @type {Array<{method: string, re: RegExp, scope: string|null, handler: (c: any) => any}>} */
  const routes = [];

  const add = (method, re, scope, handler) => routes.push({ method, re, scope, handler });
  const dec = (s) => decodeURIComponent(s);

  /** 商用功能门控：未获授权的功能返回 403（试用期内自动放行） */
  const gate = (feature) => {
    if (!license.can(feature)) {
      throw new HubError(403, 'FEATURE_LOCKED', `「${feature}」为专业版功能，请在设置页激活授权`, { feature });
    }
  };

  // ---------- 公开端点 ----------
  // healthz 保持轻量：无鉴权端点不暴露用户清单，也不跑 git 子进程（避免被当放大器）
  add('GET', /^\/healthz$/, null, () => ({
    ok: true,
    version: HUB_VERSION,
    lastSeq: eventLog.lastSeq,
    uptimeSec: Math.floor((Date.now() - new Date(metrics.startedAt).getTime()) / 1000),
  }));

  // 轻量指标端点（Prometheus 文本格式，可直接被抓取）
  // 需登录：它会暴露用户数 / 分支数 / 事件序号等内部拓扑，不该对匿名访客开放
  add('GET', /^\/metrics$/, AUTH_ONLY, () => {
    const uptimeSec = Math.floor((Date.now() - new Date(metrics.startedAt).getTime()) / 1000);
    const lines = [
      `# HELP coagent_up 1 = Hub 正在运行`,
      `# TYPE coagent_up gauge`,
      `coagent_up 1`,
      `# HELP coagent_version Hub 版本`,
      `# TYPE coagent_version gauge`,
      `coagent_version{version="${HUB_VERSION}"} 1`,
      `# HELP coagent_uptime_seconds 运行时长（秒）`,
      `# TYPE coagent_uptime_seconds counter`,
      `coagent_uptime_seconds ${uptimeSec}`,
      `# HELP coagent_http_requests_total HTTP 请求总数`,
      `# TYPE coagent_http_requests_total counter`,
      `coagent_http_requests_total ${metrics.requests}`,
      `# HELP coagent_http_requests_by_status 按状态码分桶的请求数`,
      `# TYPE coagent_http_requests_by_status counter`,
      `coagent_http_requests_by_status{status="2xx"} ${metrics.requestsByStatus['2xx']}`,
      `coagent_http_requests_by_status{status="4xx"} ${metrics.requestsByStatus['4xx']}`,
      `coagent_http_requests_by_status{status="5xx"} ${metrics.requestsByStatus['5xx']}`,
      `# HELP coagent_event_seq 当前事件序号`,
      `# TYPE coagent_event_seq gauge`,
      `coagent_event_seq ${eventLog.lastSeq}`,
      `# HELP coagent_ws_connections 当前 WebSocket 连接数`,
      `# TYPE coagent_ws_connections gauge`,
      `coagent_ws_connections ${bus?.count ?? 0}`,
      `# HELP coagent_users 注册用户数`,
      `# TYPE coagent_users gauge`,
      `coagent_users ${loadUsers().length}`,
      `# HELP coagent_branches 分支数`,
      `# TYPE coagent_branches gauge`,
      `coagent_branches ${repo.listBranches().length}`,
    ];
    return { raw: Buffer.from(lines.join('\n') + '\n', 'utf8'), contentType: 'text/plain; version=0.0.4; charset=utf-8' };
  });

  add('POST', /^\/auth\/login$/, null, ({ body }) => {
    const { userId, token } = body ?? {};
    if (!token || !userId) throw new HubError(401, 'UNAUTHORIZED', 'userId / token 均必填');
    const user = authenticate(userId, token);
    if (!user) throw new HubError(401, 'UNAUTHORIZED', 'userId / token 不匹配');
    return { userId: user.id, name: user.name, token: user.token, scopes: user.scopes };
  });

  // 首次启动引导：仅允许本机回环访问，防止局域网泄漏种子管理员 token
  add('GET', /^\/auth\/bootstrap$/, null, ({ req }) => {
    const ip = req.socket?.remoteAddress ?? '';
    const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!isLoopback) throw forbidden('bootstrap 仅允许本机访问');
    return getBootstrapInfo();
  });

  // 本机应急重置：token 全丢或用户表损坏时，物理接触主机的人可自助恢复。
  // 仅限回环访问——能摸到这台机器的人本来就改得了 data 目录，不额外扩大攻击面，
  // 但把「手工翻 JSON」变成一次点击，避免整组人被锁在门外。
  add('POST', /^\/auth\/emergency-reset$/, null, ({ req }) => {
    const ip = req.socket?.remoteAddress ?? '';
    const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!isLoopback) throw forbidden('应急重置仅允许在主机本机操作');
    const result = emergencyReset();
    appendAudit('system', 'auth.emergency_reset', { hint: '本机管理员密码恢复' });
    return result;
  });

  // ---------- Agent 自助接入指南（无鉴权：不含任何秘密） ----------
  add('GET', /^\/guide$/, null, ({ req }) => {
    const host = req.headers.host ?? `localhost:${PORT}`;
    const md = guideMarkdown(`http://${host}`, { version: HUB_VERSION });
    return { raw: Buffer.from(md, 'utf8'), contentType: 'text/markdown; charset=utf-8' };
  });

  // ---------- API 文档（无鉴权：仅路由列表，不含秘密） ----------
  add('GET', /^\/api$/, null, () => {
    const docs = routes
      .filter((r) => !r.re.source.includes('\\/panel') && !r.re.source.includes('\\/ws'))
      .map((r) => ({
        method: r.method,
        path: r.re.source.replace(/^\^/, '').replace(/\$$/, ''),
        auth: r.scope === null ? 'public' : r.scope === '@auth' ? 'login' : r.scope,
      }));
    return { version: HUB_VERSION, endpoints: docs, count: docs.length };
  });

  // ---------- Web 管理面板（静态页本身无鉴权，数据接口各自鉴权） ----------
  let panelCache, panelETag;
  add('GET', /^\/panel$/, null, ({ req, res }) => {
    if (!panelCache) {
      try {
        // SEA 打包：panel.html 作为内嵌资产随 exe 分发
        const sea = process.getBuiltinModule?.('node:sea');
        if (sea?.getRawAsset) panelCache = Buffer.from(sea.getRawAsset('panel.html'));
      } catch { /* 非 SEA 环境走文件 */ }
      if (!panelCache) panelCache = fs.readFileSync(path.join(ROOT, 'src', 'panel.html'));
      panelETag = `"${createHash('md5').update(panelCache).digest('hex').slice(0, 16)}"`;
    }
    res.setHeader('ETag', panelETag);
    res.setHeader('Cache-Control', 'public, max-age=300');
    // 面板是单文件内联脚本，CSP 必须放行 unsafe-inline；
    // 但仍锁死 object-src / base-uri / frame-ancestors，堵掉点击劫持与插件类注入。
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';" +
      " img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:;" +
      " object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    if (req.headers['if-none-match'] === panelETag) {
      res.writeHead(304);
      res.end();
      return { raw: Buffer.alloc(0), _skip: true };
    }
    return { raw: panelCache, contentType: 'text/html; charset=utf-8' };
  });

  // ---------- Phase 2 实时总线入口 ----------
  add('GET', /^\/ws$/, null, () => {
    throw newUpgradeRequired('本端点是 WebSocket 入口：请发起 Upgrade 升级连接 ws://…/ws?token=<token>（SDK 的 connectHubWs 已封装）');
  });

  // ---------- 用户管理（开户 / 轮换 / 注销，admin:write）----------
  add('GET', /^\/users$/, 'admin:write', () => ({ users: listUsersPublic() }));

  add('POST', /^\/users$/, 'admin:write', ({ body, user }) => {
    const newUser = createUser({
      id: body?.id ?? body?.userId,
      name: body?.name,
      scopes: body?.scopes,
      token: body?.token,
      personaId: body?.personaId,
      personaPrompt: body?.personaPrompt,
    });
    appendAudit(user.id, 'user.created', { id: newUser.id });
    // token 只在创建和轮换时返回这一次，之后任何接口都不再外泄
    return { user: { id: newUser.id, name: newUser.name, scopes: newUser.scopes, token: newUser.token, persona: newUser.persona } };
  });

  add('POST', /^\/users\/([^/]+)\/rotate$/, 'admin:write', ({ params, user }) => {
    const target = rotateToken(dec(params[0]));
    appendAudit(user.id, 'user.rotated', { id: target.id });
    return { user: { id: target.id, token: target.token } };
  });

  add('DELETE', /^\/users\/([^/]+)$/, 'admin:write', ({ params, user }) => {
    if (dec(params[0]) === user.id) throw forbidden('不能注销自己（会把自己锁在门外）');
    const targetId = dec(params[0]);
    const result = deleteUser(targetId);
    appendAudit(user.id, 'user.deleted', { id: targetId });
    return result;
  });

  // ---------- Agent 独立人格（独立思考 · 防人云亦云）----------
  // 内置人格库对全体已登录 agent 开放：本地 agent 拉取后写入自己的 system prompt
  add('GET', /^\/personas$/, AUTH_ONLY, () => ({ personas: PERSONAS }));

  // 管理员给某用户绑定/清除人格（personaId 走内置库；prompt 支持自定义；null 清除）
  add('POST', /^\/users\/([^/]+)\/persona$/, 'admin:write', ({ params, body, user }) => {
    const target = setPersona(dec(params[0]), body?.persona ?? null);
    appendAudit(user.id, 'user.persona', {
      id: target.id,
      personaId: target.persona?.id ?? null,
    });
    return { user: { id: target.id, persona: target.persona } };
  });

  // 数据导出（管理员）：打包所有 JSON 数据为一个 JSON 文件，便于备份迁移
  add('GET', /^\/admin\/export$/, 'admin:write', ({ user }) => {
    gate('export');
    const dump = {
      exportedAt: new Date().toISOString(),
      version: HUB_VERSION,
      users: loadUsers(),
      tasks: readJsonSafe(PATHS.tasks),
      reviews: readJsonSafe(PATHS.reviews),
      comments: readJsonSafe(PATHS.comments),
      context: readJsonlSafe(PATHS.context),
      vectors: readJsonlSafe(PATHS.vectors),
      events: readJsonlSafe(PATHS.events),
      webhooks: readJsonSafe(PATHS.webhooks),
    };
    appendAudit(user.id, 'data.exported');
    const buf = Buffer.from(JSON.stringify(dump, null, 2), 'utf8');
    return { raw: buf, contentType: 'application/json; charset=utf-8' };
  });

  // 审计日志（专业版）：管理操作留痕，合规审计
  add('GET', /^\/admin\/audit$/, 'admin:write', ({ url }) => {
    gate('audit');
    const limit = Number(url.searchParams.get('limit') ?? 100);
    return { audit: recentAudit(Math.min(Math.max(limit, 1), 500)) };
  });

  // ---------- 数据备份（基础可靠性，全版本可用） ----------
  add('GET', /^\/admin\/backups$/, 'admin:write', () => ({
    backups: backup.listBackups(),
    last: backup.lastBackupInfo(),
    autoHours: Number(process.env.COAGENT_BACKUP_HOURS ?? 24),
    keep: Number(process.env.COAGENT_BACKUP_KEEP ?? 7),
  }));

  add('POST', /^\/admin\/backup$/, 'admin:write', ({ user }) => {
    const done = backup.runBackup();
    appendAudit(user.id, 'data.backup');
    return { ok: true, ...done };
  });

  add('GET', /^\/admin\/backups\/([^/]+)$/, 'admin:write', ({ params, user }) => {
    let buf;
    try {
      buf = backup.readBackup(dec(params[0]));
    } catch (e) {
      throw badRequest(e.message);
    }
    appendAudit(user.id, 'data.backup_download', params[0]);
    return { raw: buf, contentType: 'application/json; charset=utf-8', filename: params[0] };
  });

  // ---------- 开机自启（桌面应用设置） ----------
  add('GET', /^\/admin\/autostart$/, 'admin:write', () => autostart.getAutostart());

  add('POST', /^\/admin\/autostart$/, 'admin:write', ({ body, user }) => {
    if (!autostart.supported()) throw badRequest(autostart.getAutostart().reason);
    const enabled = Boolean(body?.enabled);
    const res = autostart.setAutostart(enabled);
    appendAudit(user.id, enabled ? 'autostart.enabled' : 'autostart.disabled');
    return { ok: true, ...res };
  });

  // ---------- 授权与试用（商用化） ----------
  add('GET', /^\/license$/, AUTH_ONLY, () => license.current());

  add('POST', /^\/license$/, 'admin:write', ({ body, user }) => {
    const key = String(body?.key ?? '').trim();
    if (!key) throw badRequest('授权 key 必填');
    const payload = license.activate(key);
    appendAudit(user.id, 'license.activated', { org: payload.org, expiresAt: payload.expiresAt });
    return { ok: true, license: license.current() };
  });

  add('DELETE', /^\/license$/, 'admin:write', ({ user }) => {
    license.deactivate();
    appendAudit(user.id, 'license.deactivated');
    return { ok: true, license: license.current() };
  });

  // ---------- Webhook 通知（专业版，admin:write） ----------
  add('GET', /^\/webhooks$/, 'admin:write', () => {
    gate('webhooks');
    return { webhooks: webhooks.list() };
  });

  add('POST', /^\/webhooks$/, 'admin:write', ({ body, user }) => {
    gate('webhooks');
    const wh = webhooks.create({
      name: body?.name,
      url: body?.url,
      events: body?.events,
      secret: body?.secret,
    });
    appendAudit(user.id, 'webhook.created', { name: wh.name, url: wh.url });
    return { webhook: { ...wh, secret: undefined } };
  });

  add('PATCH', /^\/webhooks\/([^/]+)$/, 'admin:write', ({ params, body, user }) => {
    gate('webhooks');
    const wh = webhooks.update(dec(params[0]), body ?? {});
    appendAudit(user.id, 'webhook.updated', { id: wh.id, name: wh.name });
    return { webhook: wh };
  });

  add('DELETE', /^\/webhooks\/([^/]+)$/, 'admin:write', ({ params, user }) => {
    gate('webhooks');
    webhooks.remove(dec(params[0]));
    appendAudit(user.id, 'webhook.deleted', { id: dec(params[0]) });
    return { ok: true };
  });

  add('POST', /^\/webhooks\/([^/]+)\/test$/, 'admin:write', async ({ params, user }) => {
    gate('webhooks');
    const result = await webhooks.test(dec(params[0]));
    appendAudit(user.id, 'webhook.test', { id: dec(params[0]), ...result });
    return { ok: result.ok, status: result.status, error: result.error };
  });

  // 优雅退出服务（面板顶栏 ⏻）：仅限本机 + 管理员，局域网成员不能远程关停主机
  add('POST', /^\/shutdown$/, 'admin:write', ({ req, user }) => {
    const ip = req.socket?.remoteAddress ?? '';
    const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!loopback) throw forbidden('退出服务仅允许在主机本机操作');
    appendAudit(user.id, 'system.shutdown');
    setTimeout(() => {
      close().then(() => process.exit(0)).catch(() => process.exit(0));
    }, 300);
    return { ok: true, message: '服务正在退出…' };
  });

  // ---------- 软件更新（微信式：检查 → 一键自替换重启） ----------
  add('GET', /^\/update\/check$/, AUTH_ONLY, () => {
    gate('updates');
    return checkLatest(HUB_VERSION);
  });

  add('POST', /^\/update\/apply$/, 'admin:write', ({ req, user }) => {
    gate('updates');
    // 仅限主机本机操作（局域网成员不能远程更新主机）
    const ip = req.socket?.remoteAddress ?? '';
    const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!loopback) throw forbidden('更新仅允许在主机本机操作');
    return applyUpdate(HUB_VERSION).then((result) => {
      appendAudit(user.id, 'system.updated', { version: result.version });
      // 新二进制已落位：拉起新进程接管端口，本进程优雅退出
      setTimeout(async () => {
        try {
          const { spawnDetachedServe } = await import('../scripts/app-window.mjs');
          spawnDetachedServe(result.newBinary);
          await close();
          process.exit(0);
        } catch (err) {
          console.error('[update] 重启新进程失败：', err);
          process.exit(1);
        }
      }, 500);
      return { restarting: true, version: result.version, macNote: result.macNote };
    });
  });

  // ---------- 事件回放 ----------
  add('GET', /^\/events$/, 'events:read', ({ url }) => {
    const after = Number(url.searchParams.get('after') ?? 0);
    // limit 有上限：防止单次回放把整个事件文件拉进内存
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 500) | 0, 1), 5000);
    if (!Number.isInteger(after) || after < 0) throw badRequest('after 必须为非负整数');
    // type 过滤（逗号分隔多值）：消息页等只关心特定事件的消费方用，避免拉全量再过滤
    const typeParam = url.searchParams.get('type');
    const typeFilter = typeParam ? new Set(typeParam.split(',').map((s) => s.trim()).filter(Boolean)) : null;
    const events = eventLog.since(after, limit);
    return {
      events: typeFilter ? events.filter((ev) => typeFilter.has(ev.type)) : events,
      lastSeq: eventLog.lastSeq,
    };
  });

  // ---------- 共享上下文 ----------
  add('GET', /^\/context$/, 'context:read', async ({ url }) => {
    const q = url.searchParams;
    return {
      entries: await context.query({
        taskId: q.get('taskId') ?? undefined,
        authorId: q.get('authorId') ?? undefined,
        type: q.get('type') ?? undefined,
        since: q.get('since') ?? undefined,
        q: q.get('q') ?? undefined,
        limit: q.get('limit') ? Number(q.get('limit')) : undefined,
        includeRetracted: q.get('includeRetracted') === '1',
      }),
    };
  });

  add('POST', /^\/context$/, 'context:write', ({ body, user }) => {
    const entry = context.append({ ...body, authorId: user.id });
    return { entry, seq: eventLog.lastSeq };
  });

  add('POST', /^\/context\/([^/]+)\/retract$/, 'context:write', ({ params, user }) => {
    return context.retract(dec(params[0]), user.id);
  });

  add('POST', /^\/context\/([^/]+)\/pin$/, 'context:write', ({ params, body, user }) => {
    return context.pin(dec(params[0]), user.id, body?.pinned ?? true);
  });

  add('POST', /^\/context\/([^/]+)\/revise$/, 'context:write', ({ params, body, user }) => {
    return context.revise(dec(params[0]), user.id, { body: body?.body, title: body?.title });
  });

  // ---------- 文件附件 ----------
  add('GET', /^\/files$/, 'context:read', ({ url }) => ({ files: files.list({ q: url.searchParams.get('q') ?? undefined }) }));

  add('GET', /^\/files\/([^/]+)$/, 'context:read', ({ params, res }) => {
    const { meta, data } = files.read(dec(params[0]));
    // 一律以附件下载，绝不在 Hub 同源上下文里 inline 渲染用户上传的内容；
    // 再加一层 sandbox CSP 兜底：即便将来 MIME 判断出错，浏览器也不会把它当活动文档执行。
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(meta.filename)}"`);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    return { raw: data, contentType: meta.mimeType };
  });

  // 原始二进制上传：Content-Type: application/octet-stream，X-Filename 指定文件名，X-Description 描述
  add('POST', /^\/files$/, 'context:write', ({ raw, req, user }) => {
    if (!raw?.length) throw badRequest('文件内容为空（需上传原始二进制）');
    const filename = decodeURIComponent(req.headers['x-filename'] ?? 'file');
    const description = req.headers['x-description'] ? decodeURIComponent(req.headers['x-description']) : undefined;
    const mimeType = req.headers['content-type']?.split(';')[0] ?? 'application/octet-stream';
    const meta = files.store({ buffer: raw, filename, mimeType, uploadedBy: user.id, description });
    eventLog.append({
      type: 'file.uploaded',
      authorId: user.id,
      payload: { id: meta.id, filename: meta.filename, size: meta.size, description: meta.description },
    });
    return { file: meta };
  });

  add('DELETE', /^\/files\/([^/]+)$/, 'context:write', ({ params, user }) => {
    const meta = files.get(dec(params[0]));
    const result = files.remove(dec(params[0]), user.id);
    eventLog.append({
      type: 'file.deleted',
      authorId: user.id,
      payload: { id: meta.id, filename: meta.filename, deletedBy: user.id },
    });
    return result;
  });

  // ---------- 任务板 ----------
  add('GET', /^\/tasks$/, 'task:read', ({ url }) => ({
    tasks: tasks.list({
      status: url.searchParams.get('status') ?? undefined,
      assignee: url.searchParams.get('assignee') ?? undefined,
    }),
  }));

  add('POST', /^\/tasks$/, 'task:write', ({ body, user }) => ({
    task: tasks.create({ ...body, userId: user.id }),
  }));

  add('GET', /^\/tasks\/([^/]+)$/, 'task:read', ({ params }) => ({ task: tasks.get(dec(params[0])) }));

  // 任务活动历史：返回与该任务相关的所有事件（创建/认领/更新/评论/完成等）
  add('GET', /^\/tasks\/([^/]+)\/activity$/, 'task:read', ({ params }) => {
    const taskId = dec(params[0]);
    const all = eventLog.since(0, 10000);
    const activity = all.filter((ev) =>
      ev.payload?.taskId === taskId ||
      ev.payload?.id === taskId ||
      (ev.type === 'comment.posted' && ev.payload?.targetId === taskId) ||
      (ev.type === 'comment.posted' && ev.payload?.taskId === taskId),
    );
    return { activity };
  });

  add('PATCH', /^\/tasks\/([^/]+)$/, 'task:write', ({ params, body, user }) => ({
    task: tasks.update(dec(params[0]), user.id, body ?? {}),
  }));

  add('POST', /^\/tasks\/([^/]+)\/claim$/, 'task:write', ({ params, user }) => ({
    task: tasks.claim(dec(params[0]), user.id),
  }));

  add('POST', /^\/tasks\/([^/]+)\/release$/, 'task:write', ({ params, body, user }) => ({
    task: tasks.release(dec(params[0]), user.id, body ?? {}),
  }));

  add('DELETE', /^\/tasks\/([^/]+)$/, 'task:write', ({ params, user }) =>
    tasks.remove(dec(params[0]), user.id, user.scopes?.includes('admin:write')),
  );

  // ---------- 评论（任务评论 + PR 评论）----------
  add('GET', /^\/tasks\/([^/]+)\/comments$/, 'task:read', ({ params }) => ({
    comments: comments.list('task', dec(params[0])),
  }));
  add('POST', /^\/tasks\/([^/]+)\/comments$/, 'task:write', ({ params, body, user }) => ({
    comment: comments.create({ type: 'task', targetId: dec(params[0]), authorId: user.id, body: body?.body }),
  }));
  add('GET', /^\/reviews\/([^/]+)\/comments$/, 'review:read', ({ params }) => ({
    comments: comments.list('review', dec(params[0])),
  }));
  add('POST', /^\/reviews\/([^/]+)\/comments$/, 'review:write', ({ params, body, user }) => ({
    comment: comments.create({ type: 'review', targetId: dec(params[0]), authorId: user.id, body: body?.body }),
  }));
  add('DELETE', /^\/comments\/([^/]+)$/, 'context:write', ({ params, user }) =>
    comments.remove(dec(params[0]), user.id),
  );

  // ---------- 全局搜索（任务 + 上下文 + 文件 + 消息）----------
  add('GET', /^\/search$/, 'events:read', async ({ url }) => {
    const q = url.searchParams.get('q')?.trim();
    if (!q) throw badRequest('缺少搜索关键词 q');
    const limit = Number(url.searchParams.get('limit') ?? 20);
    const taskResults = tasks.list({ q }).slice(0, limit).map((t) => ({
      kind: 'task', id: t.id, title: t.title, snippet: t.description?.slice(0, 120) ?? '', status: t.status, priority: t.priority,
    }));
    const ctxResults = (await context.query({ q, limit })).map((e) => ({
      kind: 'context', id: e.id, title: e.title, snippet: e.body?.slice(0, 120) ?? '', type: e.type, authorId: e.authorId,
    }));
    const ql = q.toLowerCase();
    const fileResults = files.list({ q }).slice(0, limit).map((f) => ({
      kind: 'file', id: f.id, title: f.filename, snippet: f.description ?? '', size: f.size, mimeType: f.mimeType, authorId: f.uploadedBy,
    }));
    // 消息是事件流里的 message.posted，文本检索走事件日志（最近 5000 条内扫）
    const msgResults = eventLog.since(0, 5000)
      .filter((ev) => ev.type === 'message.posted' && String(ev.payload?.text ?? '').toLowerCase().includes(ql))
      .slice(-limit)
      .map((ev) => ({
        kind: 'message', id: String(ev.seq), title: String(ev.payload?.text ?? '').slice(0, 80),
        snippet: ev.payload?.channel ?? 'general', authorId: ev.authorId, ts: ev.ts,
      }));
    return {
      query: q,
      tasks: taskResults,
      context: ctxResults,
      files: fileResults,
      messages: msgResults,
      total: taskResults.length + ctxResults.length + fileResults.length + msgResults.length,
    };
  });

  // ---------- 统计（仪表盘用）----------
  add('GET', /^\/stats$/, 'events:read', async () => {
    const taskStats = tasks.stats();
    const allBranches = repo.listBranches();
    const ctxEntries = await context.query({ limit: 9999 });
    const allComments = readJsonlSafe(PATHS.comments);
    const usersById = loadUsers().reduce((m, u) => { m[u.id] = u; return m; }, {});
    // 时间窗口：今天为基准，向前推（用本地日界，配合面板展示）
    const now = new Date();
    const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const daily = [];
    const taskDoneDaily = [];
    const doneAccum = [0];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      daily.push({ date: dayKey(d), label: `${d.getMonth() + 1}/${d.getDate()}`, count: 0 });
      taskDoneDaily.push({ date: dayKey(d), label: `${d.getMonth() + 1}/${d.getDate()}`, count: 0 });
    }
    const dailyIdx = Object.fromEntries(daily.map((d, i) => [d.date, i]));
    // 成员×近 7 天热力图
    const weekAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
    const weekStartKey = dayKey(weekAgo);
    const memberDaily = new Map(); // id -> [7]
    const contrib = new Map();
    for (const ev of eventLog.since(0, 100_000)) {
      if (!ev?.authorId) continue;
      const ts = Date.parse(ev.ts ?? ev.t ?? '');
      if (!ts) continue;
      const d = new Date(ts);
      const key = dayKey(d);
      if (dailyIdx[key] !== undefined) daily[dailyIdx[key]].count++;
      if (ev.type === 'task.updated' && ev.payload?.status === 'done') {
        const idx = dailyIdx[key];
        if (idx !== undefined) taskDoneDaily[idx].count++;
      }
      if (ts >= weekAgo.getTime()) {
        const bucket = dailyIdx[key] - (14 - 7);
        if (bucket >= 0 && bucket < 7) {
          const md = memberDaily.get(ev.authorId) ?? [0, 0, 0, 0, 0, 0, 0];
          md[bucket]++;
          memberDaily.set(ev.authorId, md);
        }
        const cur = contrib.get(ev.authorId) ?? { count: 0, actions: {} };
        cur.count++;
        cur.actions[ev.type] = (cur.actions[ev.type] ?? 0) + 1;
        contrib.set(ev.authorId, cur);
      }
    }
    // 燃尽累计
    let acc = 0;
    taskDoneDaily.forEach((d) => { acc += d.count; d.accum = acc; });
    const contributors = [...contrib.entries()]
      .map(([id, v]) => ({ id, name: usersById[id]?.name ?? id, count: v.count, actions: v.actions }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
    const heatmap = [...memberDaily.entries()]
      .map(([id, days]) => ({ id, name: usersById[id]?.name ?? id, days }))
      .sort((a, b) => b.days.reduce((s, n) => s + n, 0) - a.days.reduce((s, n) => s + n, 0))
      .slice(0, 6);
    return {
      tasks: taskStats,
      context: { total: ctxEntries.length, byType: ctxEntries.reduce((acc, e) => { acc[e.type] = (acc[e.type] ?? 0) + 1; return acc; }, {}) },
      comments: { total: allComments.filter((c) => !c.deleted).length, byType: allComments.reduce((acc, c) => { if (!c.deleted) acc[c.type] = (acc[c.type] ?? 0) + 1; return acc; }, {}) },
      branches: { total: allBranches.length, protected: PROTECTED_BRANCHES.length },
      files: (() => {
        const all = files.list();
        const byType = {};
        for (const f of all) {
          const t = files.classifyType(f.mimeType, f.filename);
          byType[t] = (byType[t] ?? 0) + 1;
        }
        return { total: all.length, size: all.reduce((s, f) => s + f.size, 0), byType };
      })(),
      users: loadUsers().length,
      onlineUsers: bus?.onlineUsers?.() ?? [],
      lastSeq: eventLog.lastSeq,
      wsConnections: bus?.count ?? 0,
      uptime: Math.floor((Date.now() - new Date(metrics.startedAt).getTime()) / 1000),
      contributors,
      daily,
      taskDoneDaily,
      heatmap,
      weekStart: weekStartKey,
      dataSize: dirSize(PATHS.data, { skip: new Set(['repo.git']) }),
      repoSize: dirSize(PATHS.repo),
      eventsFileSize: fs.existsSync(PATHS.events) ? fs.statSync(PATHS.events).size : 0,
      // 全员独立人格映射（authorId → 人格徽章），供面板展示"多视角协作"。
      // 放在 /stats（events:read 即可读）是为了让所有 agent 都能看到彼此视角，
      // 体现"打破信息壁垒"——不只管理员可见。
      personas: Object.fromEntries(
        loadUsers()
          .filter((u) => u.persona)
          .map((u) => [u.id, { id: u.persona.id, prompt: u.persona.prompt }]),
      ),
    };
  });

  // ---------- 语义检索状态（Phase 3，专业版）----------
  add('GET', /^\/embed\/status$/, AUTH_ONLY, () => {
    if (!license.can('embed')) {
      return {
        available: false,
        enabled: false,
        reason: '语义检索为专业版功能（试用期内可用）',
        config: embedConfig(),
      };
    }
    const st = embedStatus();
    return {
      ...st,
      config: embedConfig(),
      coverage: { embedded: vectors.size, total: context.count() },
    };
  });

  // ---------- 分支（名称含斜杠，后缀优先匹配）----------
  // 整仓读通道：跨机场景下 agent 无法直连本机路径，靠这两个端点取代码
  add('GET', /^\/repo\/info$/, 'branch:read', () => ({
    refs: repo.listRefs(),
    main: repo.revParse('main'),
  }));

  add('GET', /^\/repo\/bundle$/, 'branch:read', () => {
    const { file } = repo.exportRepoBundle();
    const data = fs.readFileSync(file);
    fs.rmSync(file, { force: true });
    return { raw: data, contentType: 'application/octet-stream' };
  });

  add('GET', /^\/branches\/(.+)\/diff$/, 'branch:read', ({ params, url }) => {
    const branch = dec(params[0]);
    repo.requireBranch(branch);
    return repo.diff(branch, url.searchParams.get('base') ?? 'main');
  });

  add('GET', /^\/branches\/(.+)\/bundle$/, 'branch:read', ({ params }) => {
    const { file } = repo.exportBundle(dec(params[0]));
    const data = fs.readFileSync(file);
    fs.rmSync(file, { force: true });
    return { raw: data, contentType: 'application/octet-stream' };
  });

  add('POST', /^\/branches\/(.+)\/push$/, 'branch:push', ({ params, raw, user }) => {
    const branch = dec(params[0]);
    if (PROTECTED_BRANCHES.includes(branch)) {
      throw forbidden(`${branch} 是受保护分支，只能经审核后的 PR 合入`, { hint: 'POST /reviews 然后 /reviews/:id/merge' });
    }
    if (!repo.canPush(user.id, branch)) {
      throw forbidden(`只能推送到自己的私有分支：${privateBranch(user.id)}`, { attempted: branch });
    }
    if (!raw?.length) throw badRequest('请求体为空：需上传 git bundle（application/octet-stream）');
    if (!repo.branchExists(branch)) repo.createBranch(branch, 'main');

    const result = repo.receiveBundle(raw, `refs/heads/${branch}`);
    eventLog.append({
      type: 'branch.pushed',
      authorId: user.id,
      payload: { branch: result.branch, sha: result.sha, before: result.before },
    });
    return { ...result, seq: eventLog.lastSeq };
  });

  add('GET', /^\/branches$/, 'branch:read', () => ({ branches: repo.listBranches() }));

  add('POST', /^\/branches$/, 'branch:push', ({ body, user }) => {
    const name = body?.name ?? privateBranch(user.id);
    if (PROTECTED_BRANCHES.includes(name)) throw forbidden(`禁止创建受保护分支：${name}`);
    if (name !== privateBranch(user.id)) {
      throw forbidden(`只能创建自己的私有分支：${privateBranch(user.id)}`, { requested: name });
    }
    const result = repo.createBranch(name, body?.start ?? 'main');
    eventLog.append({
      type: 'branch.created',
      authorId: user.id,
      payload: { branch: result.branch, sha: result.sha },
    });
    return result;
  });

  // ---------- 审核 / PR ----------
  add('GET', /^\/reviews$/, 'review:read', ({ url }) => ({
    reviews: reviews.list({
      status: url.searchParams.get('status') ?? undefined,
      branch: url.searchParams.get('branch') ?? undefined,
    }),
  }));

  add('POST', /^\/reviews$/, 'review:write', ({ body, user }) => ({
    review: reviews.create({ ...body, userId: user.id }),
  }));

  add('POST', /^\/reviews\/([^/]+)\/approve$/, 'review:write', ({ params, user }) => ({
    review: reviews.approve(dec(params[0]), user.id),
  }));

  add('POST', /^\/reviews\/([^/]+)\/reject$/, 'review:write', ({ params, body, user }) => ({
    review: reviews.reject(dec(params[0]), user.id, body?.reason),
  }));

  add('POST', /^\/reviews\/([^/]+)\/merge$/, 'branch:merge', ({ params, user }) => {
    const out = reviews.merge(dec(params[0]), user.id);
    return { review: out.review, merge: out.merge };
  });

  // ---------- 群聊消息 ----------
  add('POST', /^\/messages$/, 'message:write', ({ body, user }) => {
    if (!body?.text?.trim()) throw badRequest('text 不能为空');
    if (body.text.length > 10_000) throw badRequest('text 最长 10000 字符');
    const ev = eventLog.append({
      type: 'message.posted',
      authorId: user.id,
      payload: { text: body.text, channel: body.channel ?? 'general', taskId: body.taskId ?? null },
    });
    return { event: ev };
  });

  add('GET', /^\/me$/, AUTH_ONLY, ({ user }) => ({ userId: user.id, name: user.name, scopes: user.scopes, persona: user.persona ?? null }));

  // ---------- 传输层（HTTP / HTTPS） ----------
  // HTTPS：COAGENT_TLS_CERT + COAGENT_TLS_KEY 同时存在时启用（专业版）。
  // 无授权时不启用并警告——避免未授权用户意外获得 TLS 版功能。
  const tlsCert = process.env.COAGENT_TLS_CERT ? path.resolve(process.env.COAGENT_TLS_CERT) : null;
  const tlsKey = process.env.COAGENT_TLS_KEY ? path.resolve(process.env.COAGENT_TLS_KEY) : null;
  let tlsOptions = null;
  if (tlsCert && tlsKey) {
    if (license.can('tls')) {
      try {
        tlsOptions = {
          cert: fs.readFileSync(tlsCert),
          key: fs.readFileSync(tlsKey),
        };
        console.log(`[hub] HTTPS 已启用（${tlsCert}）`);
      } catch (err) {
        console.error(`[hub] TLS 证书读取失败，回退 HTTP：${err.message}`);
      }
    } else {
      console.warn('[license] TLS 为专业版功能，未获授权，回退 HTTP 运行（激活授权后配置 COAGENT_TLS_CERT/KEY 生效）');
    }
  }

  // ---------- 请求分发 ----------
  const server = (tlsOptions ? https.createServer(tlsOptions, async (req, res) => {
    handleRequest(req, res);
  }) : http.createServer(async (req, res) => {
    handleRequest(req, res);
  }));

  async function handleRequest(req, res) {
    const start = Date.now();
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // 基础安全响应头（所有响应统一施加）
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');

    // CORS：默认 *，生产可通过 COAGENT_CORS_ORIGIN 限定具体源
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (CORS_ORIGIN !== '*') res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      accessLog(req, res, start, 0);
      return;
    }

    // 速率限制（按客户端 IP）
    const clientIp = req.socket.remoteAddress ?? 'unknown';
    if (!checkRateLimit(clientIp)) {
      sendJson(res, 429, { error: { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试', limit: RATE_LIMIT + '/min' } });
      return;
    }

    let bytesOut = 0;
    const origEnd = res.end.bind(res);
    res.end = (chunk, encoding, cb) => {
      if (chunk) bytesOut += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), encoding);
      accessLog(req, res, start, bytesOut);
      return origEnd(chunk, encoding, cb);
    };

    try {
      const raw = await readBody(req);
      if (raw.length) metrics.bytesIn += raw.length;
      const path = url.pathname;
      const route = routes.find((r) => r.method === req.method && r.re.test(path));
      if (!route) throw notFound(`无此端点：${req.method} ${path}`);

      // 鉴权（/healthz、/auth/login、/ws 不需要）
      const isPublic = route.scope === PUBLIC;
      let user = null;
      const header = req.headers.authorization;
      if (!isPublic) {
        user = verify(header);
        if (route.scope !== AUTH_ONLY) requireScope(user, /** @type {string} */ (route.scope));
      } else if (header) {
        try {
          user = verify(header);
        } catch {
          /* 公开端点带坏 token 也放行 */
        }
      }

      const params = route.re.exec(path).slice(1);
      let body;
      if (raw.length && (req.headers['content-type'] ?? '').includes('application/json')) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          throw badRequest('JSON 解析失败');
        }
      }

      const result = (await route.handler({ req, res, url, params, user, body, raw })) ?? {};
      sendJson(res, 200, result);
    } catch (err) {
      const status = err instanceof HubError ? err.status : 500;
      if (status >= 500) metrics.errors++;
      const payload =
        err instanceof HubError
          ? err.toJSON()
          : { code: 'INTERNAL', message: err?.message ?? '服务端异常' };
      if (status >= 500 && payload.code !== 'NOT_IMPLEMENTED') console.error('[hub] 未处理异常：', err);
      sendJson(res, status, { error: payload });
    }
  }

  /**
   * @param {http.IncomingMessage} req
   * @returns {Promise<Buffer>}
   */
  function readBody(req) {
    return new Promise((resolve, reject) => {
      /** @type {Buffer[]} */
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new HubError(413, 'PAYLOAD_TOO_LARGE', `请求体超过 ${MAX_BODY} 字节`));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  // keep-alive 必须长于「客户端两次请求间的最大空档」：
  // git 子进程同步执行可能让单个请求耗数秒，默认 5s 会把闲置连接掐掉，
  // 客户端恰好复用被掐的连接时表现为 ECONNRESET（冒烟实测复现）。
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000; // 须 > keepAliveTimeout

  // 实时总线：升级请求走 ws://…/ws?token=…，事件订阅点在 eventLog
  const bus = attachWebSocket(server, {
    verify: (header) => verify(header),
    eventLog,
  });

  /**
   * 优雅关闭：停止接受新连接，关闭所有 WS 连接，等待现有请求完成。
   * 供 SIGTERM / SIGINT 处理调用，避免强杀导致数据损坏。
   * @param {number} [graceMs=5000] 宽限期
   * @returns {Promise<void>}
   */
  function close(graceMs = 5000) {
    return new Promise((resolve) => {
      console.log('[hub] 正在优雅关闭…');
      for (const conn of bus.connections) {
        try { conn.socket.write?.(Buffer.from([0x88, 0x02, 0x03, 0xe8])); conn.socket.destroy(); } catch { /* 忽略 */ }
      }
      const timer = setTimeout(() => {
        console.warn('[hub] 优雅关闭超时，强制退出');
        resolve();
      }, graceMs);
      server.close(() => {
        clearTimeout(timer);
        console.log('[hub] 已关闭');
        resolve();
      });
    });
  }

  // ---------- 自动备份调度（启动时检查 + 每小时复查，到点自动备份） ----------
  backup.maybeAutoBackup();
  const backupTimer = setInterval(() => { backup.maybeAutoBackup(); }, 60 * 60 * 1000);
  backupTimer.unref?.();

  return { server, eventLog, context, tasks, reviews, comments, files, webhooks, bus, close, metrics };
}

/**
 * 安全读取 JSON 文件，不存在返回空对象
 */
function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

/**
 * 安全读取 JSONL 文件，不存在返回空数组
 */
function readJsonlSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

/**
 * 目录总字节数（递归；可跳过子目录，如巨型 repo.git）。
 * @param {string} dir
 * @param {{skip?: Set<string>}} [opts]
 */
function dirSize(dir, opts = {}) {
  const skip = opts.skip ?? new Set();
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (skip.has(e.name)) continue;
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirSize(p, { skip });
      else total += fs.statSync(p).size;
    } catch { /* 忽略瞬时不可读 */ }
  }
  return total;
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {*} payload
 */
function sendJson(res, status, payload) {
  if (payload && payload._skip) return; // 304 等已在 handler 中结束响应
  if (payload && payload.raw instanceof Buffer) {
    const headers = {
      'Content-Type': payload.contentType ?? 'application/octet-stream',
      'Content-Length': payload.raw.length,
    };
    if (payload.filename) {
      headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(payload.filename)}"`;
    }
    res.writeHead(status, headers);
    return res.end(payload.raw);
  }
  const buf = Buffer.from(JSON.stringify(payload, null, 2) + '\n', 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

// 直接执行时启动服务 → 已迁移到 scripts/serve.mjs（npm start），
// 且 SEA 打包（coagent.exe）由 scripts/sea-entry.mjs 自行调度，本文件保持纯库模块。
