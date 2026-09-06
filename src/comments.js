/**
 * 评论系统（v0.5 新增）。
 *
 * 支持两种评论目标：
 *  - task:<taskId>    任务评论
 *  - review:<reviewId> 审核/PR 评论
 *
 * 规则：
 *  - 任何登录用户可发表评论
 *  - 仅作者可删除自己的评论（软删除，留痕）
 *  - 评论支持 Markdown 纯文本存储，前端渲染
 *
 * @module comments
 */

import { randomUUID } from 'node:crypto';
import { PATHS } from './config.js';
import { readJson, writeJson } from './jsonfile.js';
import { notFound, forbidden, badRequest } from './errors.js';

/**
 * @typedef {object} Comment
 * @property {string} id
 * @property {string} target  如 "task:uuid" 或 "review:uuid"
 * @property {string} authorId
 * @property {string} body
 * @property {string} createdAt
 * @property {string} [updatedAt]
 * @property {boolean} deleted
 */

/**
 * @param {object} deps
 * @param {string} [deps.file]
 * @param {ReturnType<import('./eventlog.js').createEventLog>} deps.eventLog
 * @param {(taskId: string, delta: number) => void} [deps.onTaskComment] 任务评论计数回调
 */
export function createCommentStore({ file = PATHS.comments, eventLog, onTaskComment }) {
  const load = () => readJson(file, {});
  const save = (s) => writeJson(file, s);

  function targetKey(type, id) {
    if (!['task', 'review'].includes(type)) throw badRequest(`评论目标类型必须是 task 或 review， got: ${type}`);
    return `${type}:${id}`;
  }

  /**
   * 发表评论。
   * @param {{type: 'task'|'review', targetId: string, authorId: string, body: string}} input
   */
  function create({ type, targetId, authorId, body }) {
    if (!body?.trim()) throw badRequest('评论内容不能为空');
    const target = targetKey(type, targetId);
    const now = new Date().toISOString();
    /** @type {Comment} */
    const comment = {
      id: randomUUID(),
      target,
      authorId,
      body: body.trim(),
      createdAt: now,
      deleted: false,
    };
    const state = load();
    state[comment.id] = comment;
    save(state);

    if (type === 'task' && onTaskComment) onTaskComment(targetId, 1);

    eventLog.append({
      type: 'comment.posted',
      authorId,
      payload: { id: comment.id, target, preview: comment.body.slice(0, 80) },
    });
    return comment;
  }

  /**
   * 列出某目标的所有评论（按时间正序，不含已删除的正文）。
   * @param {'task'|'review'} type
   * @param {string} targetId
   */
  function list(type, targetId) {
    const target = targetKey(type, targetId);
    return Object.values(load())
      .filter((c) => c.target === target)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((c) => (c.deleted ? { ...c, body: null } : c));
  }

  /**
   * 删除自己的评论（软删除）。
   */
  function remove(id, userId) {
    const state = load();
    const c = state[id];
    if (!c) throw notFound(`评论不存在：${id}`);
    if (c.authorId !== userId) throw forbidden('只能删除自己的评论');
    if (c.deleted) return { id, deleted: true };
    c.deleted = true;
    save(state);

    const [type, targetId] = c.target.split(':');
    if (type === 'task' && onTaskComment) onTaskComment(targetId, -1);

    eventLog.append({
      type: 'comment.deleted',
      authorId: userId,
      payload: { id, target: c.target },
    });
    return { id, deleted: true };
  }

  return { create, list, remove };
}
