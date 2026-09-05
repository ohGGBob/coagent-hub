/**
 * 共享上下文层（设计文档 §4 ContextEntry）。
 *
 * 规则：
 *  - 所有人可读 —— 这是"共享"的意义所在。
 *  - 仅作者可写 —— 他人不得改写你的上下文。
 *  - 条目不可变 —— 更正请追加新条目；不想要了用 `retract()` 撤回（软删除，留痕）。
 *
 * @module context
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PATHS } from './config.js';
import { forbidden, notFound, badRequest } from './errors.js';

const VALID_TYPES = new Set(['decision', 'progress', 'blocker', 'note', 'summary']);

/**
 * @typedef {object} ContextEntry
 * @property {string} id
 * @property {string} authorId
 * @property {'decision'|'progress'|'blocker'|'note'|'summary'} type
 * @property {string} title
 * @property {string} body
 * @property {string[]} tags
 * @property {string} [taskId]
 * @property {string} [branchId]
 * @property {string} createdAt
 * @property {number[]} [embedding]  Phase 3 RAG 再填
 */

/**
 * @param {{file?: string, eventLog: import('./eventlog.js').createEventLog extends (...a:any)=>infer R ? R : any}} deps
 */
export function createContextStore({ file = PATHS.context, eventLog }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');

  /** @returns {Array<ContextEntry | {kind:'retract', id:string, targetId:string, authorId:string, ts:string}>} */
  function readAll() {
    const out = [];
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* 跳过损坏行 */
      }
    }
    return out;
  }

  function appendLine(obj) {
    fs.appendFileSync(file, JSON.stringify(obj) + '\n');
  }

  /**
   * 追加一条共享上下文。authorId 由服务端从 token 取，不接受客户端伪造。
   * @param {{authorId: string, type?: string, title: string, body?: string,
   *          tags?: string[], taskId?: string, branchId?: string}} input
   * @returns {ContextEntry}
   */
  function append(input) {
    const type = input.type ?? 'note';
    if (!VALID_TYPES.has(type)) {
      throw badRequest(`type 必须是 ${[...VALID_TYPES].join(' | ')}`, { got: type });
    }
    if (!input.title || !input.title.trim()) throw badRequest('title 不能为空');

    /** @type {ContextEntry} */
    const entry = {
      id: randomUUID(),
      authorId: input.authorId,
      type,
      title: input.title.trim(),
      body: input.body ?? '',
      tags: input.tags ?? [],
      taskId: input.taskId,
      branchId: input.branchId,
      createdAt: new Date().toISOString(),
    };
    appendLine(entry);
    eventLog.append({
      type: 'context.appended',
      authorId: entry.authorId,
      payload: { id: entry.id, entryType: entry.type, title: entry.title, taskId: entry.taskId },
    });
    return entry;
  }

  /**
   * 检索共享上下文。
   * @param {{taskId?: string, authorId?: string, type?: string, since?: string,
   *          q?: string, tags?: string[], limit?: number, includeRetracted?: boolean}} [filter]
   * @returns {ContextEntry[]}
   */
  function query(filter = {}) {
    const all = readAll();
    const retracted = new Set(
      all.filter((r) => r.kind === 'retract').map((r) => r.targetId),
    );
    const since = filter.since ? Date.parse(filter.since) : NaN;
    const q = filter.q?.toLowerCase();
    const tags = filter.tags;

    const entries = all
      .filter((e) => e.kind !== 'retract')
      .filter((e) => (filter.includeRetracted ? true : !retracted.has(e.id)))
      .filter((e) => (filter.taskId ? e.taskId === filter.taskId : true))
      .filter((e) => (filter.authorId ? e.authorId === filter.authorId : true))
      .filter((e) => (filter.type ? e.type === filter.type : true))
      .filter((e) => (Number.isFinite(since) ? Date.parse(e.createdAt) >= since : true))
      .filter((e) => (tags?.length ? tags.every((t) => e.tags.includes(t)) : true))
      .filter((e) =>
        q ? (e.title + '\n' + e.body).toLowerCase().includes(q) : true,
      );

    // 默认按时间正序（回放友好）
    return entries.slice(-(filter.limit ?? 200));
  }

  /**
   * 撤回自己的条目。撤回是追加操作，不抹掉历史。
   * @param {string} id
   * @param {string} userId
   */
  function retract(id, userId) {
    const target = get(id);
    if (target.authorId !== userId) {
      throw forbidden('只能撤回自己发布的上下文', { owner: target.authorId });
    }
    const marker = { kind: 'retract', id: randomUUID(), targetId: id, authorId: userId, ts: new Date().toISOString() };
    appendLine(marker);
    eventLog.append({
      type: 'context.retracted',
      authorId: userId,
      payload: { id, targetId: id },
    });
    return { id, retracted: true };
  }

  /**
   * @param {string} id
   * @returns {ContextEntry}
   */
  function get(id) {
    const found = readAll().find((e) => e.kind !== 'retract' && e.id === id);
    if (!found) throw notFound(`上下文条目不存在：${id}`);
    return found;
  }

  return { append, query, retract, get };
}
