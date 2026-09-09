/**
 * 任务协调板（设计文档 §4 Task）。
 *
 * 权限规则：
 *  - 任何人可创建、可认领未被认领的任务。
 *  - 只有「持有者或创建者」能更新自己的任务卡。
 *  - **释放他人任务属敏感操作**：必须出示一条针对该任务、且已 approved 的审核记录
 *    （对应设计文档 §7「实时 ≠ 自动触发他人动作」）。
 *
 * v0.5 扩展：priority（urgent/high/medium/low）、labels、dueDate、commentCount。
 *
 * @module tasks
 */

import { randomUUID } from 'node:crypto';
import { PATHS } from './config.js';
import { readJson, writeJson } from './jsonfile.js';
import { notFound, conflict, forbidden, badRequest } from './errors.js';

const VALID_PRIORITIES = new Set(['urgent', 'high', 'medium', 'low']);
const PRIORITY_WEIGHT = { urgent: 0, high: 1, medium: 2, low: 3 };
const VALID_STATUSES = new Set(['open', 'claimed', 'done']);
/** title / description 的长度上限（防止超大字段写穿数据文件） */
const MAX_TITLE = 300;
const MAX_DESCRIPTION = 100_000;
const MAX_LIST_ITEMS = 20;
const MAX_LIST_ITEM_LEN = 64;

/**
 * 校验并清洗 tags / labels 这类字符串数组字段。
 * 非数组直接拒绝——历史上放过字符串导致 (tags||[]).join 在搜索路径抛 TypeError，
 * 一条脏数据就能让 /search 对所有人 500。
 * @param {*} v
 * @param {string} field
 * @returns {string[]|undefined} undefined 表示未提供
 */
function cleanStringArray(v, field) {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw badRequest(`${field} 必须是字符串数组`);
  const arr = v.map((x) => String(x).trim()).filter(Boolean);
  if (arr.length > MAX_LIST_ITEMS) throw badRequest(`${field} 最多 ${MAX_LIST_ITEMS} 项`);
  for (const s of arr) {
    if (s.length > MAX_LIST_ITEM_LEN) throw badRequest(`${field} 单项最长 ${MAX_LIST_ITEM_LEN} 字符`);
  }
  return arr;
}

/**
 * @typedef {object} Task
 * @property {string} id
 * @property {string} title
 * @property {string} description
 * @property {'open'|'claimed'|'done'} status
 * @property {string|null} assignee
 * @property {string} createdBy
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string} [branchId]
 * @property {string[]} tags
 * @property {'urgent'|'high'|'medium'|'low'} priority
 * @property {string[]} labels
 * @property {string|null} dueDate  ISO 8601 日期
 * @property {number} commentCount
 */

/**
 * @param {object} deps
 * @param {ReturnType<import('./eventlog.js').createEventLog>} deps.eventLog
 * @param {(reviewId: string) => any} [deps.getReview] 释放他人任务时校验审核用
 */
export function createTaskStore({ eventLog, getReview }) {
  // 存储路径固定为模块常量，不接受调用方注入（避免任何动态输入到达文件路径）
  /** @returns {Record<string, Task>} */
  const load = () => readJson(PATHS.tasks, {});
  /** @param {Record<string, Task>} state */
  const save = (state) => writeJson(PATHS.tasks, state);

  /** 兼容旧数据：补全新字段，矫正历史脏数据（如 tags 被存成字符串） */
  function normalize(t) {
    if (!t.priority) t.priority = 'medium';
    if (!Array.isArray(t.labels)) t.labels = t.labels ? [String(t.labels)] : [];
    if (!Array.isArray(t.tags)) t.tags = t.tags ? [String(t.tags)] : [];
    if (t.dueDate === undefined) t.dueDate = null;
    if (!Number.isFinite(t.commentCount)) t.commentCount = 0;
    return t;
  }

  /**
   * @param {string} id
   * @returns {Task}
   */
  function mustGet(id) {
    const t = load()[id];
    if (!t) throw notFound(`任务不存在：${id}`);
    return normalize(t);
  }

  /**
   * @param {{status?: string, assignee?: string, priority?: string, label?: string, q?: string}} [filter]
   * @returns {Task[]}
   */
  function list(filter = {}) {
    let tasks = Object.values(load()).map(normalize);
    if (filter.status) tasks = tasks.filter((t) => t.status === filter.status);
    if (filter.assignee) tasks = tasks.filter((t) => t.assignee === filter.assignee);
    if (filter.priority) tasks = tasks.filter((t) => t.priority === filter.priority);
    if (filter.label) tasks = tasks.filter((t) => (t.labels || []).includes(filter.label));
    if (filter.q) {
      const q = filter.q.toLowerCase();
      tasks = tasks.filter((t) =>
        (t.title + ' ' + t.description + ' ' + (t.tags || []).join(' ') + ' ' + (t.labels || []).join(' '))
          .toLowerCase()
          .includes(q),
      );
    }
    // 排序：优先级 > 状态 > 创建时间
    return tasks.sort((a, b) => {
      const pc = (PRIORITY_WEIGHT[a.priority] ?? 9) - (PRIORITY_WEIGHT[b.priority] ?? 9);
      if (pc !== 0) return pc;
      return a.createdAt.localeCompare(b.createdAt);
    });
  }

  /**
   * @param {{userId: string, title: string, description?: string, tags?: string[],
   *          branchId?: string, priority?: string, labels?: string[], dueDate?: string}} input
   * @returns {Task}
   */
  function create(input) {
    // 统一收口成字符串再校验：传数字 / 布尔 / 对象进来时，
    // `title.trim()` 会直接 TypeError 变成 500，而它本该是一条 400。
    const title = typeof input.title === 'string' ? input.title : String(input.title ?? '');
    const description = input.description == null ? '' : String(input.description);
    if (!title.trim()) throw badRequest('任务 title 不能为空');
    if (title.length > MAX_TITLE) throw badRequest(`title 最长 ${MAX_TITLE} 字符`);
    if (description.length > MAX_DESCRIPTION) {
      throw badRequest(`description 最长 ${MAX_DESCRIPTION} 字符`);
    }
    const priority = input.priority ?? 'medium';
    if (!VALID_PRIORITIES.has(priority)) throw badRequest(`priority 必须是 ${[...VALID_PRIORITIES].join(' | ')}`);
    if (input.dueDate && isNaN(Date.parse(input.dueDate))) throw badRequest('dueDate 必须是有效的 ISO 日期');
    const tags = cleanStringArray(input.tags, 'tags') ?? [];
    const labels = cleanStringArray(input.labels, 'labels') ?? [];

    const now = new Date().toISOString();
    /** @type {Task} */
    const task = {
      id: randomUUID(),
      title: title.trim(),
      description,
      status: 'open',
      assignee: null,
      createdBy: input.userId,
      createdAt: now,
      updatedAt: now,
      branchId: input.branchId,
      tags,
      priority,
      labels,
      dueDate: input.dueDate ?? null,
      commentCount: 0,
    };
    const state = load();
    state[task.id] = task;
    save(state);
    eventLog.append({
      type: 'task.created',
      authorId: input.userId,
      payload: { id: task.id, title: task.title, priority, labels: task.labels },
    });
    return task;
  }

  /**
   * @param {string} id
   * @param {string} userId
   * @returns {Task}
   */
  function claim(id, userId) {
    const state = load();
    const task = state[id];
    if (!task) throw notFound(`任务不存在：${id}`);
    // 已完成的任务不该再被认领：否则任务板会把交付过的活重新拉回进行中
    if (task.status === 'done') throw conflict('任务已完成，无需再认领');
    if (task.assignee && task.assignee !== userId) {
      throw conflict(`任务已被 ${task.assignee} 认领，释放需走审核`, { assignee: task.assignee });
    }
    if (task.assignee === userId) return normalize(task); // 幂等

    task.assignee = userId;
    task.status = 'claimed';
    task.updatedAt = new Date().toISOString();
    save(state);
    eventLog.append({
      type: 'task.claimed',
      authorId: userId,
      payload: { id: task.id, title: task.title },
    });
    return normalize(task);
  }

  /**
   * @param {string} id
   * @param {string} userId
   * @param {{title?: string, description?: string, status?: 'open'|'claimed'|'done',
   *          tags?: string[], branchId?: string, priority?: string, labels?: string[],
   *          dueDate?: string|null, assignee?: string|null}} patch
   * @returns {Task}
   */
  function update(id, userId, patch) {
    const state = load();
    const task = state[id];
    if (!task) throw notFound(`任务不存在：${id}`);
    if (task.assignee !== userId && task.createdBy !== userId) {
      throw forbidden('只有任务持有者或创建者可更新任务', { owner: task.assignee, createdBy: task.createdBy });
    }
    if (patch == null || typeof patch !== 'object') throw badRequest('更新体必须为对象');
    if ('assignee' in patch) {
      throw badRequest('assignee 不能经 PATCH 修改，请走 claim / release 接口');
    }
    if (patch.priority && !VALID_PRIORITIES.has(patch.priority)) {
      throw badRequest(`priority 必须是 ${[...VALID_PRIORITIES].join(' | ')}`);
    }
    if (patch.status !== undefined && !VALID_STATUSES.has(patch.status)) {
      throw badRequest(`status 必须是 ${[...VALID_STATUSES].join(' | ')}`);
    }
    if (patch.dueDate !== undefined && patch.dueDate !== null && isNaN(Date.parse(patch.dueDate))) {
      throw badRequest('dueDate 必须是有效的 ISO 日期');
    }
    if (patch.title !== undefined) {
      if (!String(patch.title).trim()) throw badRequest('任务 title 不能为空');
      if (String(patch.title).length > MAX_TITLE) throw badRequest(`title 最长 ${MAX_TITLE} 字符`);
    }
    if (patch.description !== undefined && patch.description !== null && patch.description.length > MAX_DESCRIPTION) {
      throw badRequest(`description 最长 ${MAX_DESCRIPTION} 字符`);
    }
    const tags = cleanStringArray(patch.tags, 'tags');
    const labels = cleanStringArray(patch.labels, 'labels');
    // 状态一致性：认领 / 释放各有专用接口且带归属校验，PATCH 里改出这两种状态会绕过它们
    if (patch.status === 'claimed' && task.assignee !== userId) {
      throw badRequest('status=claimed 请走 claim 接口认领任务', { hint: 'POST /tasks/:id/claim' });
    }
    if (patch.status === 'open' && task.assignee && task.assignee !== userId) {
      throw forbidden('释放他人认领的任务需走 release 接口（须出示 approved 审核）', { hint: 'POST /tasks/:id/release' });
    }
    for (const key of ['title', 'description', 'status', 'branchId', 'priority', 'dueDate']) {
      if (patch[key] !== undefined) task[key] = patch[key];
    }
    if (tags !== undefined) task.tags = tags;
    if (labels !== undefined) task.labels = labels;
    // 归位 open 的同时清空认领人，避免出现「open 但仍被持有」的矛盾状态
    if (patch.status === 'open') task.assignee = null;
    task.updatedAt = new Date().toISOString();
    save(state);
    eventLog.append({
      type: 'task.updated',
      authorId: userId,
      payload: { id: task.id, fields: Object.keys(patch) },
    });
    return normalize(task);
  }

  /**
   * 释放任务。释放自己的随意；释放他人必须出示 approved 的审核记录。
   */
  function release(id, userId, opts = {}) {
    const state = load();
    const task = state[id];
    if (!task) throw notFound(`任务不存在：${id}`);
    if (!task.assignee) return normalize(task);

    if (task.assignee !== userId) {
      if (!opts.reviewId) {
        throw forbidden(
          `释放 ${task.assignee} 的任务需提供 reviewId（针对该任务且已 approved）`,
          { assignee: task.assignee },
        );
      }
      if (!getReview) throw conflict('服务端未装配审核模块，无法强制释放');
      const review = getReview(opts.reviewId);
      if (!review) throw notFound(`审核记录不存在：${opts.reviewId}`);
      if (review.taskId !== id) {
        throw badRequest('审核记录与该任务不匹配', { reviewTaskId: review.taskId, taskId: id });
      }
      if (review.status !== 'approved') {
        throw conflict(`审核记录尚未 approved（当前：${review.status}）`);
      }
    }

    const previous = task.assignee;
    task.assignee = null;
    task.status = 'open';
    task.updatedAt = new Date().toISOString();
    save(state);
    eventLog.append({
      type: 'task.released',
      authorId: userId,
      payload: { id: task.id, previousAssignee: previous, forced: previous !== userId, reviewId: opts.reviewId ?? null },
    });
    return normalize(task);
  }

  /** 递增评论计数（评论模块调用） */
  function incComment(id, delta = 1) {
    const state = load();
    const task = state[id];
    if (!task) return;
    task.commentCount = Math.max(0, (task.commentCount ?? 0) + delta);
    save(state);
  }

  /**
   * 删除任务。仅创建者或管理员可删（isAdmin 由路由层按 admin:write 传入）。
   * @param {string} id
   * @param {string} userId
   * @param {boolean} [isAdmin=false]
   * @returns {{id: string, removed: boolean}}
   */
  function remove(id, userId, isAdmin = false) {
    const state = load();
    const task = state[id];
    if (!task) throw notFound(`任务不存在：${id}`);
    if (task.createdBy !== userId && !isAdmin) {
      throw forbidden('只有任务创建者或管理员可删除任务', { createdBy: task.createdBy });
    }
    delete state[id];
    save(state);
    eventLog.append({
      type: 'task.deleted',
      authorId: userId,
      payload: { id, title: task.title },
    });
    return { id, removed: true };
  }

  /** 任务统计（仪表盘用） */
  function stats() {
    const all = Object.values(load()).map(normalize);
    const byStatus = { open: 0, claimed: 0, done: 0 };
    const byPriority = { urgent: 0, high: 0, medium: 0, low: 0 };
    const byAssignee = {};
    let overdue = 0;
    const now = Date.now();
    for (const t of all) {
      byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
      byPriority[t.priority] = (byPriority[t.priority] ?? 0) + 1;
      if (t.assignee) byAssignee[t.assignee] = (byAssignee[t.assignee] ?? 0) + 1;
      if (t.dueDate && t.status !== 'done' && Date.parse(t.dueDate) < now) overdue++;
    }
    return { total: all.length, byStatus, byPriority, byAssignee, overdue };
  }

  return { list, create, claim, update, release, get: mustGet, incComment, stats, remove };
}
