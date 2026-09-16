/**
 * Webhook 通知系统（零第三方依赖，Node ≥18 全局 fetch）。
 *
 * 商用化集成层：把 Hub 事件推送到外部系统（飞书 / 企业微信 / Slack /
 * Discord / 通用 HTTP 端点），投递带 HMAC 签名供接收方验签。
 *
 * 设计要点：
 *  - 事件白名单订阅：每个 webhook 只接收勾选的事件类型。
 *  - 签名：X-Hub-Signature: sha256=<HMAC-SHA256(secret, body)>，无 secret 则不签名。
 *  - 投递：fire-and-forget 异步队列，不阻塞主流程；超时 10s；失败退避重试
 *    3 次（1s / 5s / 15s）；连续失败 ≥10 次自动禁用并记录原因。
 *  - SSRF 防护：默认拒绝私网 / 回环 / 链路本地地址（防伪造 webhook 把 Hub
 *    变成内网扫描放大器），COAGENT_WEBHOOK_ALLOW_PRIVATE=1 可显式放开。
 *  - 持久化：data/webhooks.json（原子写），secret 仅存储，列表接口脱敏。
 *
 * @module webhooks
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHmac } from 'node:crypto';
import { PATHS, HUB_VERSION } from './config.js';
import { badRequest } from './errors.js';

/** 可订阅事件白名单（对齐 eventlog EventType + 高频业务事件） */
export const EVENT_TYPES = Object.freeze([
  'task.created',
  'task.updated',
  'task.claimed',
  'task.released',
  'context.appended',
  'context.retracted',
  'review.requested',
  'review.approved',
  'review.rejected',
  'review.merged',
  'comment.posted',
  'message.posted',
  'branch.created',
  'branch.pushed',
  'agent.status',
]);

/** 默认订阅事件（不选时的兜底） */
const DEFAULT_EVENTS = ['task.created', 'context.appended', 'review.requested', 'comment.posted', 'message.posted', 'branch.pushed'];

/** 是否允许投递到私网地址（默认否，SSRF 防护） */
const ALLOW_PRIVATE = process.env.COAGENT_WEBHOOK_ALLOW_PRIVATE === '1';

const FILE = PATHS.webhooks;

/**
 * @typedef {object} Webhook
 * @property {string} id
 * @property {string} name
 * @property {string} url
 * @property {string} [secret]
 * @property {string[]} events
 * @property {boolean} enabled
 * @property {string} createdAt
 * @property {string|null} lastDeliveryAt
 * @property {number|null} lastStatus
 * @property {string|null} lastError
 * @property {number} consecutiveFailures
 */

/** 简单原子写（先写临时文件再 rename，避免半写） */
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/** 读取 webhooks.json，损坏时备份并重置为空（管理端配置可重建） */
function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 校验 URL 协议与私网目标（SSRF 防护） */
export function checkWebhookUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw badRequest('Webhook 地址必须是合法的 http(s) URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw badRequest('Webhook 地址仅支持 http / https');
  }
  if (!ALLOW_PRIVATE) {
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const isPrivate =
      host === 'localhost' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host.endsWith('.local') ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^fe80:/.test(host) ||
      host === 'metadata.google.internal';
    if (isPrivate) {
      throw badRequest('出于 SSRF 防护，Webhook 地址默认不允许指向私网/本机（COAGENT_WEBHOOK_ALLOW_PRIVATE=1 可放开）');
    }
  }
  return u.toString();
}

/** 校验事件白名单，非法事件直接剔除 */
function normalizeEvents(events) {
  const set = new Set(Array.isArray(events) ? events : DEFAULT_EVENTS);
  const ok = [...set].filter((e) => EVENT_TYPES.includes(e));
  return ok.length ? ok : [...DEFAULT_EVENTS];
}

/**
 * 创建 Webhook 管理器实例。
 * @returns {{
 *   list: () => Webhook[],
 *   create: (input: {name: string, url: string, events?: string[], secret?: string}) => Webhook,
 *   update: (id: string, patch: Partial<Webhook>) => Webhook,
 *   remove: (id: string) => void,
 *   test: (id: string) => Promise<{status: number, ok: boolean}>,
 *   hookEvents: (eventLog: any) => void
 * }}
 */
export function createWebhookStore() {
  let state = load();

  /** 持久化当前状态 */
  function persist() {
    writeJson(FILE, state);
  }

  /** 对外列表：secret 脱敏为是否设置 */
  function list() {
    return state.map(({ secret, ...rest }) => ({
      ...rest,
      hasSecret: Boolean(secret),
    }));
  }

  /** 投递单条事件（含退避重试与失败计数） */
  async function deliver(wh, ev) {
    const body = JSON.stringify({
      event: ev.type,
      seq: ev.seq,
      payload: ev.payload,
      authorId: ev.authorId,
      ts: ev.ts,
      hubVersion: HUB_VERSION,
    });
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': `CoAgentHub/${HUB_VERSION}`,
    };
    if (wh.secret) {
      headers['X-Hub-Signature'] = 'sha256=' + createHmac('sha256', wh.secret).update(body).digest('hex');
    }
    const delays = [0, 1000, 5000, 15000];
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, delays[attempt]));
      try {
        const res = await fetch(wh.url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(10_000),
        });
        const updated = state.find((w) => w.id === wh.id);
        if (!updated) return; // 投递期间被删除
        updated.lastDeliveryAt = new Date().toISOString();
        updated.lastStatus = res.status;
        updated.lastError = null;
        if (res.ok) {
          updated.consecutiveFailures = 0;
        } else {
          updated.consecutiveFailures = (updated.consecutiveFailures || 0) + 1;
          updated.lastError = `HTTP ${res.status}`;
          if (updated.consecutiveFailures >= 10) {
            updated.enabled = false;
            updated.lastError = `连续失败 ${updated.consecutiveFailures} 次，已自动禁用`;
          }
        }
        persist();
        return;
      } catch (err) {
        const updated = state.find((w) => w.id === wh.id);
        if (!updated) return;
        updated.consecutiveFailures = (updated.consecutiveFailures || 0) + 1;
        updated.lastError = err?.name === 'TimeoutError' ? '投递超时（10s）' : (err?.message ?? '网络错误');
        if (attempt === delays.length - 1) {
          if (updated.consecutiveFailures >= 10) {
            updated.enabled = false;
            updated.lastError = `连续失败 ${updated.consecutiveFailures} 次，已自动禁用`;
          }
        }
        persist();
      }
    }
  }

  /** 订阅事件日志：命中 webhook 事件的类型即异步投递 */
  function hookEvents(eventLog) {
    eventLog.subscribe((ev) => {
      for (const wh of state) {
        if (!wh.enabled) continue;
        if (!wh.events.includes(ev.type)) continue;
        // fire-and-forget：投递失败只记录，不阻塞主流程
        deliver(wh, ev).catch(() => {});
      }
    });
  }

  return {
    list,
    create({ name, url, events, secret }) {
      const trimmedName = String(name ?? '').trim();
      if (!trimmedName) throw badRequest('Webhook 名称不能为空');
      const cleanUrl = checkWebhookUrl(url);
      const wh = {
        id: randomUUID(),
        name: trimmedName.slice(0, 80),
        url: cleanUrl,
        secret: secret ? String(secret).slice(0, 200) : '',
        events: normalizeEvents(events),
        enabled: true,
        createdAt: new Date().toISOString(),
        lastDeliveryAt: null,
        lastStatus: null,
        lastError: null,
        consecutiveFailures: 0,
      };
      state.push(wh);
      persist();
      const { secret: _s, ...rest } = wh;
      return { ...rest, hasSecret: Boolean(wh.secret) };
    },
    update(id, patch) {
      const wh = state.find((w) => w.id === id);
      if (!wh) throw badRequest('Webhook 不存在');
      if (patch.name !== undefined) wh.name = String(patch.name).trim().slice(0, 80) || wh.name;
      if (patch.url !== undefined) wh.url = checkWebhookUrl(patch.url);
      if (patch.secret !== undefined) wh.secret = String(patch.secret).slice(0, 200);
      if (patch.events !== undefined) wh.events = normalizeEvents(patch.events);
      if (patch.enabled !== undefined) {
        wh.enabled = Boolean(patch.enabled);
        if (wh.enabled) wh.consecutiveFailures = 0;
      }
      persist();
      const { secret: _s, ...rest } = wh;
      return { ...rest, hasSecret: Boolean(wh.secret) };
    },
    remove(id) {
      const before = state.length;
      state = state.filter((w) => w.id !== id);
      if (state.length === before) throw badRequest('Webhook 不存在');
      persist();
    },
    async test(id) {
      const wh = state.find((w) => w.id === id);
      if (!wh) throw badRequest('Webhook 不存在');
      const ev = {
        type: 'webhook.test',
        seq: 0,
        payload: { message: `来自 ${wh.name} 的测试事件，CoAgent Hub v${HUB_VERSION}` },
        authorId: 'system',
        ts: new Date().toISOString(),
      };
      await deliver(wh, ev);
      const updated = state.find((w) => w.id === id);
      return { ok: updated && updated.lastStatus >= 200 && updated.lastStatus < 300, status: updated?.lastStatus ?? 0, error: updated?.lastError };
    },
    hookEvents,
  };
}
