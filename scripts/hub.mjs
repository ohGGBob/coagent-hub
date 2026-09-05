#!/usr/bin/env node
/**
 * CoAgent agent 命令行工具。
 *
 * 跨机场景下 agent 拿不到主机的文件路径，所有代码流转都走这个 CLI：
 *   init   从 Hub 拉下整个项目（首次开工）
 *   pull   拉取所有人最新进度（到 hub/* 远端引用）
 *   push   把自己的改动打包推送到自己的私有分支
 *   status 看任务板 + 最近动态 + 自己与 main 的差距
 *   sync   pull + status（每天开工前跑这条）
 *   whoami 当前身份
 *
 * 命令行：
 *   node scripts/hub.mjs init ./my-work --hub http://100.x.x.x:8787 --token tok_xxx
 *   node scripts/hub.mjs sync --dir ./my-work
 *
 * 也可作为模块内嵌调用（测试/其他工具集成）：
 *   import { run } from './scripts/hub.mjs';
 *   await run(['init', './work', '--hub', url, '--token', token]);
 *
 * @module hub-cli
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { HubClient } from '../src/sdk/client.js';

const CONFIG_NAME = '.coagent.json';

export class CliError extends Error {}

const die = (msg) => {
  throw new CliError(msg);
};

/**
 * @param {string[]} args
 * @param {string} [cwd]
 */
function g(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) die(`git ${args.join(' ')} 失败：${(r.stderr || '').trim()}`);
  return (r.stdout || '').trim();
}

/**
 * @param {string[]} argv 不含 node 与脚本路径
 */
function parseArgs(argv) {
  const command = argv[0];
  /** @type {Map<string, string>} */
  const flags = new Map();
  const positional = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      flags.set(a.slice(2), argv[i + 1]);
      i++;
    } else {
      positional.push(a);
    }
  }
  return { command, flags, positional };
}

/**
 * 执行一条 CLI 命令。
 * @param {string[]} argv
 * @returns {Promise<string>} 人类可读的输出
 */
export async function run(argv) {
  const { command, flags, positional } = parseArgs(argv);
  const dir = path.resolve(flags.get('dir') ?? positional[0] ?? process.cwd());
  const hubUrl = flags.get('hub') ?? process.env.HUB_URL;
  const token = flags.get('token') ?? process.env.HUB_TOKEN;
  /** @type {string[]} */
  const lines = [];
  const log = (s = '') => lines.push(s);

  /**
   * @param {object} [cfg]
   */
  const clientFor = (cfg) => {
    const url = hubUrl ?? cfg?.hubUrl;
    const tk = token ?? cfg?.token;
    if (!url || !tk) die('缺少 Hub 地址或 token：用 --hub/--token 参数，或设 HUB_URL/HUB_TOKEN 环境变量');
    return new HubClient({ hubUrl: url, token: tk });
  };

  /**
   * @param {string} d
   */
  const loadConfig = (d) => {
    const file = path.join(d, CONFIG_NAME);
    if (!fs.existsSync(file)) die(`${d} 不是 CoAgent 工作目录（缺 ${CONFIG_NAME}），先用 init 拉取`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };

  /** 下载整仓快照到临时文件，返回路径 */
  const snapshotFile = async (client) => {
    const buf = await client.repo.snapshot();
    const file = path.join(os.tmpdir(), `coagent-snapshot-${Date.now()}.bundle`);
    fs.writeFileSync(file, buf);
    return file;
  };

  const handlers = {
    async init() {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length) die(`目录非空：${dir}`);
      const client = clientFor();
      const me = await client.me().catch(() => die('token 无效或 Hub 不可达'));

      const bundle = await snapshotFile(client);
      g(['clone', bundle, dir]);

      const branch = `dev/${me.userId}`;
      // 优先切到远端已有状态：从 main 新建分支会导致后续推送非快进被拒
      const remoteRef = `refs/remotes/origin/${branch}`;
      const hasRemote =
        spawnSync('git', ['rev-parse', '--verify', remoteRef], { cwd: dir, encoding: 'utf8' }).status === 0;
      g(hasRemote ? ['checkout', '-b', branch, remoteRef] : ['checkout', '-b', branch], dir);
      g(['remote', 'remove', 'origin'], dir); // 不再指向 bundle 文件，后续同步走 CLI
      fs.rmSync(bundle, { force: true });

      fs.writeFileSync(
        path.join(dir, CONFIG_NAME),
        JSON.stringify({ hubUrl: client.hubUrl, token: client.token, userId: me.userId, branch }, null, 2),
      );
      log(`✓ 项目已拉到 ${dir}`);
      log(`✓ 你的私有分支：${branch}`);
      log('⚠ 注意：token 以明文存在 .coagent.json，别把这个文件提交或外发');
    },

    async pull() {
      const cfg = loadConfig(dir);
      const client = clientFor(cfg);
      const bundle = await snapshotFile(client);
      g(['fetch', bundle, '+refs/heads/*:refs/remotes/hub/*'], dir);
      fs.rmSync(bundle, { force: true });
      log('✓ 已同步远端引用：');
      for (const line of g(['for-each-ref', '--format=%(refname:short) %(objectname:short)', 'refs/remotes/hub'], dir)
        .split('\n')
        .filter(Boolean)) {
        log(`    ${line}`);
      }
    },

    async push() {
      const cfg = loadConfig(dir);
      const client = clientFor(cfg);
      const branch = g(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
      if (branch !== cfg.branch) die(`当前分支是 ${branch}，只能推送自己的 ${cfg.branch}`);

      const bundle = path.join(os.tmpdir(), `coagent-push-${Date.now()}.bundle`);
      g(['bundle', 'create', bundle, branch], dir);
      const buf = fs.readFileSync(bundle);
      fs.rmSync(bundle, { force: true });

      const res = await client.branch.push(branch, buf);
      log(`✓ 已推送 ${res.branch} → ${res.sha.slice(0, 7)}`);
      log('  想合入 main：用 review 接口发起审核，他人批准后再 merge');
    },

    async status() {
      const cfg = loadConfig(dir);
      const client = clientFor(cfg);
      const [{ tasks }, health] = await Promise.all([client.task.list(), client.healthz()]);
      const { events } = await client.request('GET', '/events', {
        query: { after: Math.max(0, health.lastSeq - 12) },
      });

      log('\n— 任务板 —');
      if (!tasks.length) log('  （空）');
      for (const t of tasks) log(`  [${t.status}] ${t.title}　认领：${t.assignee ?? '—'}`);

      log('\n— 最近动态 —');
      for (const e of events.slice(-12)) log(`  #${e.seq} ${e.type}　${e.authorId}`);

      try {
        const d = await client.branch.diff(cfg.branch);
        log(`\n— 你的分支 ${cfg.branch} — 领先 main ${d.ahead} 个提交，落后 ${d.behind} 个`);
      } catch {
        log(`\n— 你的分支 ${cfg.branch} 尚未推送到 Hub —`);
      }
    },

    async sync() {
      await handlers.pull();
      await handlers.status();
    },

    async whoami() {
      const cfg = fs.existsSync(path.join(dir, CONFIG_NAME)) ? loadConfig(dir) : undefined;
      const client = clientFor(cfg);
      const me = await client.me();
      log(`userId: ${me.userId}`);
      log(`name:   ${me.name}`);
      log(`scopes: ${me.scopes.join(', ')}`);
    },
  };

  if (!command) return USAGE;
  if (!handlers[command]) die(`未知命令：${command}\n${USAGE}`);
  await handlers[command]();
  return lines.join('\n');
}

export const USAGE = `
CoAgent agent 命令行工具

  init <dir>    从 Hub 拉取项目并建立自己的私有分支
  pull          拉取全员最新进度
  push          推送本地改动到自己的私有分支
  status        任务板 + 最近动态 + 分支差距
  sync          pull + status（推荐每天开工前）
  whoami        查看当前身份

参数：--hub <url>  --token <token>  --dir <工作目录>
环境变量：HUB_URL、HUB_TOKEN
`.trim();

// 命令行入口
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2))
    .then((out) => console.log(out))
    .catch((err) => {
      console.error(`✗ ${err.message}`);
      process.exit(err instanceof CliError ? 1 : 2);
    });
}
