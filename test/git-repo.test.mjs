/**
 * git-repo.js 名字校验与推送权限单元测试（node:test，零依赖）。
 * validateBranchName 是「名字来自 HTTP 请求 → git 子进程」的唯一闸门，
 * 重点覆盖 git option 注入（- 开头）与 ref 越权（..）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.COAGENT_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent-git-'));

const { validateBranchName, canPush, ensureRepo, listBranches } = await import('../src/git-repo.js');
const { privateBranch } = await import('../src/config.js');

test('validateBranchName：常规名字放行', () => {
  for (const ok of ['dev/alice', 'main', 'feature-x', 'a1', 'dev/user_01', 'dev/a.b.c', 'fix/push-channel']) {
    assert.equal(validateBranchName(ok), ok, `${ok} 应放行`);
  }
});

test('validateBranchName：git option 注入 / ref 越权 / 非法字符拒绝', () => {
  for (const bad of [
    '--upload-pack=evil',      // 选项注入
    '-o', '-b',                // 短选项
    'dev/../main',             // ref 越权
    '../etc/passwd',
    'a..b',
    'a//b', 'dev/',            // 空路径段
    'has space', '中文', 'a b',
    '', '.hidden',             // 首字符必须是字母数字
  ]) {
    assert.throws(() => validateBranchName(bad), undefined, `应拒绝：${JSON.stringify(bad)}`);
  }
});

test('canPush：main 受保护，私有分支仅本人可推（精确匹配）', () => {
  assert.equal(canPush('alice', 'main'), false, '受保护分支任何人都不能直接 push');
  assert.equal(canPush('alice', 'dev/alice'), true);
  assert.equal(canPush('bob', 'dev/alice'), false);
  assert.equal(canPush('alice', 'dev/alice-x'), false, '前缀相同也必须精确匹配');
  assert.equal(canPush('alice', 'dev/alice/nested'), false, '嵌套段不属于私有分支');
  assert.equal(privateBranch('alice'), 'dev/alice');
});

test('ensureRepo：初始化裸仓并保证 main 可派生', () => {
  const { repo, branches } = ensureRepo();
  assert.ok(fs.existsSync(path.join(repo, 'HEAD')));
  assert.ok(fs.existsSync(path.join(repo, 'objects')));
  assert.ok(branches.includes('main'));
  assert.deepEqual(listBranches(), ['main'], '空仓应只有一个 main 根提交');
  // 幂等：再跑一次不重建、不报错
  ensureRepo();
  assert.deepEqual(listBranches(), ['main']);
});
