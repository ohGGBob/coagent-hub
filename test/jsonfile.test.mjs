/**
 * jsonfile.js 原子持久化单元测试（node:test，零依赖）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent-json-'));
const { readJson, writeJson } = await import('../src/jsonfile.js');

test('writeJson → readJson：往返一致', () => {
  const file = path.join(dir, 'a.json');
  const data = { n: 1, list: ['x', 'y'], nested: { ok: true } };
  writeJson(file, data);
  assert.deepEqual(readJson(file, null), data);
});

test('writeJson：原子写不留临时文件，自动建目录', () => {
  const file = path.join(dir, 'sub', 'b.json');
  writeJson(file, { v: 1 });
  const leftovers = fs.readdirSync(path.join(dir, 'sub')).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'rename 后不应残留 .tmp');
});

test('readJson：文件不存在返回 fallback 的深拷贝', () => {
  const fallback = { list: [1] };
  const got = readJson(path.join(dir, 'missing.json'), fallback);
  assert.deepEqual(got, fallback);
  got.list.push(2);
  assert.deepEqual(fallback.list, [1], 'fallback 不能被返回值污染');
});

test('readJson：空文件返回 fallback（半行/截断兜底）', () => {
  const file = path.join(dir, 'empty.json');
  fs.writeFileSync(file, '   \n');
  assert.deepEqual(readJson(file, { d: true }), { d: true });
});

test('readJson：损坏 JSON 抛错（绝不静默吞掉状态文件）', () => {
  const file = path.join(dir, 'bad.json');
  fs.writeFileSync(file, '{"n": 1,');
  assert.throws(() => readJson(file, {}), /状态文件损坏/);
});

test('writeJson：覆盖旧值', () => {
  const file = path.join(dir, 'c.json');
  writeJson(file, { v: 1 });
  writeJson(file, { v: 2 });
  assert.deepEqual(readJson(file, null), { v: 2 });
});
