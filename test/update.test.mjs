/**
 * update.js 自更新安全边界单元测试（node:test，零依赖）。
 * 覆盖：版本比较、校验和清单解析、SHA-256 校验（fail-closed）、源码模式拒绝。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

process.env.COAGENT_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent-update-'));

const { compareVersions, parseChecksumsManifest, verifyChecksum, sha256File, applyUpdate } = await import('../src/update.js');

test('compareVersions：语义化版本比较（含 v 前缀与缺段）', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('0.12.1', '0.12.0'), 1);
  assert.equal(compareVersions('0.9.9', '1.0.0'), -1);
  assert.equal(compareVersions('v1.0.0', '0.9.9'), 1, 'v 前缀应剥掉');
  assert.equal(compareVersions('1.0', '1.0.1'), -1, '缺段按 0 处理');
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
});

test('parseChecksumsManifest：sha256sum 兼容格式解析', () => {
  const A = 'a'.repeat(64);
  const B = 'B'.repeat(64); // 大写应归一化为小写
  const text = [
    `${A}  coagent-win-x64.exe`,        // 标准双空格
    `${B} *coagent-macos-arm64.zip`,    // 二进制标记
    `${'c'.repeat(64)} coagent-macos-x64.zip`,   // 单空格
    'not a checksum line',              // 非法行静默跳过
    `short coagent.exe`,                // 哈希长度不足，跳过
    '',
  ].join('\r\n');                        // CRLF 行尾
  const m = parseChecksumsManifest(text);
  assert.equal(m.size, 3);
  assert.equal(m.get('coagent-win-x64.exe'), A);
  assert.equal(m.get('coagent-macos-arm64.zip'), B.toLowerCase());
  assert.equal(m.get('coagent-macos-x64.zip'), 'c'.repeat(64));
  assert.equal(parseChecksumsManifest('').size, 0);
  assert.equal(parseChecksumsManifest(null).size, 0);
});

test('verifyChecksum：哈希一致放行', () => {
  const file = path.join(os.tmpdir(), `coagent-vc-ok-${process.pid}`);
  fs.writeFileSync(file, 'hello update payload');
  const hex = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.doesNotThrow(() => verifyChecksum(file, `${hex}  coagent-win-x64.exe`, 'coagent-win-x64.exe'));
  fs.rmSync(file, { force: true });
});

test('verifyChecksum：哈希不匹配 → 抛错且删除下载文件（fail-closed）', () => {
  const file = path.join(os.tmpdir(), `coagent-vc-bad-${process.pid}`);
  fs.writeFileSync(file, 'tampered content');
  const manifest = `${'0'.repeat(64)}  coagent-win-x64.exe`;
  assert.throws(() => verifyChecksum(file, manifest, 'coagent-win-x64.exe'), /SHA-256 校验失败/);
  assert.equal(fs.existsSync(file), false, '被篡改的更新包必须已删除');
});

test('verifyChecksum：清单缺条目 → 拒绝更新', () => {
  const file = path.join(os.tmpdir(), `coagent-vc-miss-${process.pid}`);
  fs.writeFileSync(file, 'x');
  assert.throws(() => verifyChecksum(file, `${'0'.repeat(64)}  other-file.exe`, 'coagent-win-x64.exe'), /没有 coagent-win-x64\.exe 的条目/);
  fs.rmSync(file, { force: true });
});

test('sha256File：与 node:crypto 直接计算一致', () => {
  const file = path.join(os.tmpdir(), `coagent-sha-${process.pid}`);
  const payload = Buffer.from([1, 2, 3, 255, 0, 128]);
  fs.writeFileSync(file, payload);
  assert.equal(sha256File(file), createHash('sha256').update(payload).digest('hex'));
  fs.rmSync(file, { force: true });
});

test('applyUpdate：源码模式直接拒绝（不支持自更新）', async () => {
  await assert.rejects(() => applyUpdate('0.0.1'), /源码模式不支持自更新/);
});
