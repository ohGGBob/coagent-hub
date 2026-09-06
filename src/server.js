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
import { loadUsers, verify, requireScope, createUser, listUsersPublic, rotateToken, deleteUser, getBootstrapInfo, authenticate } from './auth.js';
import * as repo from './git-repo.js';
import { HubError, badRequest, notFound, newUpgradeRequired, forbidden } from './errors.js';
import { guideMarkdown } from './guide.js';
import { attachWebSocket } from './ws.js';

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

  // ---------- 公开端点 ----------
  // healthz 保持轻量：无鉴权端点不暴露用户清单，也不跑 git 子进程（避免被当放大器）
  add('GET', /^\/healthz$/, null, () => ({
    ok: true,
    version: HUB_VERSION,
    lastSeq: eventLog.lastSeq,
    uptimeSec: Math.floor((Date.now() - new Date(metrics.startedAt).getTime()) / 1000),
  }));

  // 轻量指标端点（Prometheus 文本格式，可直接被抓取）
  add('GET', /^\/metrics$/, null, () => {
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

  add('POST', /^\/users$/, 'admin:write', ({ body }) => {
    const user = createUser({
      id: body?.id ?? body?.userId,
      name: body?.name,
      scopes: body?.scopes,
      token: body?.token,
    });
    // token 只在创建和轮换时返回这一次，之后任何接口都不再外泄
    return { user: { id: user.id, name: user.name, scopes: user.scopes, token: user.token } };
  });

  add('POST', /^\/users\/([^/]+)\/rotate$/, 'admin:write', ({ params }) => {
    const user = rotateToken(dec(params[0]));
    return { user: { id: user.id, token: user.token } };
  });

  add('DELETE', /^\/users\/([^/]+)$/, 'admin:write', ({ params, user }) => {
    if (dec(params[0]) === user.id) throw forbidden('不能注销自己（会把自己锁在门外）');
    return deleteUser(dec(params[0]));
  });

  // 数据导出（管理员）：打包所有 JSON 数据为一个 JSON 文件，便于备份迁移
  add('GET', /^\/admin\/export$/, 'admin:write', () => {
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
    };
    const buf = Buffer.from(JSON.stringify(dump, null, 2), 'utf8');
    return { raw: buf, contentType: 'application/json; charset=utf-8' };
  });

  // 优雅退出服务（面板顶栏 ⏻）：仅限本机 + 管理员，局域网成员不能远程关停主机
  add('POST', /^\/shutdown$/, 'admin:write', ({ req }) => {
    const ip = req.socket?.remoteAddress ?? '';
    const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!loopback) throw forbidden('退出服务仅允许在主机本机操作');
    setTimeout(() => {
      close().then(() => process.exit(0)).catch(() => process.exit(0));
    }, 300);
    return { ok: true, message: '服务正在退出…' };
  });

  // ---------- 事件回放 ----------
  add('GET', /^\/events$/, 'events:read', ({ url }) => {
    const after = Number(url.searchParams.get('after') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 500);
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
  add('GET', /^\/files$/, 'context:read', () => ({ files: files.list() }));

  add('GET', /^\/files\/([^/]+)$/, 'context:read', ({ params, res }) => {
    const { meta, data } = files.read(dec(params[0]));
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(meta.filename)}"`);
    return { raw: data, contentType: meta.mimeType };
  });

  // 原始二进制上传：Content-Type: application/octet-stream，X-Filename 指定文件名
  add('POST', /^\/files$/, 'context:write', ({ raw, req, user }) => {
    if (!raw?.length) throw badRequest('文件内容为空（需上传原始二进制）');
    const filename = decodeURIComponent(req.headers['x-filename'] ?? 'file');
    const mimeType = req.headers['content-type']?.split(';')[0] ?? 'application/octet-stream';
    const meta = files.store({ buffer: raw, filename, mimeType, uploadedBy: user.id });
    eventLog.append({
      type: 'file.uploaded',
      authorId: user.id,
      payload: { id: meta.id, filename: meta.filename, size: meta.size },
    });
    return { file: meta };
  });

  add('DELETE', /^\/files\/([^/]+)$/, 'context:write', ({ params, user }) =>
    files.remove(dec(params[0]), user.id),
  );

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

  // ---------- 全局搜索（任务 + 上下文 + 事件）----------
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
    return { query: q, tasks: taskResults, context: ctxResults, total: taskResults.length + ctxResults.length };
  });

  // ---------- 统计（仪表盘用）----------
  add('GET', /^\/stats$/, 'events:read', async () => {
    const taskStats = tasks.stats();
    const allBranches = repo.listBranches();
    const ctxEntries = await context.query({ limit: 9999 });
    const allComments = readJsonlSafe(PATHS.comments);
    return {
      tasks: taskStats,
      context: { total: ctxEntries.length, byType: ctxEntries.reduce((acc, e) => { acc[e.type] = (acc[e.type] ?? 0) + 1; return acc; }, {}) },
      comments: { total: allComments.filter((c) => !c.deleted).length, byType: allComments.reduce((acc, c) => { if (!c.deleted) acc[c.type] = (acc[c.type] ?? 0) + 1; return acc; }, {}) },
      branches: { total: allBranches.length, protected: PROTECTED_BRANCHES.length },
      users: loadUsers().length,
      onlineUsers: bus?.onlineUsers?.() ?? [],
      lastSeq: eventLog.lastSeq,
      wsConnections: bus?.count ?? 0,
      uptime: Math.floor((Date.now() - new Date(metrics.startedAt).getTime()) / 1000),
    };
  });

  // ---------- 语义检索状态（Phase 3）----------
  add('GET', /^\/embed\/status$/, AUTH_ONLY, () => {
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

  add('GET', /^\/me$/, AUTH_ONLY, ({ user }) => ({ userId: user.id, name: user.name, scopes: user.scopes }));

  // ---------- 请求分发 ----------
  const server = http.createServer(async (req, res) => {
    const start = Date.now();
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

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
  });

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

  return { server, eventLog, context, tasks, reviews, comments, files, bus, close, metrics };
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
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {*} payload
 */
function sendJson(res, status, payload) {
  if (payload && payload._skip) return; // 304 等已在 handler 中结束响应
  if (payload && payload.raw instanceof Buffer) {
    res.writeHead(status, {
      'Content-Type': payload.contentType ?? 'application/octet-stream',
      'Content-Length': payload.raw.length,
    });
    return res.end(payload.raw);
  }
  const buf = Buffer.from(JSON.stringify(payload, null, 2) + '\n', 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

// 直接执行时启动服务 → 已迁移到 scripts/serve.mjs（npm start），
// 且 SEA 打包（coagent.exe）由 scripts/sea-entry.mjs 自行调度，本文件保持纯库模块。
