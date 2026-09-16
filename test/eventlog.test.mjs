/**
 * eventlog.js 偏移索引单元测试（node:test，零依赖）。
 * 覆盖：大数据量下 since 与全量读一致、跨 stride 边界、重启复用索引、
 * 索引增量维护、半行截断修复后索引重建。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent-events-'));
process.env.COAGENT_DATA = dir;
const { createEventLog } = await import('../src/eventlog.js');
const EVENTS_FILE = path.join(dir, 'events.jsonl');
const INDEX_FILE = path.join(dir, 'events.idx.jsonl');

const readIndex = () =>
  fs.readFileSync(INDEX_FILE, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);

test('偏移索引：2100 条事件下 since 与全量读完全一致（跨 stride 边界）', () => {
  const log = createEventLog();
  for (let i = 1; i <= 2100; i++) log.append({ type: 'message.posted', authorId: 'a', payload: { i } });
  assert.equal(log.lastSeq, 2100);
  // 覆盖 stride 边界 500/1000/1500/2000 两侧 + 首尾
  for (const after of [0, 1, 499, 500, 501, 999, 1000, 1500, 1999, 2000, 2099, 2100]) {
    const got = log.since(after, 50);
    const expect = [];
    for (let i = after + 1; i <= 2100 && expect.length < 50; i++) expect.push(i);
    assert.deepEqual(got.map((e) => e.payload.i), expect, `after=${after} 结果不一致`);
  }
  // 索引文件：2100 条 → stride 500 → 恰好 4 条
  const idx = readIndex();
  assert.equal(idx.length, 4, '索引条目数 = floor(2100/500) = 4');
  assert.deepEqual(idx.map((x) => x.seq), [500, 1000, 1500, 2000]);
  assert.ok(idx.every((x, i) => i === 0 || x.offset > idx[i - 1].offset), '索引偏移单调递增');
});

test('重启复用索引：seq 恢复 + since 正确 + 索引增量维护', () => {
  const log = createEventLog(); // 重新实例化 = 模拟进程重启
  assert.equal(log.lastSeq, 2100, '重启后 seq 恢复');
  const got = log.since(1000, 10);
  assert.deepEqual(got.map((e) => e.payload.i), [1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010], '重启后 since 走索引路径结果正确');
  // 继续追加到跨 stride：2101 → 2500（再 400 条，2500 % 500 === 0 触发第 5 条索引）
  for (let i = 0; i < 400; i++) log.append({ type: 'task.created', authorId: 'b', payload: {} });
  assert.equal(log.lastSeq, 2500);
  const idx = readIndex();
  assert.equal(idx.length, 5, '索引随 append 增量追加到 5 条');
  assert.equal(idx[idx.length - 1].seq, 2500, '最后一条索引指向 2500');
  assert.ok(idx[idx.length - 1].offset < fs.statSync(EVENTS_FILE).size, '索引偏移在文件大小范围内');
});

test('半行截断修复：索引删除重建，数据不丢', () => {
  // 人为写坏尾部（进程被杀场景）：最后一行是不完整 JSON
  fs.appendFileSync(EVENTS_FILE, '{"seq": 2501, "partial":');
  const log = createEventLog();
  assert.equal(log.lastSeq, 2500, '半行被截断，seq 回到 2500');
  const idx = readIndex();
  assert.equal(idx.length, 5, '索引重建为 5 条（含 2500）');
  const tail = log.since(2495, 10);
  assert.equal(tail.length, 5, '修复后最后 5 条事件完整可取');
});
