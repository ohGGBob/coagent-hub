/**
 * 向量 sidecar 存储 —— data/vectors.jsonl 追加式（与事件日志同一模式）。
 *
 * 设计约束：
 *  - 条目不可变原则不变：向量不写回 context.jsonl，而是以 {targetId, vec} 追加到本文件，
 *    同一 targetId 后写的覆盖先写的（修订重嵌、模型换版都自然生效）。
 *  - 存储路径固定为模块常量 PATHS.vectors，不接受调用方注入。
 *  - 内存缓存 Map<targetId, Float32Array>：启动全量载入，追加即时入缓存；
 *    余弦相似度纯 JS 实现（小团队规模足矣）。
 *
 * @module vectors
 */

import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.js';

export function createVectorStore() {
  const file = PATHS.vectors;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');

  /** @type {Map<string, Float32Array>} targetId -> 最新向量 */
  const cache = new Map();
  let lastModel = null;
  let lastDim = 0;

  /** 启动时全量载入（后写覆盖先写） */
  (function loadAll() {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    for (const line of text.split('\n')) {
      const raw = line.trim();
      if (!raw) continue;
      try {
        const rec = JSON.parse(raw);
        if (!rec?.targetId || !Array.isArray(rec.vec) || !rec.vec.length) continue;
        cache.set(rec.targetId, Float32Array.from(rec.vec));
        lastModel = rec.model ?? lastModel;
        lastDim = rec.vec.length;
      } catch { /* 跳过损坏行 */ }
    }
  })();

  /**
   * 追加一条向量（落盘 + 更新缓存）。
   * @param {string} targetId 上下文条目 id
   * @param {number[]} vec
   * @param {string} [model]
   */
  function append(targetId, vec, model) {
    if (!Array.isArray(vec) || !vec.length) throw new Error('向量维度为空');
    const rec = { targetId, model: model ?? lastModel, dim: vec.length, vec, ts: new Date().toISOString() };
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
    cache.set(targetId, Float32Array.from(vec));
    lastModel = rec.model;
    lastDim = rec.dim;
    return rec;
  }

  /**
   * 取某条目的最新向量。
   * @param {string} targetId
   * @returns {Float32Array|null}
   */
  function get(targetId) {
    return cache.get(targetId) ?? null;
  }

  /**
   * 纯 JS 余弦相似度。
   * @param {Float32Array|number[]} a
   * @param {Float32Array|number[]} b
   */
  function cosine(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom ? dot / denom : 0;
  }

  return {
    append,
    get,
    cosine,
    /** 已嵌入的条目数（含已撤回条目，检索层自行过滤） */
    get size() {
      return cache.size;
    },
    get model() {
      return lastModel;
    },
    get dim() {
      return lastDim;
    },
  };
}
