/**
 * Agent SDK —— 本地 agent 接入 Hub 的唯一契约（设计文档 §6）。
 *
 * 两套通道：
 *  - REST（异步主路径，本文件全部走这条）
 *  - WebSocket（Phase 2，接口已在下方 `subscribeEvents()` 预留）
 *
 * 典型用法：
 * ```js
 * const hub = new HubClient({ hubUrl: 'http://localhost:8787', token: process.env.HUB_TOKEN });
 * await hub.context.query({ taskId });   // 开工前拉共享上下文
 * await hub.task.claim(taskId);          // 认领
 * // ...本地实现，git commit...
 * await hub.branch.push(branch, bundle); // 推私有分支
 * await hub.review.request({ branch });  // 求审
 * await hub.sync();                      // 离线重连：补齐 lastSeq 之后的事件
 * ```
 *
 * @module sdk
 */

export class HubError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} status
   * @param {*} [detail]
   */
  constructor(code, message, status, detail) {
    super(message);
    this.name = 'HubError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export { connectHubWs } from './ws-client.js';
import { connectHubWs } from './ws-client.js';

export class HubClient {
  /**
   * @param {{hubUrl: string, token: string, fetchImpl?: typeof fetch}} opts
   */
  constructor({ hubUrl, token, fetchImpl }) {
    this.hubUrl = hubUrl.replace(/\/+$/, '');
    this.token = token;
    this._fetch = fetchImpl ?? globalThis.fetch;
    /** 离线回放游标：本地持久化它，重连时就能精准补齐 */
    this.lastSeq = 0;
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {{body?: any, raw?: Buffer, query?: Record<string, string|number|undefined>}} [opts]
   */
  async request(method, path, opts = {}) {
    const url = new URL(this.hubUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    /** @type {RequestInit} */
    const init = {
      method,
      headers: { Authorization: `Bearer ${this.token}` },
    };
    if (opts.raw) {
      init.headers['Content-Type'] = 'application/octet-stream';
      init.body = opts.raw;
    } else if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }

    const res = await this._fetch(url, init);
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const e = data?.error ?? {};
      throw new HubError(e.code ?? 'HTTP_ERROR', e.message ?? `HTTP ${res.status}`, res.status, e.detail);
    }
    return data;
  }

  /** 服务端健康与全局状态（无需 token） */
  healthz() {
    return this.request('GET', '/healthz');
  }

  /** 当前凭证身份 */
  me() {
    return this.request('GET', '/me');
  }

  /**
   * 离线重连/新会话补齐：拉取 lastSeq 之后的事件并推进游标。
   * @param {{limit?: number}} [opts]
   */
  async sync(opts = {}) {
    const { events, lastSeq } = await this.request('GET', '/events', {
      query: { after: this.lastSeq, limit: opts.limit ?? 500 },
    });
    if (events.length) this.lastSeq = events[events.length - 1].seq;
    else this.lastSeq = lastSeq ?? this.lastSeq;
    return events;
  }

  /**
   * 全量回放（新 agent 首次接入用）。
   * @param {{limit?: number}} [opts]
   */
  async replay(opts = {}) {
    return this.request('GET', '/events', { query: { after: 0, limit: opts.limit ?? 500 } });
  }

  /** 共享上下文：所有人可读，仅自己可写 */
  context = {
    /**
     * @param {{taskId?: string, authorId?: string, type?: string, since?: string,
     *          q?: string, limit?: number, includeRetracted?: boolean}} [filter]
     */
    query: (filter = {}) =>
      this.request('GET', '/context', {
        query: {
          taskId: filter.taskId,
          authorId: filter.authorId,
          type: filter.type,
          since: filter.since,
          q: filter.q,
          limit: filter.limit,
          includeRetracted: filter.includeRetracted ? '1' : undefined,
        },
      }),
    /**
     * @param {{type?: string, title: string, body?: string, tags?: string[],
     *          taskId?: string, branchId?: string}} entry
     */
    append: (entry) => this.request('POST', '/context', { body: entry }),
    retract: (id) => this.request('POST', `/context/${encodeURIComponent(id)}/retract`),
  };

  /** 任务协调板 */
  task = {
    list: (filter = {}) => this.request('GET', '/tasks', { query: filter }),
    get: (id) => this.request('GET', `/tasks/${encodeURIComponent(id)}`),
    /**
     * @param {{title: string, description?: string, tags?: string[], branchId?: string}} input
     */
    create: (input) => this.request('POST', '/tasks', { body: input }),
    claim: (id) => this.request('POST', `/tasks/${encodeURIComponent(id)}/claim`),
    update: (id, patch) => this.request('PATCH', `/tasks/${encodeURIComponent(id)}`, { body: patch }),
    /**
     * @param {string} id
     * @param {{reviewId?: string}} [opts] 释放他人任务时必须给出 approved 的 reviewId
     */
    release: (id, opts = {}) => this.request('POST', `/tasks/${encodeURIComponent(id)}/release`, { body: opts }),
  };

  /** 分支：读直连 git，写必须经 Hub */
  branch = {
    list: () => this.request('GET', '/branches'),
    /** @param {{name?: string, start?: string}} [input] 默认创建自己的 dev/<userId> */
    create: (input = {}) => this.request('POST', '/branches', { body: input }),
    /**
     * @param {string} branch
     * @param {Buffer} bundle `git bundle create` 产物
     */
    push: (branch, bundle) =>
      this.request('POST', `/branches/${encodeURI(branch)}/push`, { raw: bundle }),
    diff: (branch, base = 'main') =>
      this.request('GET', `/branches/${encodeURI(branch)}/diff`, { query: { base } }),
    /** 首次 clone 用的打包下载 */
    download: async (branch) => {
      const res = await this._fetch(
        `${this.hubUrl}/branches/${encodeURI(branch)}/bundle`,
        { headers: { Authorization: `Bearer ${this.token}` } },
      );
      if (!res.ok) throw new HubError('HTTP_ERROR', `下载失败 HTTP ${res.status}`, res.status);
      return Buffer.from(await res.arrayBuffer());
    },
  };

  /** 审核 / PR 闸门 */
  review = {
    list: (filter = {}) => this.request('GET', '/reviews', { query: filter }),
    /** @param {{branch?: string, base?: string, taskId?: string}} input */
    request: (input) => this.request('POST', '/reviews', { body: input }),
    approve: (id) => this.request('POST', `/reviews/${encodeURIComponent(id)}/approve`),
    reject: (id, reason) => this.request('POST', `/reviews/${encodeURIComponent(id)}/reject`, { body: { reason } }),
    merge: (id) => this.request('POST', `/reviews/${encodeURIComponent(id)}/merge`),
  };

  /**
   * 整仓读通道（跨机场景：agent 无法直连主机文件路径）。
   * `snapshot()` 返回可 `git clone` 的整仓 bundle。
   */
  repo = {
    /** 分支清单与 sha，用于判断是否需要拉取 */
    info: () => this.request('GET', '/repo/info'),
    /** 下载整仓快照（Buffer，写成 .bundle 文件后可直接 git clone / fetch） */
    snapshot: async () => {
      const res = await this._fetch(`${this.hubUrl}/repo/bundle`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (!res.ok) throw new HubError('HTTP_ERROR', `快照下载失败 HTTP ${res.status}`, res.status);
      return Buffer.from(await res.arrayBuffer());
    },
  };

  /**
   * 用户管理（需 admin:write scope）。
   * token 只在 create / rotate 的响应里出现一次，请立刻妥善保存。
   */
  users = {
    /** 列出用户（不含 token） */
    list: () => this.request('GET', '/users'),
    /**
     * 开户。
     * @param {{id: string, name?: string, scopes?: string[]}} input
     */
    create: (input) => this.request('POST', '/users', { body: input }),
    /** 轮换 token，旧凭证立即失效 */
    rotate: (id) => this.request('POST', `/users/${encodeURIComponent(id)}/rotate`),
    /** 注销用户（不能注销自己） */
    remove: (id) => this.request('DELETE', `/users/${encodeURIComponent(id)}`),
  };

  /**
   * 结构化群聊消息。
   * @param {string} text
   * @param {{channel?: string, taskId?: string}} [opts]
   */
  message(text, opts = {}) {
    return this.request('POST', '/messages', { body: { text, ...opts } });
  }

  /**
   * 实时订阅（WebSocket）。参数与返回句柄见 {@link connectHubWs}。
   *
   * ```js
   * const ws = hub.connect({ types: ['task.created','message.posted'], since: hub.lastSeq, onEvent: console.log });
   * // ……之后 ws.close()
   * ```
   */
  connect(opts = {}) {
    return connectHubWs({
      hubUrl: this.hubUrl,
      token: this.token,
      since: this.lastSeq, // 默认从 REST 游标续传，实时与轮询共用同一游标
      ...opts,
    });
  }
}

export default HubClient;
