/**
 * Hub 托管裸仓（已确认方案：裸仓 + git 子进程，零第三方依赖）。
 *
 * 读写分离的权限落地方式（关键）：
 *   - **读**：agent 直接用 git 访问 `data/repo.git`（clone / fetch），共享上下文人人可读。
 *   - **写**：必须走 Hub 的 `POST /branches/:name/push`，客户端用 `git bundle` 打包上传，
 *           Hub 校验 ref 归属后才 unbundle。
 *   若允许 agent 直接 git push 到裸仓路径，分支权限就是一纸空文。
 *
 * @module git-repo
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PATHS, PROTECTED_BRANCHES, privateBranch } from './config.js';
import { conflict, badRequest, notFound, forbidden } from './errors.js';

/** 固定提交者身份，避免受本机 gitconfig 影响 */
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'CoAgent Hub',
  GIT_AUTHOR_EMAIL: 'hub@coagent.local',
  GIT_COMMITTER_NAME: 'CoAgent Hub',
  GIT_COMMITTER_EMAIL: 'hub@coagent.local',
};

/**
 * 执行 git 命令。
 * @param {string[]} args
 * @param {{cwd?: string, input?: string, check?: boolean}} [opts]
 */
function git(args, opts = {}) {
  const r = spawnSync('git', args, {
    cwd: opts.cwd ?? PATHS.data,
    input: opts.input,
    encoding: 'utf8',
    env: GIT_ENV,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (opts.check !== false && r.status !== 0) {
    const detail = (r.stderr || '').trim() || (r.stdout || '').trim();
    const err = new Error(`git ${args.join(' ')} 失败：${detail}`);
    err.code = 'GIT_ERROR';
    err.detail = detail;
    throw err;
  }
  return { stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim(), status: r.status };
}

/**
 * 在裸仓内执行 git。最后一个参数若是普通对象则视为 opts。
 * @param {...(string | {cwd?: string, input?: string, check?: boolean})} args
 */
function R(...args) {
  const last = args[args.length - 1];
  const hasOpts = typeof last === 'object' && last !== null && !Array.isArray(last);
  const opts = hasOpts ? args.pop() : {};
  return git(['-C', PATHS.repo, ...args], opts);
}

/** 是否已是裸仓 */
function isBareRepo() {
  return fs.existsSync(path.join(PATHS.repo, 'HEAD')) && fs.existsSync(path.join(PATHS.repo, 'objects'));
}

/** 空树对象的 SHA（git 的常量，直接用，避免依赖 /dev/null） */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** 初始化裸仓；若无提交则造一个根提交，保证分支可从 main 派生。 */
export function ensureRepo() {
  fs.mkdirSync(PATHS.data, { recursive: true });
  if (!isBareRepo()) {
    git(['init', '--bare', '--initial-branch=main', PATHS.repo], { cwd: PATHS.data });
  }
  R('symbolic-ref', 'HEAD', 'refs/heads/main');

  const branches = listBranches();
  if (!branches.includes('main')) {
    const sha = R('commit-tree', EMPTY_TREE, '-m', 'chore: hub init').stdout;
    R('update-ref', 'refs/heads/main', sha);
  }
  return { repo: PATHS.repo, branches: listBranches() };
}

/**
 * @returns {string[]}
 */
export function listBranches() {
  return R('for-each-ref', '--format=%(refname:short)', 'refs/heads')
    .stdout.split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {string} name
 * @returns {boolean}
 */
export function branchExists(name) {
  return R('show-ref', '--verify', '--quiet', `refs/heads/${name}`, { check: false }).status === 0;
}

/**
 * 分支名格式校验：只允许字母数字 / . _ -，且不允许以 '-' 开头（防被当成 git 选项）。
 * 所有「名字来自 HTTP 请求」的分支读写都应先过这道闸。
 * @param {string} name
 */
export function validateBranchName(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name.includes('..')) {
    throw badRequest('分支名含非法字符', { branch: name });
  }
  return name;
}

/**
 * 断言分支存在（含名字格式校验）。
 * @param {string} name
 */
export function requireBranch(name) {
  validateBranchName(name);
  if (!branchExists(name)) throw notFound(`分支不存在：${name}`, { branches: listBranches() });
  return name;
}

/**
 * 写入权限判定：某人能否 push 到某分支。
 * @param {string} userId
 * @param {string} branch
 * @returns {boolean}
 */
export function canPush(userId, branch) {
  if (PROTECTED_BRANCHES.includes(branch)) return false;
  return branch === privateBranch(userId);
}

/**
 * 从 main 派生私有分支。
 * @param {string} name
 * @param {string} [start]
 * @returns {{branch: string, sha: string}}
 */
export function createBranch(name, start = 'main') {
  validateBranchName(name);
  if (branchExists(name)) throw conflict(`分支已存在：${name}`);
  requireBranch(start);
  R('branch', name, start);
  return { branch: name, sha: R('rev-parse', name).stdout };
}

/**
 * 读取 bundle 中包含的 ref 列表。
 * @param {string} file
 * @returns {Array<{sha: string, ref: string}>}
 */
export function bundleRefs(file) {
  const out = R('bundle', 'list-heads', file, { check: false });
  if (out.status !== 0) throw badRequest('无法解析 bundle，可能不是有效的 git bundle', { detail: out.stderr });
  return out.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [sha, ref] = l.split(/\s+/);
      return { sha, ref };
    });
}

/**
 * 接收客户端上传的 bundle 并合入裸仓。
 *
 * @param {Buffer} buffer     打包内容
 * @param {string} allowedRef 允许写入的完整 ref，如 refs/heads/dev/alice
 * @returns {{branch: string, sha: string, refs: Array<{sha:string,ref:string}>}}
 */
export function receiveBundle(buffer, allowedRef) {
  fs.mkdirSync(PATHS.tmp, { recursive: true });
  const file = path.join(PATHS.tmp, `${randomUUID()}.bundle`);
  fs.writeFileSync(file, buffer);
  try {
    const refs = bundleRefs(file);
    if (refs.length === 0) throw badRequest('bundle 不含任何 ref');
    const illegal = refs.filter((r) => r.ref !== allowedRef);
    if (illegal.length) {
      throw forbidden('bundle 含越权 ref', { allowed: allowedRef, found: illegal.map((r) => r.ref) });
    }

    // 自包含性检查：若 git 提示 "requires"，说明缺前置对象，客户端需基于最新分支重建
    const verify = R('bundle', 'verify', file, { check: false });
    const verifyText = `${verify.stdout}\n${verify.stderr}`;
    if (verify.status !== 0 || /requires these [1-9]/.test(verifyText)) {
      throw conflict('bundle 不自包含：请先 fetch 最新分支并重建 bundle', { detail: verifyText.trim() });
    }

    const before = branchExists(allowedRef.replace('refs/heads/', ''))
      ? R('rev-parse', allowedRef).stdout
      : null;

    // 用 fetch 取代 unbundle：`bundle unbundle` 只导入对象、不更新 ref，
    // 导致推送后分支 sha 原地不动；`fetch <bundle> <ref>:<ref>` 会真正推进
    // 目标 ref，且默认拒绝非快进更新（无 `+` 前缀），与权限/冲突语义一致。
    const fetchR = R('fetch', '--quiet', '--no-write-fetch-head', file, `${allowedRef}:${allowedRef}`, { check: false });
    if (fetchR.status !== 0) {
      const detail = `${fetchR.stdout}\n${fetchR.stderr}`.trim();
      if (/non-fast-forward|would clobber|rejected/i.test(detail)) {
        throw conflict('非快进推送被拒绝：请 fetch 最新分支后 rebase，再重新推送', { detail });
      }
      throw badRequest('bundle 合入失败', { detail });
    }

    const branch = allowedRef.replace('refs/heads/', '');
    const after = R('rev-parse', allowedRef).stdout;
    return { branch, sha: after, before, refs };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/**
 * 列出分支及其 sha（远端 agent 判断是否需要更新用）。
 * @returns {Array<{name: string, sha: string}>}
 */
export function listRefs() {
  return R('for-each-ref', '--format=%(refname:short)%09%(objectname)', 'refs/heads')
    .stdout.split('\n')
    .filter(Boolean)
    .map((l) => {
      const [name, sha] = l.split('\t');
      return { name, sha };
    });
}

/**
 * 解析 ref 对应的 sha。
 * @param {string} ref
 * @returns {string}
 */
export function revParse(ref) {
  return R('rev-parse', ref).stdout;
}

/**
 * 导出**整个仓库**为 bundle，供远端 agent 首次 clone / 后续 fetch。
 * 跨机场景下 agent 无法直连本机路径，这是代码读通道的唯一入口。
 * @returns {{file: string}}
 */
export function exportRepoBundle() {
  fs.mkdirSync(PATHS.tmp, { recursive: true });
  const file = path.join(PATHS.tmp, `repo-${randomUUID()}.bundle`);
  R('bundle', 'create', file, '--all');
  return { file };
}

/**
 * 导出分支为 bundle，供 agent 首次 clone 使用。
 * @param {string} branch
 * @returns {{file: string}}
 */
export function exportBundle(branch) {
  requireBranch(branch);
  fs.mkdirSync(PATHS.tmp, { recursive: true });
  const file = path.join(PATHS.tmp, `export-${branch.replace(/\//g, '_')}-${randomUUID()}.bundle`);
  R('bundle', 'create', file, branch);
  return { file };
}

/**
 * 分支差异（相对 base 的三点差异）。
 * @param {string} branch
 * @param {string} [base]
 */
export function diff(branch, base = 'main') {
  requireBranch(branch);
  requireBranch(base);
  const patch = R('diff', `${base}...${branch}`).stdout;
  const stat = R('diff', '--stat', `${base}...${branch}`).stdout;
  const commits = R('log', '--format=%H%x1f%s', `${base}..${branch}`)
    .stdout.split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, subject] = l.split('\x1f');
      return { sha, subject };
    });
  return {
    branch,
    base,
    ahead: Number(R('rev-list', '--count', `${base}..${branch}`).stdout),
    behind: Number(R('rev-list', '--count', `${branch}..${base}`).stdout),
    commits,
    stat,
    patch,
  };
}

/**
 * 快进合并：base 是 branch 的祖先时才允许。
 * @param {string} branch
 * @param {string} [base]
 * @returns {{fastForward: boolean, from?: string, to?: string, upToDate?: boolean, ahead?: string[], behind?: string[]}}
 */
export function mergeFF(branch, base = 'main') {
  requireBranch(branch);
  requireBranch(base);
  const to = R('rev-parse', branch).stdout;
  const from = R('rev-parse', base).stdout;

  if (to === from) return { fastForward: true, from, to, upToDate: true };

  const anc = R('merge-base', '--is-ancestor', base, branch, { check: false });
  if (anc.status !== 0) {
    return {
      fastForward: false,
      from,
      to,
      ahead: R('log', '--format=%h %s', `${base}..${branch}`).stdout.split('\n').filter(Boolean),
      behind: R('log', '--format=%h %s', `${branch}..${base}`).stdout.split('\n').filter(Boolean),
    };
  }
  R('update-ref', `refs/heads/${base}`, to);
  return { fastForward: true, from, to, upToDate: false };
}
