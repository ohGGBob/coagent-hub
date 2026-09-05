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
 * 极简零依赖分词：按非字母数字切西文词；CJK 连续串切成单字 + 相邻二元组
 * （二元组让「登录页」能命中「登录」，单字保证单字查询仍可用）。
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  const tokens = [];
  for (const chunk of String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!chunk) continue;
    if (/[\u4e00-\u9fff]/.test(chunk)) {
      for (let i = 0; i < chunk.length; i++) {
        tokens.push(chunk[i]);
        if (i + 1 < chunk.length) tokens.push(chunk.slice(i, i + 2));
      }
    } else {
      tokens.push(chunk);
    }
  }
  return tokens;
}

/**
 * BM25 相关性打分。title 出现两次参与统计（标题权重 ≈ ×2），tags 一并计入。
 * @param {ContextEntry[]} entries
 * @param {string} q 查询串（可多词）
 * @returns {Array<{entry: ContextEntry, score: number}>} 仅保留 score>0，按分数降序
 */
function bm25(entries, q) {
  const k1 = 1.5;
  const b = 0.75;
  const allTerms = [...new Set(tokenize(q))];
  if (!allTerms.length) return entries.map((entry) => ({ entry, score: 0 }));

  const docs = entries.map((entry) => {
    const tf = new Map();
    let len = 0;
    for (const t of tokenize([entry.title, entry.title, entry.body, ...(entry.tags ?? [])].join(' '))) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
      len++;
    }
    return { entry, tf, len };
  });

  const N = Math.max(docs.length, 1);
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / N || 1;

  const scoreWith = (terms) => {
    const df = new Map(terms.map((term) => [term, docs.filter((d) => d.tf.has(term)).length]));
    const scored = docs.map((d) => {
      let score = 0;
      for (const term of terms) {
        const f = d.tf.get(term);
        const n = df.get(term) ?? 0;
        if (!f) continue;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (d.len / avgLen))));
      }
      return { entry: d.entry, score };
    });
    return scored.filter((x) => x.score > 0).sort((a, z) => z.score - a.score);
  };

  // 查询主词项：西文词 + CJK 二元组。单个汉字太常见（「的」「了」）会到处误命中。
  // 只有当查询全部由单字构成（主词项为空）时，才降级用单字兜底。
  const isCjkUnigram = (t) => t.length === 1 && /[\u4e00-\u9fff]/.test(t);
  const primary = allTerms.filter((t) => !isCjkUnigram(t));
  return scoreWith(primary.length ? primary : allTerms);
}

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
    const q = filter.q?.trim();
    const tags = filter.tags;

    let entries = all
      .filter((e) => e.kind !== 'retract')
      .filter((e) => (filter.includeRetracted ? true : !retracted.has(e.id)))
      .filter((e) => (filter.taskId ? e.taskId === filter.taskId : true))
      .filter((e) => (filter.authorId ? e.authorId === filter.authorId : true))
      .filter((e) => (filter.type ? e.type === filter.type : true))
      .filter((e) => (Number.isFinite(since) ? Date.parse(e.createdAt) >= since : true))
      .filter((e) => (tags?.length ? tags.every((t) => e.tags.includes(t)) : true));

    if (q) {
      // 相关性检索：多词 BM25 打分（title ×2 权重、tags 计入），只返回有命中的条目
      const scored = bm25(entries, q);
      const limit = filter.limit ?? 200;
      return scored.slice(0, limit).map((x) => x.entry);
    }

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
