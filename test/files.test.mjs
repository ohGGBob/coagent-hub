/**
 * files.js 文件附件存储单元测试（node:test，零依赖）。
 * 重点：MIME 白名单收敛（防存储型 XSS）、路径安全、大小上限、权限。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.COAGENT_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent-files-'));
process.env.COAGENT_MAX_FILE_MB = '1'; // 上限在模块加载时读取，调小便于测试

const { createFileStore } = await import('../src/files.js');
const { HubError } = await import('../src/errors.js');

const store = createFileStore();

test('store → get → read：往返一致，元数据完整', () => {
  const buf = Buffer.from('file body');
  const meta = store.store({ buffer: buf, filename: 'a.txt', mimeType: 'text/plain', uploadedBy: 'alice' });
  assert.ok(meta.id.length === 36, '存储 id 应为 UUID');
  assert.equal(meta.filename, 'a.txt');
  assert.equal(meta.mimeType, 'text/plain');
  assert.equal(meta.size, buf.length);
  assert.equal(meta.uploadedBy, 'alice');
  assert.equal(store.get(meta.id).id, meta.id);
  const { data } = store.read(meta.id);
  assert.deepEqual(data, buf);
});

test('MIME 白名单：text/html 收敛为 octet-stream（封死存储型 XSS），白名单类型保留', () => {
  const evil = store.store({ buffer: Buffer.from('<script>x</script>'), filename: 'x.html', mimeType: 'text/html; charset=utf-8', uploadedBy: 'alice' });
  assert.equal(evil.mimeType, 'application/octet-stream');
  const png = store.store({ buffer: Buffer.from([0x89, 0x50]), filename: 'p.png', mimeType: 'image/png', uploadedBy: 'alice' });
  assert.equal(png.mimeType, 'image/png');
});

test('路径安全：穿越文件名不影响落盘位置（UUID + 白名单扩展名）', () => {
  const meta = store.store({ buffer: Buffer.from('x'), filename: '../../evil.exe', uploadedBy: 'alice' });
  assert.match(meta.storedName, /^[0-9a-f-]{36}\.exe$/, '存储名只能是 UUID+扩展名');
  assert.ok(!meta.storedName.includes('/'), '存储名不含路径分隔符');
});

test('扩展名提取：畸形扩展名一律清空，超长扩展名截断', () => {
  for (const [filename, expectExt] of [
    ['noext', ''], ['a.b c', ''], ['.hidden', ''], ['UPPER.TXT', '.txt'],
    ['x.' + 'a'.repeat(20), '.' + 'a'.repeat(15)], // 截断到 16 字符后仍合法则保留
  ]) {
    const meta = store.store({ buffer: Buffer.from('z'), filename, uploadedBy: 'alice' });
    if (expectExt) {
      assert.ok(meta.storedName.endsWith(expectExt), `${filename} 应保留扩展名 ${expectExt}`);
    } else {
      assert.match(meta.storedName, /^[0-9a-f-]{36}$/, `${filename} 不应有扩展名`);
    }
  }
});

test('大小与空内容：空文件 400，超过上限 400', () => {
  assert.throws(() => store.store({ buffer: Buffer.alloc(0), filename: 'e.txt', uploadedBy: 'alice' }), (e) => e instanceof HubError && e.status === 400);
  assert.throws(() => store.store({ buffer: Buffer.alloc(1024 * 1024 + 1), filename: 'big.bin', uploadedBy: 'alice' }), /超过上限/);
});

test('get：畸形 id（非 UUID）直接 404，不进入路径运算', () => {
  assert.throws(() => store.get('../../etc/passwd'), (e) => e.status === 404);
  assert.throws(() => store.get('not-a-uuid'), (e) => e.status === 404);
});

test('remove：仅上传者可删（管理员判断由路由层做）', () => {
  const meta = store.store({ buffer: Buffer.from('own'), filename: 'o.txt', uploadedBy: 'alice' });
  assert.throws(() => store.remove(meta.id, 'bob'), (e) => e.status === 403);
  assert.deepEqual(store.remove(meta.id, 'alice'), { id: meta.id, removed: true });
  assert.throws(() => store.get(meta.id), (e) => e.status === 404);
});

test('list：按创建时间倒序', () => {
  const a = store.store({ buffer: Buffer.from('1'), filename: '1.txt', uploadedBy: 'alice' });
  const b = store.store({ buffer: Buffer.from('2'), filename: '2.txt', uploadedBy: 'alice' });
  const ids = store.list().map((m) => m.id);
  assert.ok(ids.indexOf(b.id) < ids.indexOf(a.id), '新文件应排前面');
});
