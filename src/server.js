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
import {
  PATHS, PORT, HUB_VERSION, ensureDirs, privateBranch, PROTECTED_BRANCHES,
} from './config.js';
import { createEventLog } from './eventlog.js';
import { createContextStore } from './context.js';
import { createTaskStore } from './tasks.js';
import { createReviewStore } from './reviews.js';
import { loadUsers, verify, requireScope, createUser, listUsersPublic, rotateToken, deleteUser } from './auth.js';
import * as repo from './git-repo.js';
import { HubError, badRequest, notFound, newUpgradeRequired, forbidden } from './errors.js';
import { guideMarkdown } from './guide.js';
import { attachWebSocket } from './ws.js';

const MAX_BODY = 128 * 1024 * 1024;

/**
 * 组装所有依赖并创建 HTTP 服务。
 * @returns {{server: import('node:http').Server, eventLog: any, context: any, tasks: any, reviews: any}}
 */
export function createHub() {
  ensureDirs();
  loadUsers();
  repo.ensureRepo();

  const eventLog = createEventLog(PATHS.events);
  const context = createContextStore({ eventLog });
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

  // 鉴权语义：scope === null 表示公开端点；'@auth' 表示需登录但不校验具体 scope。
  const PUBLIC = null;
  const AUTH_ONLY = '@auth';

  /** @type {Array<{method: string, re: RegExp, scope: string|null, handler: (c: any) => any}>} */
  const routes = [];

  const add = (method, re, scope, handler) => routes.push({ method, re, scope, handler });
  const dec = (s) => decodeURIComponent(s);

  // ---------- 公开端点 ----------
  add('GET', /^\/healthz$/, null, () => ({
    ok: true,
    version: HUB_VERSION,
    repo: PATHS.repo,
    branches: repo.listBranches(),
    lastSeq: eventLog.lastSeq,
    users: loadUsers().map((u) => ({ id: u.id, name: u.name })),
  }));

  add('POST', /^\/auth\/login$/, null, ({ body }) => {
    const { userId, token } = body ?? {};
    const users = loadUsers();
    const user = users.find((u) => (token ? u.token === token && (!userId || u.id === userId) : u.id === userId));
    if (!user) throw new HubError(401, 'UNAUTHORIZED', 'userId / token 不匹配');
    return { userId: user.id, name: user.name, token: user.token, scopes: user.scopes };
  });

  // ---------- Agent 自助接入指南（无鉴权：不含任何秘密） ----------
  add('GET', /^\/guide$/, null, ({ req }) => {
    const host = req.headers.host ?? `localhost:${PORT}`;
    const md = guideMarkdown(`http://${host}`, { version: HUB_VERSION });
    return { raw: Buffer.from(md, 'utf8'), contentType: 'text/markdown; charset=utf-8' };
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

  // ---------- 事件回放 ----------
  add('GET', /^\/events$/, 'events:read', ({ url }) => {
    const after = Number(url.searchParams.get('after') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 500);
    if (!Number.isInteger(after) || after < 0) throw badRequest('after 必须为非负整数');
    return { events: eventLog.since(after, limit), lastSeq: eventLog.lastSeq };
  });

  // ---------- 共享上下文 ----------
  add('GET', /^\/context$/, 'context:read', ({ url }) => {
    const q = url.searchParams;
    return {
      entries: context.query({
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

  add('PATCH', /^\/tasks\/([^/]+)$/, 'task:write', ({ params, body, user }) => ({
    task: tasks.update(dec(params[0]), user.id, body ?? {}),
  }));

  add('POST', /^\/tasks\/([^/]+)\/claim$/, 'task:write', ({ params, user }) => ({
    task: tasks.claim(dec(params[0]), user.id),
  }));

  add('POST', /^\/tasks\/([^/]+)\/release$/, 'task:write', ({ params, body, user }) => ({
    task: tasks.release(dec(params[0]), user.id, body ?? {}),
  }));

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
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // CORS：给未来的上下文策展 UI 留门
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();

    try {
      const raw = await readBody(req);
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

      const result = route.handler({ req, res, url, params, user, body, raw }) ?? {};
      sendJson(res, 200, result);
    } catch (err) {
      const status = err instanceof HubError ? err.status : 500;
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

  return { server, eventLog, context, tasks, reviews, bus };
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {*} payload
 */
function sendJson(res, status, payload) {
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
