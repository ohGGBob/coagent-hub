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

/* ---------- 零依赖 ANSI 彩色输出（检测 NO_COLOR / 非 TTY 自动降级） ---------- */
const USE_COLOR = !process.env.NO_COLOR && process.stdout.isTTY !== false;
const c = (code) => (s) => (USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const color = {
  reset: c(0),
  bold: c(1),
  dim: c(2),
  red: c(31),
  green: c(32),
  yellow: c(33),
  blue: c(34),
  magenta: c(35),
  cyan: c(36),
  gray: c(90),
  bgBlue: c(44),
  bgGreen: c(42),
};
const ok = (s) => color.green('✓ ' + s);
const fail = (s) => color.red('✗ ' + s);
const warn = (s) => color.yellow('⚠ ' + s);
const info = (s) => color.cyan('→ ' + s);
const hr = () => color.gray('─'.repeat(56));
const shortId = (id) => String(id || '').slice(0, 8);

/** 需要本机 git 的命令（其余命令纯走 HTTP，无 git 也能用） */
const GIT_NEEDED = new Set(['init', 'pull', 'push', 'status', 'sync']);

/**
 * git 依赖检测：缺 git 时给出新人能看懂的指引，而不是一堆 spawnSync 报错。
 * @param {string} command
 */
function requireGit(command) {
  if (!GIT_NEEDED.has(command)) return;
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (r.status !== 0 || r.error) {
    die(
      '本机没有安装 git（或不在 PATH），而 ' + command + ' 需要它。\n' +
      '  → 下载安装：https://git-scm.com/download/win\n' +
      '  → 安装时一路默认即可；装完重开终端再试。\n' +
      '  （note / task / claim / whoami 等纯网络命令不受影响，可以先干着）',
    );
  }
}

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
    if (a == null) continue; // 跳过数组空洞 / undefined
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      // 下一个元素是另一个 flag 或不存在时，当前 flag 视为布尔标记（值为 true）
      if (next == null || String(next).startsWith('--')) {
        flags.set(a.slice(2), 'true');
      } else {
        flags.set(a.slice(2), next);
        i++;
      }
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
  requireGit(command);
  // 只有 init 的位置参数是工作目录；note/task/claim/adduser 的位置参数分别是
  // 标题/任务id/用户id，绝不能吞进 dir（在工作目录内裸敲 note "标题" 是最常见用法）
  const dir = path.resolve(flags.get('dir') ?? (command === 'init' ? positional[0] : undefined) ?? process.cwd());
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
      log(hr());
      log(ok(`项目已拉到 ${color.bold(dir)}`));
      log(ok(`你的私有分支：${color.cyan(branch)}`));
      log(warn('token 以明文存在 .coagent.json，别把这个文件提交或外发'));
      log(info('下一步：coagent.exe sync（看任务板）→ 写代码 → coagent.exe push'));
    },

    async pull() {
      const cfg = loadConfig(dir);
      const client = clientFor(cfg);
      const bundle = await snapshotFile(client);
      g(['fetch', bundle, '+refs/heads/*:refs/remotes/hub/*'], dir);
      fs.rmSync(bundle, { force: true });
      log(ok('已同步远端引用：'));
      for (const line of g(['for-each-ref', '--format=%(refname:short) %(objectname:short)', 'refs/remotes/hub'], dir)
        .split('\n')
        .filter(Boolean)) {
        log(`    ${color.gray(line)}`);
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
      log(hr());
      log(ok(`已推送 ${color.cyan(res.branch)} → ${color.magenta(res.sha.slice(0, 7))}`));
      log(info('想合入 main：用 review 接口发起审核，他人批准后再 merge'));
    },

    async status() {
      const cfg = loadConfig(dir);
      const client = clientFor(cfg);
      const [{ tasks }, health] = await Promise.all([client.task.list(), client.healthz()]);
      const { events } = await client.request('GET', '/events', {
        query: { after: Math.max(0, health.lastSeq - 12) },
      });

      log(hr());
      log(color.bold('📋 任务板'));
      if (!tasks.length) log(color.gray('  （空）'));
      for (const t of tasks) {
        const st = t.status === 'done' ? color.green('[完成]') : t.status === 'claimed' ? color.yellow('[进行中]') : color.cyan('[待认领]');
        log(`  ${st} ${t.title}　${color.gray('认领：' + (t.assignee ?? '—'))}`);
      }

      log('');
      log(color.bold('⚡ 最近动态'));
      for (const e of events.slice(-12)) log(`  ${color.gray('#' + e.seq)} ${color.cyan(e.type)}　${color.gray(e.authorId)}`);

      try {
        const d = await client.branch.diff(cfg.branch);
        log('');
        log(color.bold(`🌿 你的分支 ${cfg.branch}`));
        log(`  领先 main ${color.green(d.ahead)} 个提交，落后 ${color.yellow(d.behind)} 个`);
      } catch {
        log('');
        log(color.bold(`🌿 你的分支 ${cfg.branch}`));
        log(color.gray('  尚未推送到 Hub'));
      }
      log(hr());
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
      log(hr());
      log(ok(`已开户：${color.bold(user.id)}（${user.name}）`));
      log('');
      log(color.bold('—— 把下面整段发给这位同学即可 ——'));
      log(color.gray('┌─────────────────────────────────────────────'));
      log(`│ 1. 到 GitHub Releases 下载 ${color.cyan('coagent-x64.exe')}（无需装 Node）`);
      log(`│ 2. 代码协作：${color.green('coagent.exe init ./my-work')} --hub ${url} --token ${color.yellow(user.token)}`);
      log(`│    之后在工作目录里：${color.cyan('sync')}（开工）/ ${color.cyan('push')}（交作业）`);
      log(`│ 3. agent 接入：把这句话发给你的 agent ——`);
      log(`│    「fetch ${url}/guide 并照做」`);
      log(color.gray('└─────────────────────────────────────────────'));
      log('');
      log(warn('token 只显示这一次，请同学妥善保存；泄露就用 rotate 换新。'));
      log(hr());
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
      log(ok(`笔记已上墙：[${color.cyan(entry.type)}] ${color.bold(entry.title)}`));
    },

    /** 一句话建任务 */
    async task() {
      const cfg = loadConfig(dir);
      const client = clientFor(cfg);
      const title = positional[0] ?? flags.get('title');
      if (!title) die('用法：task "任务标题" [--body 描述]');
      const { task } = await client.task.create({ title, description: flags.get('body') ?? '' });
      log(ok(`任务已创建：${color.magenta(task.id.slice(0, 8))} ${color.bold(task.title)}`));
      log(info(`认领：coagent.exe claim ${task.id.slice(0, 8)}`));
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
      log(ok(`已认领：${color.bold(task.title)}`));
    },

    async whoami() {
      const cfg = fs.existsSync(path.join(dir, CONFIG_NAME)) ? loadConfig(dir) : undefined;
      const client = clientFor(cfg);
      const me = await client.me();
      log(hr());
      log(`${color.bold('userId:')} ${color.cyan(me.userId)}`);
      log(`${color.bold('name:   ')} ${me.name}`);
      log(`${color.bold('scopes: ')} ${me.scopes.map((s) => s.includes('admin') ? color.red(s) : color.gray(s)).join(', ')}`);
      log(hr());
    },

    /** 给任务或 PR 发评论 */
    async comment() {
      const cfg = loadConfig(dir);
      const client = clientFor(cfg);
      const target = flags.get('task') ?? flags.get('review');
      const kind = flags.get('task') ? 'task' : 'review';
      const body = positional[0] ?? flags.get('body');
      if (!target || !body) die('用法：comment "评论内容" --task <任务id> 或 --review <PR id>');
      const endpoint = kind === 'task' ? `/tasks/${target}/comments` : `/reviews/${target}/comments`;
      const { comment } = await client.request('POST', endpoint, { body });
      log(ok(`评论已发送到 ${kind} ${color.magenta(shortId(target))}`));
      log(color.gray(`  ${comment.body.slice(0, 80)}`));
    },

    /** 查看事件历史日志 */
    async log() {
      const cfg = loadConfig(dir);
      const client = clientFor(cfg);
      const limit = Number(flags.get('limit') ?? 30);
      const after = Number(flags.get('after') ?? 0);
      const { events, lastSeq } = await client.request('GET', '/events', { query: { after, limit } });
      log(hr());
      log(color.bold(`📜 事件日志（${events.length} 条，lastSeq=${lastSeq}）`));
      log(hr());
      for (const e of events) {
        log(`  ${color.gray('#' + String(e.seq).padStart(4))} ${color.cyan(e.type.padEnd(20))} ${color.gray(e.authorId.padEnd(12))} ${JSON.stringify(e.payload).slice(0, 60)}`);
      }
    },

    /** 全局搜索（任务 + 上下文） */
    async search() {
      const cfg = loadConfig(dir);
      const client = clientFor(cfg);
      const q = positional[0] ?? flags.get('q');
      if (!q) die('用法：search "关键词"');
      const r = await client.search(q, Number(flags.get('limit') ?? 10));
      log(hr());
      log(color.bold(`🔍 搜索：${q}（共 ${r.total} 条结果）`));
      log(hr());
      if (r.tasks?.length) {
        log(color.bold('\n📋 任务：'));
        for (const t of r.tasks) log(`  ${color.magenta(shortId(t.id))} [${t.status}/${t.priority}] ${t.title}`);
      }
      if (r.context?.length) {
        log(color.bold('\n💬 上下文：'));
        for (const c of r.context) log(`  ${color.magenta(shortId(c.id))} [${c.type}] ${c.title} — ${c.authorId}`);
      }
      if (!r.tasks?.length && !r.context?.length) log(color.gray('  无匹配结果'));
    },

    /** 查看分支 diff */
    async diff() {
      const cfg = loadConfig(dir);
      const client = clientFor(cfg);
      const branch = positional[0] ?? cfg.branch;
      const base = flags.get('base') ?? 'main';
      if (!branch) die('用法：diff [分支名] [--base main]');
      const d = await client.branch.diff(branch, base);
      log(hr());
      log(color.bold(`🌿 Diff: ${branch} → ${base}`));
      log(`  领先 ${color.green(d.ahead)} 个提交，落后 ${color.yellow(d.behind)} 个`);
      log(hr());
      if (d.commits?.length) {
        log(color.bold('\n提交记录：'));
        for (const c of d.commits) log(`  ${color.magenta(c.sha.slice(0, 7))} ${c.subject}`);
      }
      if (d.stat) { log(color.bold('\n变更统计：')); log(color.gray(d.stat)); }
      if (flags.get('full') && d.patch) { log(color.bold('\n完整 diff：')); log(d.patch); }
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

      const printEvent = (ev) => log(`${color.gray('#' + ev.seq)} ${color.cyan(ev.type)} ${color.gray(ev.authorId)} ${JSON.stringify(ev.payload)}`);

      log(hr());
      log(color.bold(`👁  开始监听（${live ? color.green('实时+轮询') : color.yellow('纯轮询')}，间隔 ${Math.round(intervalMs / 1000)}s，Ctrl+C 退出）`));
      log(hr());

      if (live) {
        connectHubWs({
          hubUrl: client.hubUrl,
          token: client.token,
          since,
          onEvent: (ev) => (ev.type === 'hello' ? log(ok(`实时已连接，服务端 lastSeq=${color.magenta(ev.lastSeq)}`)) : printEvent(ev)),
          onError: (err) => console.error(color.red(`[实时] ${err.message}（将自动重连）`)),
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
  comment "…"   发评论（--task <id> 或 --review <id>）
  pull          拉取全员最新进度
  push          推送本地改动到自己的私有分支
  diff [branch] 查看分支 diff（--base main --full 显示完整 patch）
  status        任务板 + 最近动态 + 分支差距
  sync          pull + status（推荐每天开工前）
  log           查看事件历史（--limit 30 --after <seq>）
  search "关键词" 全局搜索任务和上下文
  watch         常驻监听事件（--interval 30m 定轮询；--live 1 加实时推送）
  whoami        查看当前身份

参数：--hub <url>  --token <token>  --dir <工作目录>
环境变量：HUB_URL、HUB_TOKEN
`.trim();

// 命令行入口（SEA 打包为 coagent.exe 时由 sea-entry 调度，这里让位）
if (process.env.COAGENT_ENTRY !== 'sea' && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2))
    .then((out) => console.log(out))
    .catch((err) => {
      console.error(fail(err.message));
      process.exit(err instanceof CliError ? 1 : 2);
    });
}
