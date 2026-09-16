/**
 * 授权与试用系统（零第三方依赖，Ed25519 签名校验）。
 *
 * 商用化核心：
 *  - 授权文件 data/license.json 或环境变量 COAGENT_LICENSE_KEY 提供授权 key：
 *    key = base64(JSON{ data: string, signature: base64 })，
 *    signature = Ed25519(data) 私钥由维护者持有（scripts/dev-keys/ 下，
 *    不入库），公钥内嵌本文件，运行时校验。
 *  - 授权 payload：{ org, edition, seats, issuedAt, expiresAt, features }。
 *  - 版别：community（社区版，基础协作） / pro（专业版，全功能）。
 *  - 无有效授权时进入 30 天 Pro 试用（以首次运行时间为基准），到期降级社区版。
 *  - can(feature) 统一门控：webhooks / tls / audit / export / updates / embed。
 *
 * @module license
 */

import fs from 'node:fs';
import path from 'node:path';
import { createPublicKey, verify } from 'node:crypto';
import { PATHS } from './config.js';
import { badRequest } from './errors.js';

/** 内置公钥（Ed25519 SPKI DER，base64）。私钥仅维护者持有，不入库。 */
const PUBLIC_KEY_DER_B64 = 'MCowBQYDK2VwAyEA4e+f2kbqCHjMs5KrHxnmDS/3mPi1OXiUbMloAN4ZcHE=';

/** 全功能清单（专业版） */
export const ALL_FEATURES = Object.freeze(['webhooks', 'tls', 'audit', 'export', 'updates', 'embed']);

/** 试用天数 */
export const TRIAL_DAYS = 30;

const publicKey = createPublicKey({ key: Buffer.from(PUBLIC_KEY_DER_B64, 'base64'), format: 'der', type: 'spki' });

/** 首次运行时间（试用期基准），幂等写入 */
function firstRunAt() {
  try {
    const j = JSON.parse(fs.readFileSync(PATHS.firstRun, 'utf8'));
    if (j.installedAt) return new Date(j.installedAt).getTime();
  } catch { /* 不存在则创建 */ }
  const now = Date.now();
  fs.mkdirSync(path.dirname(PATHS.firstRun), { recursive: true });
  fs.writeFileSync(PATHS.firstRun, JSON.stringify({ installedAt: new Date(now).toISOString() }));
  return now;
}

/**
 * 解析并校验授权 key。
 * @param {string} key base64(JSON{data, signature})
 * @returns {object} payload
 * @throws {Error} 任何一步不合法即拒绝（fail-closed）
 */
export function parseAndVerify(key) {
  const raw = String(key ?? '').trim();
  if (!raw) throw badRequest('授权 key 为空');
  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    throw badRequest('授权 key 格式无效（应为 base64 编码的 JSON）');
  }
  if (!envelope || typeof envelope.data !== 'string' || typeof envelope.signature !== 'string') {
    throw badRequest('授权 key 缺少 data 或 signature');
  }
  let ok;
  try {
    ok = verify(
      null,
      Buffer.from(envelope.data, 'utf8'),
      publicKey,
      Buffer.from(envelope.signature, 'base64'),
    );
  } catch {
    ok = false;
  }
  if (!ok) throw badRequest('授权签名校验失败（key 被篡改或非官方签发）');
  let payload;
  try {
    payload = JSON.parse(envelope.data);
  } catch {
    throw badRequest('授权数据不是合法 JSON');
  }
  if (!payload || typeof payload !== 'object') throw badRequest('授权数据为空');
  const edition = String(payload.edition ?? '');
  if (edition !== 'pro' && edition !== 'enterprise') {
    throw badRequest('未知授权版别：' + edition);
  }
  if (!payload.expiresAt || Number.isNaN(Date.parse(payload.expiresAt))) {
    throw badRequest('授权缺少有效过期时间');
  }
  if (Date.parse(payload.expiresAt) < Date.now()) {
    throw badRequest(`授权已于 ${payload.expiresAt} 过期`);
  }
  return {
    edition: 'pro',
    label: edition === 'enterprise' ? '企业版' : '专业版',
    org: String(payload.org ?? '未命名组织').slice(0, 120),
    seats: Number.isInteger(payload.seats) && payload.seats > 0 ? payload.seats : 1,
    issuedAt: payload.issuedAt ?? null,
    expiresAt: payload.expiresAt,
    features: [...ALL_FEATURES],
  };
}

/** 读取已存授权 key（env 优先，其次授权文件） */
function storedKey() {
  if (process.env.COAGENT_LICENSE_KEY) return process.env.COAGENT_LICENSE_KEY.trim();
  try {
    const j = JSON.parse(fs.readFileSync(PATHS.license, 'utf8'));
    if (typeof j.key === 'string' && j.key.trim()) return j.key.trim();
  } catch { /* 无授权文件 */ }
  return null;
}

/**
 * 当前授权状态（幂等，每次调用重新校验）。
 * @returns {{edition: 'community'|'pro', label: string, org: string|null,
 *   seats: number, expiresAt: string|null, features: string[],
 *   trial: {active: boolean, daysLeft: number, expiresAt: string|null}|null,
 *   source: 'none'|'env'|'file'|'trial', detail: string|null}}
 */
export function current() {
  const key = storedKey();
  if (key) {
    try {
      const payload = parseAndVerify(key);
      return {
        edition: payload.edition,
        label: payload.label,
        org: payload.org,
        seats: payload.seats,
        expiresAt: payload.expiresAt,
        features: payload.features,
        trial: null,
        source: process.env.COAGENT_LICENSE_KEY ? 'env' : 'file',
        detail: null,
      };
    } catch (err) {
      return {
        edition: 'community',
        label: '社区版',
        org: null,
        seats: 1,
        expiresAt: null,
        features: [],
        trial: null,
        source: 'none',
        detail: `授权无效：${err.message}`,
      };
    }
  }
  // 无授权 → Pro 试用
  const installed = firstRunAt();
  const trialExpires = installed + TRIAL_DAYS * 86_400_000;
  const daysLeft = Math.max(0, Math.ceil((trialExpires - Date.now()) / 86_400_000));
  if (daysLeft > 0) {
    return {
      edition: 'pro',
      label: '专业版',
      org: '试用',
      seats: 10,
      expiresAt: new Date(trialExpires).toISOString(),
      features: [...ALL_FEATURES],
      trial: { active: true, daysLeft, expiresAt: new Date(trialExpires).toISOString() },
      source: 'trial',
      detail: null,
    };
  }
  return {
    edition: 'community',
    label: '社区版',
    org: null,
    seats: 1,
    expiresAt: null,
    features: [],
    trial: { active: false, daysLeft: 0, expiresAt: null },
    source: 'none',
    detail: '试用已结束，激活专业版授权以解锁全部功能',
  };
}

/** 功能门控 */
export function can(feature) {
  return current().features.includes(feature);
}

/** 激活授权：校验通过后持久化到 data/license.json */
export function activate(key) {
  const payload = parseAndVerify(key);
  fs.mkdirSync(path.dirname(PATHS.license), { recursive: true });
  const tmp = `${PATHS.license}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ key: key.trim() }, null, 2));
  fs.renameSync(tmp, PATHS.license);
  return payload;
}

/** 移除授权，回到试用/社区状态 */
export function deactivate() {
  try {
    fs.rmSync(PATHS.license, { force: true });
  } catch { /* 无授权文件 */ }
}
