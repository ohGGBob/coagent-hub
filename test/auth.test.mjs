/**
 * auth.js 安全边界单元测试（node:test，零依赖）。
 * 每个测试文件独立进程运行，在 import 前设置独立数据目录。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.COAGENT_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent-auth-'));

const { writeJson } = await import('../src/jsonfile.js');
const { PATHS } = await import('../src/config.js');
const auth = await import('../src/auth.js');
const { HubError } = await import('../src/errors.js');

const USERS = [
  { id: 'alice', name: 'Alice', token: 'tok_alice_test', scopes: [...auth.SCOPES] },
  { id: 'carol', name: 'Carol', token: 'tok_carol_test', scopes: ['events:read', 'context:read'] },
];

/** @param {typeof USERS} users */
const seed = (users = USERS) => writeJson(PATHS.users, structuredClone(users));

beforeEach(() => seed());

test('verify：合法 Bearer token 返回用户，大小写前缀均可', () => {
  assert.equal(auth.verify('Bearer tok_alice_test').id, 'alice');
  assert.equal(auth.verify('bearer tok_alice_test').id, 'alice');
  assert.equal(auth.verify('tok_alice_test').id, 'alice');
});

test('verify：缺失 / 空白 / 错误 token 一律 401', () => {
  for (const bad of [undefined, '', 'Bearer ', 'Bearer tok_nobody', 'wrong']) {
    assert.throws(() => auth.verify(bad), (e) => e instanceof HubError && e.status === 401, `应拒绝：${JSON.stringify(bad)}`);
  }
});

test('authenticate：userId+token 双匹配，错配返回 null（不可只带 token 登录任意账号）', () => {
  assert.equal(auth.authenticate('alice', 'tok_alice_test')?.id, 'alice');
  assert.equal(auth.authenticate('alice', 'tok_carol_test'), null, 'id 与 token 错配必须拒绝');
  assert.equal(auth.authenticate('', 'tok_alice_test'), null);
  assert.equal(auth.authenticate('alice', ''), null);
  assert.equal(auth.authenticate(undefined, undefined), null);
});

test('requireScope：缺 scope 抛 403，detail 带 need/have', () => {
  auth.requireScope(auth.verify('Bearer tok_alice_test'), 'admin:write'); // 管理员放行
  try {
    auth.requireScope(auth.verify('Bearer tok_carol_test'), 'admin:write');
    assert.fail('应抛 403');
  } catch (e) {
    assert.ok(e instanceof HubError);
    assert.equal(e.status, 403);
    assert.equal(e.detail.need, 'admin:write');
    assert.deepEqual(e.detail.have, ['events:read', 'context:read']);
  }
});

test('createUser：默认 scope 不含 admin:write 与 branch:merge（审核闸门前提）', () => {
  const u = auth.createUser({ id: 'newbie' });
  assert.ok(!u.scopes.includes('admin:write'));
  assert.ok(!u.scopes.includes('branch:merge'));
  assert.ok(u.token.startsWith('tok_') && u.token.length > 20, '自动生成 token 应有足够熵');
});

test('createUser：非法 userId / 重复 / 未知 scope 拒绝', () => {
  assert.throws(() => auth.createUser({ id: 'a' }), HubError);               // 过短
  assert.throws(() => auth.createUser({ id: 'has space' }), HubError);       // 非法字符
  assert.throws(() => auth.createUser({ id: 'al!' }), HubError);             // 非法字符
  assert.throws(() => auth.createUser({ id: 'alice' }), (e) => e.status === 409);      // 重复
  assert.throws(() => auth.createUser({ id: 'dave', scopes: ['nope'] }), (e) => e.status === 400);
});

test('createUser：显式传入完整 scope 清单可开管理员', () => {
  const u = auth.createUser({ id: 'boss', scopes: [...auth.SCOPES] });
  assert.ok(u.scopes.includes('admin:write'));
});

test('rotateToken：旧 token 立即失效，新 token 可用', () => {
  const u = auth.rotateToken('carol');
  assert.throws(() => auth.verify('Bearer tok_carol_test'), HubError);
  assert.equal(auth.verify(`Bearer ${u.token}`).id, 'carol');
  assert.throws(() => auth.rotateToken('nobody'), (e) => e.status === 404);
});

test('deleteUser：不允许删最后一个用户', () => {
  const only = [{ id: 'solo', name: 'Solo', token: 'tok_solo', scopes: ['events:read'] }];
  seed(only);
  assert.throws(() => auth.deleteUser('solo'), (e) => e.status === 409);
  seed();
  assert.deepEqual(auth.deleteUser('carol'), { id: 'carol', removed: true });
  assert.throws(() => auth.deleteUser('carol'), (e) => e.status === 404);
});

test('listUsersPublic：永不泄露 token', () => {
  for (const u of auth.listUsersPublic()) {
    assert.ok(!('token' in u), `用户 ${u.id} 的 token 不应出现在列表里`);
  }
});

test('loadUsers：用户表损坏时抛错且绝不覆盖（防止种子 token 顶替全员凭证）', () => {
  fs.writeFileSync(PATHS.users, '{corrupt');
  assert.throws(() => auth.loadUsers(), /用户表不可用/);
  const raw = fs.readFileSync(PATHS.users, 'utf8');
  assert.equal(raw, '{corrupt', '原文件必须原样保留');
});
