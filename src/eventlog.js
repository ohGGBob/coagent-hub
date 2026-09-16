/**
 * 追加式事件日志 —— 全系统唯一真相源。
 *
 * 设计约束（来自设计文档 §5 / §7）：
 *  1. 事件不可变：一旦落盘不得修改。
 *  2. seq 严格单调递增，是离线回放的唯一游标。
 *  3. 所有写路径必须先 append 事件，再向调用方返回。
 *  4. Phase 2 的实时总线直接订阅 `subscribe()`，无需改动本模块。
 *
 * 性能：文件为追加式，offset 恒定。模块维护「偏移索引」（events.idx.jsonl，
 * 每 INDEX_STRIDE 条记录 {seq, offset}），since() 在缓存未命中时从索引指向的
 * 偏移流式读文件，大数据量（数十万事件）下不再整文件读入内存。
 *
 * 并发假设：单进程。多进程部署需替换为文件锁或数据库（见 README「已知限制」）。
 *
 * @module eventlog
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PATHS } from './config.js';

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
 * 创建事件日志实例。日志路径固定为模块常量 PATHS.events，
 * 不接受调用方注入（避免任何动态输入到达文件路径）。
 */
export function createEventLog() {
  const file = PATHS.events;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');

  /** @type {Set<(ev: Event) => void>} */
  const listeners = new Set();
  let seq = 0;

  /** 内存 ring buffer：缓存最近 N 条事件，加速 since() 查询（避免每次全量读文件） */
  const CACHE_SIZE = 1000;
  /** @type {Event[]} */
  const cache = [];

  // ---------- 偏移索引 ----------
  /** 每 INDEX_STRIDE 条事件记录一次文件偏移（seq 严格递增 + 追加式 → 索引永远有效） */
  const INDEX_STRIDE = 500;
  const indexFile = path.join(path.dirname(file), 'events.idx.jsonl');
  /** @type {{seq: number, offset: number}[]} seq 升序 */
  let index = [];
  /** 索引文件当前字节数（增量追加用） */
  let indexFileSize = 0;

  /** 载入偏移索引到内存（存在且非空才用；缺失会在 repairAndLoad 里重建） */
  function loadIndexFile() {
    try {
      const text = fs.readFileSync(indexFile, 'utf8');
      const out = [];
      for (const line of text.split('\n')) {
        const raw = line.trim();
        if (!raw) continue;
        try {
          const it = JSON.parse(raw);
          if (typeof it.seq === 'number' && typeof it.offset === 'number') out.push(it);
        } catch { /* 跳过损坏行 */ }
      }
      index = out;
      indexFileSize = fs.statSync(indexFile).size;
    } catch {
      index = [];
      indexFileSize = 0;
    }
  }

  /** 把内存索引整体写回索引文件（启动/修复后调用；追加阶段走 appendIndexRow） */
  function saveIndexFile() {
    const buf = Buffer.from(index.map((it) => JSON.stringify(it)).join('\n') + (index.length ? '\n' : ''), 'utf8');
    fs.writeFileSync(indexFile, buf);
    indexFileSize = buf.length;
  }

  /** 追加一条索引行（append 阶段到达 stride 时） */
  function appendIndexRow(it) {
    const buf = Buffer.from(JSON.stringify(it) + '\n', 'utf8');
    fs.appendFileSync(indexFile, buf);
    indexFileSize += buf.length;
  }

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
   * 同时顺势重建偏移索引（索引缺失 / 落后于文件 / 文件被截断修复时）。
   */
  function repairAndLoad() {
    const buf = fs.readFileSync(file);
    const text = buf.toString('utf8');
    if (!text) {
      loadIndexFile();
      return;
    }

    const lines = text.split('\n');
    let offset = 0;
    let maxSeq = 0;
    let brokenTail = -1;

    // 全量扫描：顺便在内存重建索引
    const rebuilt = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isLast = i === lines.length - 1;
      const raw = line.trim();
      const lineEnd = offset + Buffer.byteLength(line) + (isLast ? 0 : 1);

      if (raw) {
        try {
          const ev = JSON.parse(raw);
          if (typeof ev.seq === 'number') {
            maxSeq = Math.max(maxSeq, ev.seq);
            if (ev.seq % INDEX_STRIDE === 0) rebuilt.push({ seq: ev.seq, offset });
          }
        } catch {
          // 只有"最后一行且文件未以换行结尾"才视为可修复的半行
          if (isLast && !text.endsWith('\n')) {
            brokenTail = offset;
            break;
          }
        }
      }
      offset = lineEnd;
    }

    if (brokenTail >= 0) {
      fs.truncateSync(file, brokenTail);
      console.warn(`[eventlog] 修复半行写入，截断至 ${brokenTail} 字节`);
      // 索引可能覆盖到被截断的行：直接重建写回
      fs.rmSync(indexFile, { force: true });
    }
    seq = maxSeq;

    // 索引有效性：磁盘索引与重建结果对齐则复用（append 增量更快）；
    // 不一致（文件被截断/索引缺失）则用重建结果整体写回。
    let needsRewrite = true;
    loadIndexFile();
    if (!brokenTail && index.length && rebuilt.length) {
      const lastIdx = index[index.length - 1];
      const lastRebuilt = rebuilt[rebuilt.length - 1];
      if (lastIdx.seq === lastRebuilt.seq && lastIdx.offset === lastRebuilt.offset && index.length === rebuilt.length) {
        needsRewrite = false;
      }
    }
    if (needsRewrite) {
      index = rebuilt;
      saveIndexFile();
    }
    warmCache();
  }

  // 启动即修复 + 恢复 seq + 校验/重建索引
  repairAndLoad();

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
    const offset = fs.statSync(file).size;
    fs.appendFileSync(file, JSON.stringify(ev) + '\n');
    cache.push(ev);
    if (cache.length > CACHE_SIZE) cache.shift();
    // 维护偏移索引：命中 stride 时追加一行索引
    if (ev.seq % INDEX_STRIDE === 0) {
      index.push({ seq: ev.seq, offset });
      appendIndexRow({ seq: ev.seq, offset });
    }
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
   * 从文件中流式读取行并解析（同步）。块边界自动拼接，避免跨块切断 JSON。
   * @param {number} start 起始字节偏移
   * @param {(raw: string) => (boolean | void)} onLine 返回 false 则提前停止
   */
  function readLinesFrom(start, onLine) {
    const CHUNK = 256 * 1024;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(CHUNK);
    const size = fs.fstatSync(fd).size;
    let pos = start;
    let carry = '';
    let stopped = false;
    try {
      while (pos < size && !stopped) {
        const got = fs.readSync(fd, buf, 0, CHUNK, pos);
        if (got <= 0) break;
        pos += got;
        const text = carry + buf.toString('utf8', 0, got);
        const nl = text.lastIndexOf('\n');
        if (nl === -1) { carry = text; continue; }
        const head = text.slice(0, nl);
        carry = text.slice(nl + 1);
        for (const raw of head.split('\n')) {
          const line = raw.trim();
          if (line && onLine(line) === false) { stopped = true; break; }
        }
      }
      if (!stopped && carry.trim()) onLine(carry.trim());
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * 回放：取 seq > after 的事件。优先走内存缓存；缓存未命中时走偏移索引流式读文件。
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
    // 慢速路径：从偏移索引定位起始点，流式读文件（不全量读入内存）
    /** @type {Event[]} */
    const out = [];
    let startOffset = 0;
    for (let i = index.length - 1; i >= 0; i--) {
      if (index[i].seq <= after) { startOffset = index[i].offset; break; }
    }
    readLinesFrom(startOffset, (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.seq > after) {
        out.push(ev);
        if (out.length >= limit) return false;
      }
    });
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
    indexFile,
  };
}
