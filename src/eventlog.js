/**
 * 追加式事件日志 —— 全系统唯一真相源。
 *
 * 设计约束（来自设计文档 §5 / §7）：
 *  1. 事件不可变：一旦落盘不得修改。
 *  2. seq 严格单调递增，是离线回放的唯一游标。
 *  3. 所有写路径必须先 append 事件，再向调用方返回。
 *  4. Phase 2 的实时总线直接订阅 `subscribe()`，无需改动本模块。
 *
 * 并发假设：单进程。多进程部署需替换为文件锁或数据库（见 README「已知限制」）。
 *
 * @module eventlog
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * @typedef {object} Event
 * @property {number} seq       单调递增序号
 * @property {string} id
 * @property {string} type      见 EventType
 * @property {object} payload
 * @property {string} authorId
 * @property {string} ts        ISO 8601
 */

/**
 * @typedef {'context.appended'|'context.retracted'
 *  |'task.created'|'task.claimed'|'task.updated'|'task.released'
 *  |'branch.created'|'branch.pushed'|'branch.merged'
 *  |'review.requested'|'review.approved'|'review.rejected'
 *  |'message.posted'|'agent.status'} EventType
 */

/**
 * 创建事件日志实例。
 * @param {string} file JSONL 路径
 */
export function createEventLog(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');

  /** @type {Set<(ev: Event) => void>} */
  const listeners = new Set();
  let seq = 0;

  /** 内存 ring buffer：缓存最近 N 条事件，加速 since() 查询（避免每次全量读文件） */
  const CACHE_SIZE = 1000;
  /** @type {Event[]} */
  const cache = [];

  repairAndLoad();

  /** 启动时把文件中最后 CACHE_SIZE 条载入缓存 */
  function warmCache() {
    const text = fs.readFileSync(file, 'utf8');
    if (!text) return;
    const lines = text.split('\n').filter((l) => l.trim());
    const start = Math.max(0, lines.length - CACHE_SIZE);
    for (let i = start; i < lines.length; i++) {
      try {
        const ev = JSON.parse(lines[i]);
        if (ev.seq) cache.push(ev);
      } catch { /* 跳过损坏行 */ }
    }
  }

  /**
   * 载入已有日志，恢复 seq；若末尾存在半行（进程被杀）则截断修复。
   */
  function repairAndLoad() {
    const buf = fs.readFileSync(file);
    const text = buf.toString('utf8');
    if (!text) return;

    const lines = text.split('\n');
    let offset = 0;
    let maxSeq = 0;
    let brokenTail = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isLast = i === lines.length - 1;
      const raw = line.trim();
      const lineEnd = offset + Buffer.byteLength(line) + (isLast ? 0 : 1);

      if (raw) {
        try {
          const ev = JSON.parse(raw);
          if (typeof ev.seq === 'number') maxSeq = Math.max(maxSeq, ev.seq);
        } catch {
          // 只有"最后一行且文件未以换行结尾"才视为可修复的半行
          if (isLast && !text.endsWith('\n')) {
            brokenTail = offset;
            break;
          }
          console.warn(`[eventlog] 跳过损坏行 @${offset}：${raw.slice(0, 80)}`);
        }
      }
      offset = lineEnd;
    }

    if (brokenTail >= 0) {
      fs.truncateSync(file, brokenTail);
      console.warn(`[eventlog] 修复半行写入，截断至 ${brokenTail} 字节`);
    }
    seq = maxSeq;
    warmCache();
  }

  /**
   * 追加一条事件。同步落盘后通知订阅者。
   * @param {{type: EventType|string, payload?: object, authorId: string}} input
   * @returns {Event}
   */
  function append({ type, payload = {}, authorId }) {
    /** @type {Event} */
    const ev = {
      seq: ++seq,
      id: randomUUID(),
      type,
      payload,
      authorId,
      ts: new Date().toISOString(),
    };
    // 同步追加：单线程下天然串行，且保证"落盘先于响应"
    fs.appendFileSync(file, JSON.stringify(ev) + '\n');
    cache.push(ev);
    if (cache.length > CACHE_SIZE) cache.shift();
    for (const fn of listeners) {
      try {
        fn(ev);
      } catch (err) {
        console.error('[eventlog] listener 抛错：', err);
      }
    }
    return ev;
  }

  /**
   * 回放：取 seq > after 的事件。优先走内存缓存，缓存未命中才读文件。
   * @param {number} after
   * @param {number} [limit]
   * @returns {Event[]}
   */
  function since(after = 0, limit = 500) {
    // 快速路径：请求范围完全在缓存内（缓存最早 seq <= after+1）
    if (cache.length && cache[0].seq <= after + 1) {
      const out = [];
      for (const ev of cache) {
        if (ev.seq > after) {
          out.push(ev);
          if (out.length >= limit) break;
        }
      }
      return out;
    }
    // 慢速路径：读文件
    const text = fs.readFileSync(file, 'utf8');
    /** @type {Event[]} */
    const out = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.seq > after) out.push(ev);
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * 订阅新事件（Phase 2 WebSocket 总线的挂点）。
   * @param {(ev: Event) => void} fn
   * @returns {() => void} 取消订阅
   */
  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return {
    append,
    since,
    subscribe,
    get lastSeq() {
      return seq;
    },
    file,
  };
}
