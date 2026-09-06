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
 * @param {string} [deps.file]
 * @param {ReturnType<import('./eventlog.js').createEventLog>} deps.eventLog
 * @param {(reviewId: string) => any} [deps.getReview] 释放他人任务时校验审核用
 */
export function createTaskStore({ file = PATHS.tasks, eventLog, getReview }) {
  /** @returns {Record<string, Task>} */
  const load = () => readJson(file, {});
  /** @param {Record<string, Task>} state */
  const save = (state) => writeJson(file, state);

  /** 兼容旧数据：补全新字段 */
  function normalize(t) {
    if (!t.priority) t.priority = 'medium';
    if (!t.labels) t.labels = [];
    if (t.dueDate === undefined) t.dueDate = null;
    if (t.commentCount === undefined) t.commentCount = 0;
    if (!t.tags) t.tags = [];
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
    if (!input.title?.trim()) throw badRequest('任务 title 不能为空');
    const priority = input.priority ?? 'medium';
    if (!VALID_PRIORITIES.has(priority)) throw badRequest(`priority 必须是 ${[...VALID_PRIORITIES].join(' | ')}`);
    if (input.dueDate && isNaN(Date.parse(input.dueDate))) throw badRequest('dueDate 必须是有效的 ISO 日期');

    const now = new Date().toISOString();
    /** @type {Task} */
    const task = {
      id: randomUUID(),
      title: input.title.trim(),
      description: input.description ?? '',
      status: 'open',
      assignee: null,
      createdBy: input.userId,
      createdAt: now,
      updatedAt: now,
      branchId: input.branchId,
      tags: input.tags ?? [],
      priority,
      labels: input.labels ?? [],
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
    if (patch.priority && !VALID_PRIORITIES.has(patch.priority)) {
      throw badRequest(`priority 必须是 ${[...VALID_PRIORITIES].join(' | ')}`);
    }
    if (patch.dueDate !== undefined && patch.dueDate !== null && isNaN(Date.parse(patch.dueDate))) {
      throw badRequest('dueDate 必须是有效的 ISO 日期');
    }
    for (const key of ['title', 'description', 'status', 'tags', 'branchId', 'priority', 'labels', 'dueDate', 'assignee']) {
      if (patch[key] !== undefined) task[key] = patch[key];
    }
    // 显式设置 assignee 为 null 时同时重置状态
    if (patch.assignee === null) task.status = 'open';
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
   * 删除任务。创建者或管理员可删（管理员判断由路由层做，这里只校验存在性）。
   * @param {string} id
   * @param {string} userId
   * @returns {{id: string, removed: boolean}}
   */
  function remove(id, userId) {
    const state = load();
    const task = state[id];
    if (!task) throw notFound(`任务不存在：${id}`);
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
