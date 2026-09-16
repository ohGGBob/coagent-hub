/**
 * 自动数据备份（零第三方依赖）—— 商用可靠性基础设施。
 *
 * 定时把核心数据（用户/任务/审核/评论/上下文/事件/向量/Webhook/文件元数据/
 * 授权/首跑时间戳）导出为单个 JSON 快照，写入 data/backup/，默认保留最近 7 份。
 * 备份是基础可靠性能力，对社区版开放（不设专业版门控）。
 *
 * 配置：
 *  - COAGENT_BACKUP_HOURS=24   自动备份间隔（小时），设 0 关闭自动备份
 *  - COAGENT_BACKUP_KEEP=7     保留份数
 *  - 手动触发 POST /admin/backup 不受间隔限制
 *
 * @module backup
 */

import fs from 'node:fs';
import path from 'node:path';
import { PATHS, HUB_VERSION } from './config.js';

const BACKUP_DIR = path.join(PATHS.data, 'backup');
const LAST_MARKER = path.join(BACKUP_DIR, 'last-backup.json');
const BACKUP_HOURS = Number(process.env.COAGENT_BACKUP_HOURS ?? 24);
const BACKUP_KEEP = Number(process.env.COAGENT_BACKUP_KEEP ?? 7);
const NAME_RE = /^coagent-backup-\d{8}-\d{6}\.json$/;

/** 采集当前全部核心数据（与 /admin/export 同口径） */
export function snapshot() {
  const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  const readJsonl = (file) => {
    try {
      return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    } catch { return []; }
  };
  return {
    exportedAt: new Date().toISOString(),
    kind: 'coagent-backup',
    version: HUB_VERSION,
    users: readJson(PATHS.users),
    tasks: readJson(PATHS.tasks),
    reviews: readJson(PATHS.reviews),
    comments: readJson(PATHS.comments),
    context: readJsonl(PATHS.context),
    vectors: readJsonl(PATHS.vectors),
    events: readJsonl(PATHS.events),
    webhooks: readJson(PATHS.webhooks),
    files: readJson(PATHS.fileMeta),
    license: readJson(PATHS.license),
    firstRun: readJson(PATHS.firstRun),
  };
}

/** 执行一次备份，返回本次快照文件名 */
export function runBackup() {
  const ts = new Date();
  const stamp = [
    ts.getFullYear(),
    String(ts.getMonth() + 1).padStart(2, '0'),
    String(ts.getDate()).padStart(2, '0'),
  ].join('') + '-' + [String(ts.getHours()).padStart(2, '0'), String(ts.getMinutes()).padStart(2, '0'), String(ts.getSeconds()).padStart(2, '0')].join('');
  const file = `coagent-backup-${stamp}.json`;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const buf = Buffer.from(JSON.stringify(snapshot(), null, 2), 'utf8');
  const tmp = path.join(BACKUP_DIR, `${file}.tmp`);
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, path.join(BACKUP_DIR, file));
  fs.writeFileSync(LAST_MARKER, JSON.stringify({ lastAt: new Date().toISOString(), file }));
  pruneOld();
  return { file, size: buf.length, at: new Date().toISOString() };
}

/** 保留最近 N 份，删更早的（只删 coagent-backup-*.json，绝不碰其他文件） */
function pruneOld() {
  const keep = Math.max(1, BACKUP_KEEP);
  let names;
  try { names = fs.readdirSync(BACKUP_DIR).filter((n) => NAME_RE.test(n)); } catch { return; }
  names.sort();
  for (const n of names.slice(0, Math.max(0, names.length - keep))) {
    try { fs.rmSync(path.join(BACKUP_DIR, n), { force: true }); } catch { /* 忽略 */ }
  }
}

/** 备份列表（新 → 旧） */
export function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter((n) => NAME_RE.test(n))
      .sort()
      .reverse()
      .map((name) => {
        const st = fs.statSync(path.join(BACKUP_DIR, name));
        return {
          name,
          size: st.size,
          at: st.mtime.toISOString(),
          // 备份名即时间戳，直接可读
          human: name.replace('coagent-backup-', '').replace('.json', '').replace(/(\d{8})-(\d{6})/, '$1 $2'),
        };
      });
  } catch {
    return [];
  }
}

/** 读取指定备份文件（防路径穿越：仅接受白名单文件名） */
export function readBackup(name) {
  const clean = String(name ?? '');
  if (!NAME_RE.test(clean)) throw new Error('非法的备份文件名');
  const file = path.join(BACKUP_DIR, clean);
  if (!fs.existsSync(file)) throw new Error('备份不存在');
  return fs.readFileSync(file);
}

/** 上次自动备份时间 */
export function lastBackupInfo() {
  try {
    return JSON.parse(fs.readFileSync(LAST_MARKER, 'utf8'));
  } catch {
    return null;
  }
}

/** 到点则自动备份（由 server 启动时调度 + 周期检查） */
export function maybeAutoBackup() {
  if (!(BACKUP_HOURS > 0)) return null;
  const last = lastBackupInfo();
  if (last?.lastAt && Date.now() - Date.parse(last.lastAt) < BACKUP_HOURS * 3_600_000) return null;
  try {
    return runBackup();
  } catch (err) {
    console.error('[backup] 自动备份失败：', err?.message);
    return null;
  }
}
