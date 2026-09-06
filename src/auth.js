/**
 * 鉴权：静态 users.json + 长期 token（已确认方案）。
 *
 * 生产化路径：换成 HMAC 签名 token + 过期时间即可，对外只暴露
 * `verify()` / `requireScope()` 两个函数，上层无感知。
 *
 * @module auth
 */

import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { PATHS } from './config.js';
import { readJson, writeJson } from './jsonfile.js';
import { unauthorized, forbidden, conflict, notFound, badRequest } from './errors.js';

/** 全部可用 scope */
export const SCOPES = Object.freeze([
  'events:read',
  'context:read',
  'context:write',
  'task:read',
  'task:write',
  'branch:read',
  'branch:push',
  'branch:merge',
  'review:read',
  'review:write',
  'message:write',
  'admin:write',
]);

/** 普通 agent 默认 scope：不含管理权限（开户时默认发放） */
const AGENT_SCOPES = SCOPES.filter((s) => s !== 'admin:write');
/** 管理员 scope：全量（种子账号 bootstrap 用，显式授权亦可） */
const ADMIN_SCOPES = [...SCOPES];

/**
 * @typedef {object} User
 * @property {string} id
 * @property {string} name
 * @property {string} token
 * @property {string[]} scopes
 */

/** 首次启动时写入的种子用户（冒烟测试依赖这两个账号） */
const SEED_USERS = [
  { id: 'alice', name: 'Alice', token: 'tok_alice_0001', scopes: ADMIN_SCOPES },
  { id: 'bob', name: 'Bob', token: 'tok_bob_0002', scopes: ADMIN_SCOPES },
];

/** 种子默认 token 集合——写死在源码里（已公开），正式部署前必须轮换，勿当真实凭证 */
const SEED_TOKENS = new Set(SEED_USERS.map((u) => u.token));

/** 用户表内存缓存（带 mtime 失效，避免每次 verify 都读文件） */
let _usersCache = null;
let _usersCacheMtime = 0;

/**
 * 加载用户表；文件不存在则写入种子。带内存缓存，文件未变时直接返回。
 * @returns {User[]}
 */
export function loadUsers() {
  try {
    const st = fs.statSync(PATHS.users);
    if (_usersCache && st.mtimeMs === _usersCacheMtime) return _usersCache;
    const users = readJson(PATHS.users, []);
    _usersCache = users;
    _usersCacheMtime = st.mtimeMs;
    return users;
  } catch {
    // 文件不存在：写入种子
    writeJson(PATHS.users, SEED_USERS);
    _usersCache = structuredClone(SEED_USERS);
    try { _usersCacheMtime = fs.statSync(PATHS.users).mtimeMs; } catch { _usersCacheMtime = 0; }
    return _usersCache;
  }
}

/** 使缓存失效（写操作后调用） */
function invalidateCache() { _usersCache = null; _usersCacheMtime = 0; }

/**
 * 首次启动引导信息：返回是否首次运行 + 种子管理员 token（面板可自动填充登录）。
 * 仅当种子默认 token 仍在使用时才返回 token，轮换后返回 null。
 * @returns {{firstRun: boolean, adminId: string|null, adminToken: string|null}}
 */
export function getBootstrapInfo() {
  const users = loadUsers();
  const seedAdmin = users.find((u) => SEED_TOKENS.has(u.token) && u.scopes.includes('admin:write'));
  return {
    firstRun: users.length === SEED_USERS.length && users.every((u) => SEED_TOKENS.has(u.token)),
    adminId: seedAdmin?.id ?? null,
    adminToken: seedAdmin?.token ?? null,
  };
}

/**
 * 从 Authorization: Bearer <token> 解析并校验用户。
 * @param {string|undefined} header
 * @returns {User}
 */
export function verify(header) {
  const token = (header ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) throw unauthorized('缺少 Authorization: Bearer <token>');
  const user = loadUsers().find((u) => u.token === token);
  if (!user) throw unauthorized('token 无效');
  return user;
}

/**
 * 校验 scope，缺失则 403。
 * @param {User} user
 * @param {keyof typeof SCOPES | string} scope
 */
export function requireScope(user, scope) {
  if (!user.scopes.includes(scope)) {
    throw forbidden(`当前凭证缺少 scope: ${scope}`, { need: scope, have: user.scopes });
  }
}

// ---------------------------------------------------------------------------
// 用户管理 API（v2 决策：不做手改文件，开户/轮换走端点）
// ---------------------------------------------------------------------------

/** @returns {User[]} */
function saveUsers(users) {
  writeJson(PATHS.users, users);
  invalidateCache();
  return users;
}

const newToken = () => `tok_${randomBytes(24).toString('hex')}`;

/**
 * 开户。token 省略时自动生成（推荐，避免弱 token）。
 * 不传 scopes 时默认发放普通 agent 权限（不含 admin:write），
 * 要开管理员需显式传入含 admin:write 的完整 scope 清单。
 * @param {{id: string, name?: string, scopes?: string[], token?: string}} input
 * @returns {User}
 */
export function createUser(input) {
  const id = String(input.id ?? '').trim();
  if (!/^[A-Za-z0-9_-]{2,32}$/.test(id)) {
    throw badRequest('userId 只能是 2~32 位的字母 / 数字 / _ / -', { got: input.id });
  }
  const users = loadUsers();
  if (users.some((u) => u.id === id)) throw conflict(`用户已存在：${id}`);
  for (const s of input.scopes ?? []) {
    if (!SCOPES.includes(s)) throw badRequest(`未知 scope：${s}`, { known: [...SCOPES] });
  }
  /** @type {User} */
  const user = {
    id,
    name: input.name?.trim() || id,
    token: input.token?.trim() || newToken(),
    scopes: input.scopes?.length ? [...input.scopes] : [...AGENT_SCOPES],
  };
  users.push(user);
  saveUsers(users);
  return user;
}

/** 用户列表（不含 token，防止凭证外泄）。 */
export function listUsersPublic() {
  return loadUsers().map(({ token, ...pub }) => pub);
}

/**
 * 返回仍在使用「种子默认 token」的用户 id 列表。
 * 服务启动时据此提醒：只要有人在用默认口令，就要警告换掉。
 * @returns {string[]}
 */
export function defaultTokensActive() {
  return loadUsers()
    .filter((u) => SEED_TOKENS.has(u.token))
    .map((u) => u.id);
}

/**
 * 轮换 token：旧凭证立即失效。
 * @param {string} id
 * @returns {User}
 */
export function rotateToken(id) {
  const users = loadUsers();
  const user = users.find((u) => u.id === id);
  if (!user) throw notFound(`用户不存在：${id}`);
  user.token = newToken();
  saveUsers(users);
  return user;
}

/**
 * 注销用户。不允许删掉最后一个用户（否则 Hub 变空城）。
 * @param {string} id
 * @returns {{id: string, removed: boolean}}
 */
export function deleteUser(id) {
  const users = loadUsers();
  const idx = users.findIndex((u) => u.id === id);
  if (idx < 0) throw notFound(`用户不存在：${id}`);
  if (users.length <= 1) throw conflict('至少保留一个用户');
  users.splice(idx, 1);
  saveUsers(users);
  return { id, removed: true };
}
