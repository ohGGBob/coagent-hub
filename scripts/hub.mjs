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
import { HubClient, connectHubWs } from '../src/sdk/client.js';

const CONFIG_NAME = '.coagent.json';

export class CliError extends Error {}

/** 解析时间间隔：纯数字=秒，支持 45s / 30m / 1h */
function parseInterval(text) {
  const m = /^(\d+)(s|m|h)?$/i.exec(String(text ?? '').trim());
  if (!m) die(`无法识别的时间间隔：${text}（示例：300 / 45s / 30m / 1h）`);
  const unit = (m[2] ?? 's').toLowerCase();
  return Number(m[1]) * { s: 1, m: 60, h: 3600 }[unit];
}

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

    /**
     * 开户并直接输出可转发给同学的「接入卡片」——开户到能干活一步到位。
     * 需要管理员 token：--token / HUB_TOKEN / 工作目录配置均可。
     */
    async adduser() {
      const id = positional[0];
      const name = positional[1];
      if (!id) die('用法：adduser <userId> [显示名]');
      const cfg = fs.existsSync(path.join(dir, CONFIG_NAME)) ? loadConfig(dir) : undefined;
      const client = clientFor(cfg);
      const { user } = await client.users.create({ id, name });
      const url = client.hubUrl;
      log(`✓ 已开户：${user.id}（${user.name}）`);
      log('');
      log('—— 把下面整段发给这位同学即可 ——');
      log('┌─────────────────────────────────────────────');
      log(`│ 1. 找 ${user.name} 要一份本项目的代码副本（npm run hub 的项目目录）`);
      log(`│ 2. 装好 Node ≥18 和 git 后，在项目目录执行：`);
      log(`│    npm run hub -- init ./my-work --hub ${url} --token ${user.token}`);
      log(`│ 3. 每天开工：npm run hub -- sync --dir ./my-work`);
      log(`│ 4. 改完代码：npm run hub -- push --dir ./my-work`);
      log('└─────────────────────────────────────────────');
      log('');
      log('⚠ token 只显示这一次，请同学妥善保存；泄露就用 rotate 换新。');
    },

    /** 一句话贴共享笔记（agent 不写代码也能共享上下文） */
    async note() {
      const cfg = loadConfig(dir);
      const client = clientFor(cfg);
      const title = positional[0] ?? flags.get('title');
      if (!title) die('用法：note "标题" [--body 正文] [--type decision|progress|blocker|note|summary] [--task 任务id]');
      const { entry } = await client.context.append({
        type: flags.get('type') ?? 'note',
        title,
        body: flags.get('body') ?? '',
        taskId: flags.get('task') || undefined,
        tags: flags.get('tags') ? flags.get('tags').split(',') : [],
      });
      log(`✓ 笔记已上墙：[${entry.type}] ${entry.title}`);
    },

    /** 一句话建任务 */
    async task() {
      const cfg = loadConfig(dir);
      const client = clientFor(cfg);
      const title = positional[0] ?? flags.get('title');
      if (!title) die('用法：task "任务标题" [--body 描述]');
      const { task } = await client.task.create({ title, description: flags.get('body') ?? '' });
      log(`✓ 任务已创建：${task.id.slice(0, 8)} ${task.title}`);
      log(`  认领：npm run hub -- claim ${task.id}`);
    },

    /** 认领任务：支持完整 id 或前缀（status 输出的 8 位短 id 就够用） */
    async claim() {
      const cfg = loadConfig(dir);
      const client = clientFor(cfg);
      let id = positional[0];
      if (!id) die('用法：claim <任务id 或前缀>（从 status / task 输出里复制）');

      const { tasks } = await client.task.list();
      const hits = tasks.filter((t) => t.id.startsWith(id) || t.title === id);
      if (hits.length === 0) die(`没有匹配的任务：${id}`);
      if (hits.length > 1) die(`前缀有歧义，命中 ${hits.length} 个任务，请用更长的 id`);
      id = hits[0].id;

      const { task } = await client.task.claim(id);
      log(`✓ 已认领：${task.title}`);
    },

    async whoami() {
      const cfg = fs.existsSync(path.join(dir, CONFIG_NAME)) ? loadConfig(dir) : undefined;
      const client = clientFor(cfg);
      const me = await client.me();
      log(`userId: ${me.userId}`);
      log(`name:   ${me.name}`);
      log(`scopes: ${me.scopes.join(', ')}`);
    },

    /**
     * 常驻监听：默认按 interval 轮询；--live 同时开 WebSocket 实时推送，
     * 轮询作断线安全网——正好是设计文档的「实时 + 异步」混合节奏。
     */
    async watch() {
      const cfg = loadConfig(dir);
      const client = clientFor(cfg);
      const intervalMs = parseInterval(flags.get('interval') ?? '5m') * 1000;
      const live = flags.get('live') === '1' || flags.get('live') === 'true';
      const since = Number(flags.get('since') ?? 0);

      const printEvent = (ev) => log(`[事件] #${ev.seq} ${ev.type}　${ev.authorId}　${JSON.stringify(ev.payload)}`);

      log(`开始监听（${live ? '实时+轮询' : '轮询'}，间隔 ${Math.round(intervalMs / 1000)}s，Ctrl+C 退出）`);

      if (live) {
        connectHubWs({
          hubUrl: client.hubUrl,
          token: client.token,
          since,
          onEvent: (ev) => (ev.type === 'hello' ? log(`[实时] 已连接，服务端 lastSeq=${ev.lastSeq}`) : printEvent(ev)),
          onError: (err) => console.error(`[实时] ${err.message}（将自动重连）`),
        });
      }

      let lastSeq = since;
      const poll = async () => {
        try {
          const { events } = await client.request('GET', '/events', { query: { after: lastSeq } });
          for (const ev of events) {
            if (!live || ev.seq > lastSeq) printEvent(ev); // live 模式下避免与 WS 重复打印
            lastSeq = Math.max(lastSeq, ev.seq);
          }
        } catch (err) {
          console.error(`[轮询] ${err.message}（继续重试）`);
        }
      };
      await poll();
      setInterval(poll, intervalMs).unref();
      // keep alive
      setInterval(() => {}, 1 << 30);
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
  adduser <id>  开户并打印可转发的接入卡片（需管理员 token）
  note "标题"   一句话上墙共享笔记（--body 正文 --type 类型 --task 任务）
  task "标题"   一句话建任务（--body 描述）／ claim <id> 认领
  pull          拉取全员最新进度
  push          推送本地改动到自己的私有分支
  status        任务板 + 最近动态 + 分支差距
  sync          pull + status（推荐每天开工前）
  watch         常驻监听事件（--interval 30m 定轮询；--live 1 加实时推送）
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
