/**
 * 审计日志（零依赖）—— 管理操作留痕，商用合规要求。
 *
 * 与事件日志（业务真相源）分离：这里只记录「谁在什么时候对系统配置
 * 做了什么」：用户开户/轮换/注销、Webhook 管理、授权激活/移除、
 * 数据导出、关机、自更新、应急重置。追加式 JSONL，不可变。
 *
 * @module audit
 */

import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.js';

const FILE = PATHS.audit;

/** 追加一条审计记录（同步落盘） */
export function appendAudit(userId, action, detail = {}) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const rec = {
      ts: new Date().toISOString(),
      userId,
      action,
      detail: detail && typeof detail === 'object' ? detail : { note: String(detail) },
    };
    fs.appendFileSync(FILE, JSON.stringify(rec) + '\n');
  } catch (err) {
    // 审计失败不阻断业务，但必须输出到 stderr 可查
    console.error('[audit] 写入失败：', err.message);
  }
}

/** 读取最近 N 条审计记录（新 → 旧） */
export function recentAudit(limit = 500) {
  try {
    const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter((l) => l.trim());
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        out.push(JSON.parse(lines[i]));
      } catch { /* 跳过损坏行 */ }
    }
    return out;
  } catch {
    return [];
  }
}
