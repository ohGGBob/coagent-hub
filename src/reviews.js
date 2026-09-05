/**
 * 审核记录 / PR（设计文档 §4 PullRequest）。
 *
 * Phase 1 只做「可落盘、可校验、可追溯」的闸门骨架：
 *  - 申请人只能为自己的私有分支发起审核；
 *  - 禁止自审（reviewer !== author）；
 *  - approve 不等于自动合并，合并是独立的显式动作；
 *  - 非 fast-forward 一律拒绝，冲突由 agent 本地 rebase 解决（设计文档 §9.5）。
 *
 * @module reviews
 */

import { randomUUID } from 'node:crypto';
import { PATHS, privateBranch } from './config.js';
import { readJson, writeJson } from './jsonfile.js';
import { notFound, conflict, forbidden, badRequest } from './errors.js';

/**
 * @typedef {object} Review
 * @property {string} id
 * @property {string} branch
 * @property {string} base
 * @property {string} [taskId]
 * @property {string} author
 * @property {'open'|'approved'|'rejected'|'merged'} status
 * @property {string[]} approvals
 * @property {Array<{by: string, at: string, reason?: string}>} rejections
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {{from: string, to: string}|null} merge
 */

/**
 * @param {object} deps
 * @param {string} [deps.file]
 * @param {ReturnType<import('./eventlog.js').createEventLog>} deps.eventLog
 * @param {(branch: string, base: string) => {fastForward: boolean, from?: string, to?: string, ahead?: string[], behind?: string[]}} deps.mergeFF
 */
export function createReviewStore({ file = PATHS.reviews, eventLog, mergeFF }) {
  /** @returns {Record<string, Review>} */
  const load = () => readJson(file, {});
  /** @param {Record<string, Review>} state */
  const save = (state) => writeJson(file, state);

  /**
   * @param {string} id
   * @returns {Review}
   */
  function get(id) {
    const r = load()[id];
    if (!r) throw notFound(`审核记录不存在：${id}`);
    return r;
  }

  /**
   * @param {{status?: string, branch?: string}} [filter]
   * @returns {Review[]}
   */
  function list(filter = {}) {
    return Object.values(load())
      .filter((r) => (filter.status ? r.status === filter.status : true))
      .filter((r) => (filter.branch ? r.branch === filter.branch : true))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * @param {{userId: string, branch?: string, base?: string, taskId?: string}} input
   * @returns {Review}
   */
  function create(input) {
    const base = input.base ?? 'main';
    const branch = input.branch ?? privateBranch(input.userId);
    if (!input.branch && !input.taskId) {
      throw badRequest('发起审核需提供 branch 或 taskId');
    }
    if (input.branch && input.branch !== privateBranch(input.userId)) {
      throw forbidden(`只能为自己的私有分支发起审核（你的分支：${privateBranch(input.userId)}）`, {
        requested: input.branch,
      });
    }
    const now = new Date().toISOString();
    /** @type {Review} */
    const review = {
      id: randomUUID(),
      branch,
      base,
      taskId: input.taskId,
      author: input.userId,
      status: 'open',
      approvals: [],
      rejections: [],
      createdAt: now,
      updatedAt: now,
      merge: null,
    };
    const state = load();
    state[review.id] = review;
    save(state);
    eventLog.append({
      type: 'review.requested',
      authorId: input.userId,
      payload: { id: review.id, branch, base, taskId: review.taskId ?? null },
    });
    return review;
  }

  /**
   * @param {string} id
   * @param {string} reviewerId
   * @returns {Review}
   */
  function approve(id, reviewerId) {
    const state = load();
    const review = state[id];
    if (!review) throw notFound(`审核记录不存在：${id}`);
    if (review.author === reviewerId) throw forbidden('禁止自审：不能批准自己的 PR');
    if (review.status === 'merged') throw conflict('该 PR 已合并');
    if (review.status === 'rejected') throw conflict('该 PR 已被拒绝，请重新发起');

    if (!review.approvals.includes(reviewerId)) review.approvals.push(reviewerId);
    review.status = 'approved';
    review.updatedAt = new Date().toISOString();
    save(state);
    eventLog.append({
      type: 'review.approved',
      authorId: reviewerId,
      payload: { id: review.id, branch: review.branch, base: review.base, approvals: review.approvals.length },
    });
    return review;
  }

  /**
   * @param {string} id
   * @param {string} reviewerId
   * @param {string} [reason]
   * @returns {Review}
   */
  function reject(id, reviewerId, reason) {
    const state = load();
    const review = state[id];
    if (!review) throw notFound(`审核记录不存在：${id}`);
    if (review.status === 'merged') throw conflict('该 PR 已合并，无法拒绝');

    review.rejections.push({ by: reviewerId, at: new Date().toISOString(), reason });
    review.status = 'rejected';
    review.updatedAt = new Date().toISOString();
    save(state);
    eventLog.append({
      type: 'review.rejected',
      authorId: reviewerId,
      payload: { id: review.id, branch: review.branch, reason: reason ?? null },
    });
    return review;
  }

  /**
   * 合入受保护分支。要求：已 approved + 可 fast-forward。
   * @param {string} id
   * @param {string} userId
   * @returns {{review: Review, merge: object}}
   */
  function merge(id, userId) {
    const state = load();
    const review = state[id];
    if (!review) throw notFound(`审核记录不存在：${id}`);
    if (review.status === 'merged') throw conflict('该 PR 已合并');
    if (review.status !== 'approved') {
      throw conflict(`PR 尚未 approved（当前：${review.status}）`, { status: review.status });
    }
    const result = mergeFF(review.branch, review.base);
    if (!result.fastForward) {
      // 冲突 UX：把双方分叉的提交抛回给 agent，让它本地 rebase 后重新推送
      throw conflict('无法 fast-forward：分支已分叉，请 rebase 后重新推送', {
        branch: review.branch,
        base: review.base,
        ahead: result.ahead,
        behind: result.behind,
      });
    }
    review.status = 'merged';
    review.merge = { from: result.from, to: result.to };
    review.updatedAt = new Date().toISOString();
    save(state);
    eventLog.append({
      type: 'branch.merged',
      authorId: userId,
      payload: { reviewId: review.id, branch: review.branch, base: review.base, from: result.from, to: result.to },
    });
    return { review, merge: result };
  }

  return { list, get, create, approve, reject, merge };
}
