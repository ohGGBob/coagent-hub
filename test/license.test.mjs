/**
 * license.js 授权系统单元测试（node:test，零依赖）。
 * 重点：签名校验 fail-closed、试用期逻辑、激活/移除、功能门控。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPrivateKey, sign } from 'node:crypto';

process.env.COAGENT_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent-license-'));
const license = await import('../src/license.js');

/** 用维护者私钥签发一个授权（测试用；私钥不入库） */
function issueLicense({ org = '测试组织', edition = 'pro', seats = 5, days = 365 } = {}) {
  const privPath = path.join(process.cwd(), 'scripts', 'dev-keys', 'ed25519-private.pem');
  if (!fs.existsSync(privPath)) return null;
  const privateKey = createPrivateKey(fs.readFileSync(privPath));
  const payload = {
    org,
    edition,
    seats,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(),
  };
  const data = JSON.stringify(payload);
  const signature = sign(null, Buffer.from(data, 'utf8'), privateKey).toString('base64');
  return Buffer.from(JSON.stringify({ data, signature }), 'utf8').toString('base64');
}

test('无授权时进入 30 天 Pro 试用（全功能可用）', () => {
  const s = license.current();
  assert.equal(s.source, 'trial');
  assert.equal(s.edition, 'pro');
  assert.ok(s.features.includes('webhooks'));
  assert.ok(s.trial.active);
  assert.ok(s.trial.daysLeft > 0 && s.trial.daysLeft <= 30);
  assert.equal(license.can('export'), true);
  assert.equal(license.can('audit'), true);
});

test('试用期基准文件已写入 data/first-run.json', () => {
  const j = JSON.parse(fs.readFileSync(path.join(process.env.COAGENT_DATA, 'first-run.json'), 'utf8'));
  assert.ok(j.installedAt);
});

test('can() 对未知功能返回 false（fail-closed）', () => {
  assert.equal(license.can('not-a-feature'), false);
});

test('无效授权 key 一律拒绝并降级社区版', () => {
  assert.throws(() => license.parseAndVerify('not-base64!'), /格式无效|缺少|校验失败/);
  assert.throws(() => license.parseAndVerify(Buffer.from('{"data":"x"}').toString('base64')), /签名校验失败|缺少/);
  const bad = Buffer.from(JSON.stringify({ data: 'hello', signature: 'AAAA' })).toString('base64');
  assert.throws(() => license.parseAndVerify(bad), /签名校验失败/);
  // 激活失败不会写授权文件
  assert.throws(() => license.activate('bad-key'), /格式无效|缺少|校验失败/);
  assert.equal(fs.existsSync(path.join(process.env.COAGENT_DATA, 'license.json')), false);
});

test('合法授权激活成功，字段完整，来源为 file', { skip: !fs.existsSync(path.join(process.cwd(), 'scripts', 'dev-keys', 'ed25519-private.pem')) }, () => {
  const key = issueLicense({ org: 'ACME 公司', edition: 'enterprise', seats: 10, days: 90 });
  const payload = license.activate(key);
  assert.equal(payload.org, 'ACME 公司');
  assert.equal(payload.seats, 10);
  assert.equal(payload.edition, 'pro');
  assert.ok(payload.expiresAt);
  const s = license.current();
  assert.equal(s.source, 'file');
  assert.equal(s.edition, 'pro');
  assert.equal(s.label, '企业版');
  assert.equal(s.org, 'ACME 公司');
  assert.equal(s.seats, 10);
  assert.equal(s.trial, null);
  assert.ok(fs.existsSync(path.join(process.env.COAGENT_DATA, 'license.json')));
});

test('篡改授权数据后签名校验失败', { skip: !fs.existsSync(path.join(process.cwd(), 'scripts', 'dev-keys', 'ed25519-private.pem')) }, () => {
  const key = issueLicense({ org: '原组织' });
  const env = JSON.parse(Buffer.from(key, 'base64').toString('utf8'));
  const tamperedData = env.data.replace('原组织', '伪造组织');
  const forged = Buffer.from(JSON.stringify({ data: tamperedData, signature: env.signature })).toString('base64');
  assert.throws(() => license.parseAndVerify(forged), /签名校验失败/);
});

test('过期授权拒绝激活', { skip: !fs.existsSync(path.join(process.cwd(), 'scripts', 'dev-keys', 'ed25519-private.pem')) }, () => {
  const key = issueLicense({ days: -1 });
  assert.throws(() => license.parseAndVerify(key), /过期/);
});

test('deactivate 移除授权回到试用', () => {
  license.deactivate();
  assert.equal(fs.existsSync(path.join(process.env.COAGENT_DATA, 'license.json')), false);
  const s = license.current();
  assert.equal(s.source, 'trial');
});
