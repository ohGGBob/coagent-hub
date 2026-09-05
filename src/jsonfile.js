/**
 * 可变状态的原子持久化：读整个 JSON、写临时文件后 rename。
 * 事件日志之外的可变状态（任务板、审核记录）都走这里。
 *
 * @module jsonfile
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 读取 JSON 状态文件；不存在或损坏时返回默认值。
 * @template T
 * @param {string} file
 * @param {T} fallback
 * @returns {T}
 */
export function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    if (!text) return structuredClone(fallback);
    return JSON.parse(text);
  } catch (err) {
    if (err.code === 'ENOENT') return structuredClone(fallback);
    throw new Error(`状态文件损坏：${file}（${err.message}）`);
  }
}

/**
 * 原子写入 JSON。写入临时文件再 rename，避免断电留下半截文件。
 * @param {string} file
 * @param {*} value
 */
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
