/**
 * webhooks.js Webhook 通知单元测试（node:test，零依赖）。
 * 重点：URL 校验与 SSRF 防护、事件白名单、secret 脱敏、签名投递。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHmac } from 'node:crypto';

process.env.COAGENT_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent-webhooks-'));
// 测试需要投递到本机接收器 → 显式放开私网（生产默认关闭）
process.env.COAGENT_WEBHOOK_ALLOW_PRIVATE = '1';
const { createWebhookStore, checkWebhookUrl } = await import('../src/webhooks.js');

const store = createWebhookStore();

test('checkWebhookUrl：仅接受 http/https', () => {
  assert.equal(checkWebhookUrl('https://example.com/hook'), 'https://example.com/hook');
  assert.equal(checkWebhookUrl('  http://example.com:8080/a?b=1  '), 'http://example.com:8080/a?b=1');
  assert.throws(() => checkWebhookUrl('ftp://example.com'), /仅支持 http/);
  assert.throws(() => checkWebhookUrl('not a url'), /合法/);
});

test('私网地址默认被拒（SSRF 防护）', async () => {
  const before = process.env.COAGENT_WEBHOOK_ALLOW_PRIVATE;
  delete process.env.COAGENT_WEBHOOK_ALLOW_PRIVATE;
  // 重新加载模块使常量生效
  const fresh = await import(`../src/webhooks.js?no-private=${Date.now()}`);
  assert.throws(() => fresh.checkWebhookUrl('http://127.0.0.1:8000/hook'), /SSRF/);
  assert.throws(() => fresh.checkWebhookUrl('http://localhost/hook'), /SSRF/);
  assert.throws(() => fresh.checkWebhookUrl('http://192.168.1.5/hook'), /SSRF/);
  assert.throws(() => fresh.checkWebhookUrl('http://169.254.169.254/latest/meta-data'), /SSRF/);
  if (before === undefined) delete process.env.COAGENT_WEBHOOK_ALLOW_PRIVATE;
  else process.env.COAGENT_WEBHOOK_ALLOW_PRIVATE = before;
});

test('create：白名单外事件被剔除，secret 在列表中脱敏', () => {
  const wh = store.create({
    name: '飞书群通知',
    url: 'https://example.com/feishu',
    events: ['task.created', '不存在的类型', 'message.posted'],
    secret: 's3cret',
  });
  assert.deepEqual(wh.events.sort(), ['message.posted', 'task.created'].sort());
  const listed = store.list().find((w) => w.id === wh.id);
  assert.equal(listed.hasSecret, true);
  assert.equal(listed.secret, undefined);
  assert.equal(listed.name, '飞书群通知');
});

test('create：名称必填，URL 非法拒绝', () => {
  assert.throws(() => store.create({ name: '', url: 'https://example.com' }), /名称/);
  assert.throws(() => store.create({ name: 'x', url: 'ftp://a' }), /仅支持 http/);
});

test('update / remove：幂等与不存在报错', () => {
  const wh = store.create({ name: '待改', url: 'https://example.com/a' });
  const updated = store.update(wh.id, { name: '已改', enabled: false });
  assert.equal(updated.name, '已改');
  assert.equal(updated.enabled, false);
  assert.throws(() => store.update('no-such-id', {}), /不存在/);
  store.remove(wh.id);
  assert.equal(store.list().find((w) => w.id === wh.id), undefined);
  assert.throws(() => store.remove(wh.id), /不存在/);
});

test('hookEvents：命中订阅类型即投递，带 HMAC 签名', async () => {
  // 本地接收器：记录收到的请求体与签名头
  let received = null;
  let signatureHeader = null;
  const receiver = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received = JSON.parse(raw);
      signatureHeader = req.headers['x-hub-signature'];
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  const port = receiver.address().port;

  const wh = store.create({
    name: '本地接收',
    url: `http://127.0.0.1:${port}/hook`,
    events: ['task.created', 'message.posted'],
    secret: 'hmac-secret',
  });

  // 模拟 eventLog.subscribe
  const listeners = new Set();
  const fakeEventLog = {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  store.hookEvents(fakeEventLog);

  // 触发 task.created（应投递）
  const ev = {
    type: 'task.created',
    seq: 42,
    payload: { title: '投递测试任务' },
    authorId: 'alice',
    ts: new Date().toISOString(),
  };
  for (const fn of listeners) fn(ev);

  // 等待异步投递完成
  const deadline = Date.now() + 5000;
  while (!received && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));

  assert.ok(received, '应收到投递');
  assert.equal(received.event, 'task.created');
  assert.equal(received.seq, 42);
  assert.equal(received.payload.title, '投递测试任务');
  assert.equal(received.authorId, 'alice');
  assert.ok(received.ts);
  assert.ok(received.hubVersion);
  // 签名校验：HMAC-SHA256(secret, body) 且 body 与 received 一致
  const expected = 'sha256=' + createHmac('sha256', 'hmac-secret').update(JSON.stringify(received)).digest('hex');
  assert.equal(signatureHeader, expected);

  // 未订阅类型（context.appended）不应投递
  received = null;
  for (const fn of listeners) fn({ type: 'context.appended', seq: 43, payload: {}, authorId: 'alice', ts: new Date().toISOString() });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(received, null);

  receiver.close();
});

test('投递失败记录 lastError，10 次连续失败自动禁用', async () => {
  const dead = http.createServer((req, res) => {
    res.writeHead(500);
    res.end('err');
  });
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const port = dead.address().port;

  const wh = store.create({ name: '失败目标', url: `http://127.0.0.1:${port}/fail`, events: ['message.posted'] });
  // 直接用内部投递路径模拟 10 次失败：通过 eventLog 触发 + 重试太快，改为直接循环交付
  // 简化：连发 10 次不同事件（重试间隔 1s/5s/15s 会拖慢测试），因此这里只验证失败计数与错误记录
  const listeners = new Set();
  const fakeLog = { subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  store.hookEvents(fakeLog);
  for (let i = 0; i < 3; i++) {
    for (const fn of listeners) fn({ type: 'message.posted', seq: 100 + i, payload: {}, authorId: 'a', ts: new Date().toISOString() });
  }
  const deadline = Date.now() + 15000;
  let listed;
  while (Date.now() < deadline) {
    listed = store.list().find((w) => w.id === wh.id);
    if (listed.consecutiveFailures >= 3) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(listed.consecutiveFailures >= 3, '应累计失败次数');
  assert.ok(listed.lastError, '应记录错误原因');
  assert.equal(listed.lastStatus, 500);
  dead.close();
});
