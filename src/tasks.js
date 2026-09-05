/**
 * 任务协调板（设计文档 §4 Task）。
 *
 * 权限规则：
 *  - 任何人可创建、可认领未被认领的任务。
 *  - 只有「持有者或创建者」能更新自己的任务卡。
 *  - **释放他人任务属敏感操作**：必须出示一条针对该任务、且已 approved 的审核记录
 *    （对应设计文档 §7「实时 ≠ 自动触发他人动作」）。
 *
 * @module tasks
 */

import { randomUUID } from 'node:crypto';
import { PATHS } from './config.js';
import { readJson, writeJson } from './jsonfile.js';
import { notFound, conflict, forbidden, badRequest } from './errors.js';

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

  /**
   * @param {string} id
   * @returns {Task}
   */
  function mustGet(id) {
    const t = load()[id];
    if (!t) throw notFound(`任务不存在：${id}`);
    return t;
  }

  /**
   * @param {{status?: string, assignee?: string}} [filter]
   * @returns {Task[]}
   */
  function list(filter = {}) {
    return Object.values(load())
      .filter((t) => (filter.status ? t.status === filter.status : true))
      .filter((t) => (filter.assignee ? t.assignee === filter.assignee : true))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * @param {{userId: string, title: string, description?: string, tags?: string[], branchId?: string}} input
   * @returns {Task}
   */
  function create(input) {
    if (!input.title?.trim()) throw badRequest('任务 title 不能为空');
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
    };
    const state = load();
    state[task.id] = task;
    save(state);
    eventLog.append({
      type: 'task.created',
      authorId: input.userId,
      payload: { id: task.id, title: task.title, tags: task.tags },
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
    if (task.assignee === userId) return task; // 幂等

    task.assignee = userId;
    task.status = 'claimed';
    task.updatedAt = new Date().toISOString();
    save(state);
    eventLog.append({
      type: 'task.claimed',
      authorId: userId,
      payload: { id: task.id, title: task.title },
    });
    return task;
  }

  /**
   * @param {string} id
   * @param {string} userId
   * @param {{title?: string, description?: string, status?: 'open'|'claimed'|'done',
   *          tags?: string[], branchId?: string}} patch
   * @returns {Task}
   */
  function update(id, userId, patch) {
    const state = load();
    const task = state[id];
    if (!task) throw notFound(`任务不存在：${id}`);
    if (task.assignee !== userId && task.createdBy !== userId) {
      throw forbidden('只有任务持有者或创建者可更新任务', { owner: task.assignee, createdBy: task.createdBy });
    }
    for (const key of ['title', 'description', 'status', 'tags', 'branchId']) {
      if (patch[key] !== undefined) task[key] = patch[key];
    }
    task.updatedAt = new Date().toISOString();
    save(state);
    eventLog.append({
      type: 'task.updated',
      authorId: userId,
      payload: { id: task.id, fields: Object.keys(patch) },
    });
    return task;
  }

  /**
   * 释放任务。释放自己的随意；释放他人必须出示 approved 的审核记录。
   * @param {string} id
   * @param {string} userId
   * @param {{reviewId?: string}} [opts]
   * @returns {Task}
   */
  function release(id, userId, opts = {}) {
    const state = load();
    const task = state[id];
    if (!task) throw notFound(`任务不存在：${id}`);
    if (!task.assignee) return task; // 本来就没人认领

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
    return task;
  }

  return { list, create, claim, update, release, get: mustGet };
}
