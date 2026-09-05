/**
 * Hub 全局配置与路径。
 * 所有路径可通过环境变量覆盖，便于冒烟测试使用临时数据目录。
 *
 * @module config
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 源码目录 / 仓库根目录。
 * - Node 直跑（npm start / smoke）：src 目录 → ROOT 为其上一级。
 * - SEA 单文件 exe（esbuild 打 CJS 后 import.meta 不可用）：fileURLToPath 抛错，
 *   回落到 exe 所在目录 → 默认数据目录就是 exe 旁边的 data/，天然便携。
 */
const HERE = (() => {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return '';
  }
})();

export const ROOT = HERE ? path.resolve(HERE, '..') : path.dirname(process.execPath);

/**
 * @typedef {object} Paths
 * @property {string} data     数据目录
 * @property {string} repo     服务端裸仓
 * @property {string} users    用户表 users.json
 * @property {string} events   事件日志 events.jsonl
 * @property {string} context  上下文条目 context.jsonl
 * @property {string} tasks    任务板 tasks.json
 * @property {string} reviews  审核记录 reviews.json
 * @property {string} tmp      临时目录（接收 bundle 用）
 */

const DATA_DIR = process.env.COAGENT_DATA ?? path.join(ROOT, 'data');

/** @type {Paths} */
export const PATHS = Object.freeze({
  data: DATA_DIR,
  repo: path.join(DATA_DIR, 'repo.git'),
  users: path.join(DATA_DIR, 'users.json'),
  events: path.join(DATA_DIR, 'events.jsonl'),
  context: path.join(DATA_DIR, 'context.jsonl'),
  tasks: path.join(DATA_DIR, 'tasks.json'),
  reviews: path.join(DATA_DIR, 'reviews.json'),
  tmp: path.join(DATA_DIR, 'tmp'),
});

/** HTTP 端口（0 = 系统随机分配，冒烟测试用） */
export const PORT = Number(process.env.COAGENT_PORT ?? 8787);

/** 协议版本，随 Phase 推进递增 */
export const HUB_VERSION = '0.3.0';

/** 受保护分支：只能经审核后的 fast-forward 合入 */
export const PROTECTED_BRANCHES = Object.freeze(['main']);

/** 建立数据目录与其子目录；幂等 */
export function ensureDirs() {
  for (const dir of [PATHS.data, PATHS.tmp]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * 生成某用户的私有分支名。
 * @param {string} userId
 * @returns {string}
 */
export function privateBranch(userId) {
  return `dev/${userId}`;
}
