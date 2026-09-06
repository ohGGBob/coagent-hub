#!/usr/bin/env node
/**
 * 端到端冒烟：用临时数据目录起一个真实 Hub，跑通多 agent 协同全链路，
 * 并逐条验证「权限必须拦得住」的反例。
 *
 * 运行：npm run smoke
 *
 * @module smoke
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 仓库根目录（scripts 的上一级），供子进程（CLI）定位入口 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 必须在 import Hub 之前指定数据目录（config 在模块加载时读取环境变量）
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent-smoke-'));
process.env.COAGENT_DATA = path.join(TMP_ROOT, 'data');

// ---- mock Ollama 嵌入端点（Phase 3 语义检索）----
// 用「语义词典 → 固定维度向量」生成确定性嵌入：词典词命中则累加对应维度。
// 这样既有 BM25 断言不受 hybrid 扰动，又能验证语义召回与降级路径。
const EMBED_DIMS = 6;
const SEMANTIC_DICT = [
  ['登录', [1, 0, 0, 0, 0, 0]], ['登入', [1, 0, 0, 0, 0, 0]],
  ['手机', [0, 1, 0, 0, 0, 0]], ['短信', [0, 1, 0, 0, 0, 0]],
  ['验证', [0, 0.5, 1, 0, 0, 0]],
  ['屏幕', [0, 0, 0, 1, 0, 0]], ['显示', [0, 0, 0, 1, 0, 0]],
  ['数据库', [0, 0, 0, 0, 1, 0]], ['连接', [0, 0, 0, 0, 0.5, 1]],
];
function mockVec(text) {
  const v = new Array(EMBED_DIMS).fill(0);
  for (const [word, dims] of SEMANTIC_DICT) {
    if (String(text).includes(word)) dims.forEach((d, i) => { v[i] += d; });
  }
  return v;
}
const mockOllama = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.url === '/api/embed') {
      try {
        const { input } = JSON.parse(body || '{}');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ embeddings: (input ?? []).map(mockVec) }));
      } catch { res.statusCode = 400; res.end('{}'); }
    } else { res.statusCode = 404; res.end('{}'); }
  });
});
await new Promise((resolve) => mockOllama.listen(0, '127.0.0.1', resolve));
process.env.COAGENT_EMBED_URL = `http://127.0.0.1:${mockOllama.address().port}`;

// 兜底清理：进程被强杀（SIGTERM/调试中断）时 finally 不执行，会留下历史临时目录。
// 只删除超过 1 小时的同前缀目录，避免误伤并行运行的其它 smoke 实例。
const STALE_MS = 60 * 60 * 1000;
try {
  for (const name of fs.readdirSync(os.tmpdir())) {
    // 白名单：目录名只能是「coagent-smoke-」+ 十六进制随机段
    if (!/^coagent-smoke-[A-Za-z0-9_-]+$/.test(name)) continue;
    const dir = path.resolve(os.tmpdir(), name);
    if (dir === TMP_ROOT || !dir.startsWith(os.tmpdir() + path.sep)) continue;
    const st = fs.statSync(dir);
    if (Date.now() - st.mtimeMs > STALE_MS) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
} catch { /* 清理失败不影响测试 */ }


const { PATHS } = await import('../src/config.js');
const { createHub } = await import('../src/server.js');
const { HubClient, connectHubWs } = await import('../src/sdk/client.js');
const { defaultTokensActive } = await import('../src/auth.js');

// ---------------------------------------------------------------- 测试骨架
let passed = 0;
let failed = 0;
const failures = [];

/**
 * @param {boolean} cond
 * @param {string} msg
 */
function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  \u2713 ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  \u2717 ${msg}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/**
 * 断言某个异步调用会以指定 HTTP 状态码失败。
 * @param {() => Promise<any>} fn
 * @param {number} status
 * @param {string} msg
 */
async function rejects(fn, status, msg) {
  try {
    await fn();
    ok(false, `${msg}（本应被拒绝，却成功了）`);
  } catch (err) {
    if (err.status === undefined) {
      // 非预期异常（如连接被重置），打出根因便于定位
      console.log(`  [诊断] ${msg}：${err.message} | cause=${err.cause?.code ?? err.cause?.message ?? '无'}`);
    }
    ok(err.status === status, `${msg} → ${err.status} ${err.code}`);
  }
}

// ---------------------------------------------------------------- git 辅助
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Smoke Agent',
  GIT_AUTHOR_EMAIL: 'smoke@coagent.local',
  GIT_COMMITTER_NAME: 'Smoke Agent',
  GIT_COMMITTER_EMAIL: 'smoke@coagent.local',
};

/**
 * @param {string[]} args
 * @param {string} [cwd]
 */
function g(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${(r.stderr || '').trim()}`);
  return (r.stdout || '').trim();
}

/** 工作目录名白名单：只允许字母数字 _ - */
const SAFE_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * @param {string} name
 */
function cloneWork(name) {
  if (!SAFE_NAME.test(name)) throw new Error(`非法工作目录名：${name}`);
  const dir = path.resolve(TMP_ROOT, name);
  if (dir !== TMP_ROOT && !dir.startsWith(TMP_ROOT + path.sep)) {
    throw new Error(`工作目录越界：${name}`);
  }
  g(['clone', '--quiet', PATHS.repo, dir]);
  g(['config', 'user.name', name], dir);
  g(['config', 'user.email', `${name}@coagent.local`], dir);
  return dir;
}

/**
 * @param {string} dir
 * @param {string} branch
 * @param {string} file
 * @param {string} content
 * @param {string} msg
 */
function commitOn(dir, branch, file, content, msg) {
  g(['checkout', '-b', branch], dir);
  fs.writeFileSync(path.join(dir, file), content);
  g(['add', file], dir);
  g(['commit', '--quiet', '-m', msg], dir);
  return g(['rev-parse', 'HEAD'], dir);
}

/**
 * @param {string} dir
 * @param {string} branch
 * @param {string} outName
 */
function makeBundle(dir, branch, outName) {
  const out = path.join(TMP_ROOT, outName);
  fs.rmSync(out, { force: true });
  g(['bundle', 'create', out, branch], dir);
  return fs.readFileSync(out);
}

// ---------------------------------------------------------------- 启动 Hub
const { server } = createHub();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const hubUrl = `http://127.0.0.1:${server.address().port}`;
const alice = new HubClient({ hubUrl, token: 'tok_alice_0001' });
const bob = new HubClient({ hubUrl, token: 'tok_bob_0002' });

try {
  // ------------------------------------------------------------ 1. 健康与鉴权
  section('1. 服务与鉴权');
  const health = await alice.healthz();
  ok(health.ok === true, 'healthz 返回 ok');
  ok(health.users === undefined, 'healthz 不再暴露用户清单（瘦身）');
  ok((await alice.branch.list()).branches.includes('main'), '裸仓已初始化 main 分支');
  ok((await alice.me()).userId === 'alice', '/me 识别 alice 身份');
  await rejects(() => new HubClient({ hubUrl, token: 'tok_nope' }).me(), 401, '无效 token 被拒');

  // /guide 与 /panel：公开端点，正文完整伺服（SDK 对非 JSON 包成 {raw}）
  {
    const g = await alice.request('GET', '/guide');
    ok(String(g.raw).includes('# CoAgent Hub') && String(g.raw).includes(hubUrl), '/guide 返回含 Hub 地址的接入指南');
    const p = await alice.request('GET', '/panel');
    ok(String(p.raw).includes('CoAgent Hub') && String(p.raw).includes('renderDashboard'), '/panel 返回管理面板 HTML');
  }

  // ------------------------------------------------------------ 2. 任务板
  section('2. 任务板与认领冲突');
  const { task } = await alice.task.create({ title: '实现事件日志回放', tags: ['phase1'] });
  ok(!!task.id, `alice 创建任务：${task.title}`);
  ok((await bob.task.list()).tasks.some((t) => t.id === task.id), 'bob 能看到该任务（共享可读）');
  await bob.task.claim(task.id);
  ok((await alice.task.get(task.id)).task.assignee === 'bob', 'bob 认领成功');
  await rejects(() => alice.task.claim(task.id), 409, 'alice 抢已被认领的任务被拒');

  // ------------------------------------------------------------ 3. 分支权限
  section('3. 分支权限');
  await alice.branch.create();
  await bob.branch.create();
  ok((await alice.branch.list()).branches.includes('dev/alice'), '创建 dev/alice');
  ok((await alice.branch.list()).branches.includes('dev/bob'), '创建 dev/bob');
  await rejects(() => alice.branch.create({ name: 'dev/bob' }), 403, 'alice 创建他人分支被拒');
  await rejects(() => alice.branch.create({ name: 'main' }), 403, '创建受保护分支 main 被拒');

  // ------------------------------------------------------------ 4. 推送（bundle 通道）
  section('4. 代码推送（bundle 通道）');
  const aliceWork = cloneWork('work-alice');
  const aliceSha = commitOn(aliceWork, 'dev/alice', 'log.md', '# eventlog\n', 'feat: 事件日志');
  const aliceBundle = makeBundle(aliceWork, 'dev/alice', 'alice.bundle');

  const pushed = await alice.branch.push('dev/alice', aliceBundle);
  ok(pushed.sha === aliceSha, `alice 推送成功 → ${pushed.branch}@${pushed.sha.slice(0, 7)}`);
  await rejects(() => alice.branch.push('main', aliceBundle), 403, '直推 main 被拒');
  await rejects(() => alice.branch.push('dev/bob', aliceBundle), 403, '推送到他人分支被拒');

  const d = await alice.branch.diff('dev/alice');
  ok(d.ahead === 1 && d.behind === 0, `diff 正确：ahead=${d.ahead} behind=${d.behind}`);
  ok(d.patch.includes('log.md'), 'diff patch 含新增文件');

  // ------------------------------------------------------------ 5. 共享上下文
  section('5. 共享上下文（只读共享 + 仅作者可写）');
  const { entry } = await alice.context.append({
    type: 'decision',
    title: '事件日志用 JSONL',
    body: 'Phase 1 不上数据库，先落 JSONL，Phase 3 再迁 Postgres。',
    tags: ['architecture'],
    taskId: task.id,
  });
  ok(!!entry.id, 'alice 追加上下文');
  const seen = await bob.context.query();
  ok(seen.entries.some((e) => e.id === entry.id), 'bob 能读到 alice 的上下文');
  ok(
    (await bob.context.query({ taskId: task.id })).entries.length === 1,
    '按 taskId 过滤生效',
  );
  await rejects(() => bob.context.retract(entry.id), 403, 'bob 撤回 alice 的条目被拒');
  await alice.context.retract(entry.id);
  ok(
    !(await bob.context.query()).entries.some((e) => e.id === entry.id),
    'alice 撤回后默认查询中消失',
  );
  ok(
    (await bob.context.query({ includeRetracted: true })).entries.some((e) => e.id === entry.id),
    'includeRetracted=1 仍可追溯（撤回是软删除）',
  );

  // BM25 相关性检索：多词、CJK 二元组、标题加权、无命中返回空
  await alice.context.append({ type: 'note', title: '登录页采用 WebSocket 推送在线状态' });
  await alice.context.append({ type: 'note', title: '数据库连接池大小定为 20' });
  await alice.context.append({ type: 'blocker', title: '等待设计师给登录页配色稿' });
  const ranked = await bob.context.query({ q: '登录页 在线状态' });
  ok(ranked.entries.length >= 2, 'BM25 多词检索有命中');
  ok(
    ranked.entries[0].title.includes('登录页') && ranked.entries[0].title.includes('WebSocket'),
    'BM25 相关性排序：双词全中的排最前',
  );
  ok(
    ranked.entries[0].title.includes('登录页') && !ranked.entries[0].title.includes('连接池') ||
      ranked.entries.every((e) => !e.title.includes('连接池') || e.title.includes('登录页')),
    '无关条目不掺和进结果',
  );
  ok((await bob.context.query({ q: '不存在的词组xyzq' })).entries.length === 0, '无命中返回空');
  ok((await bob.context.query({ q: '配色稿' })).entries.length === 1, 'CJK 单条精确命中');

  // ------------------------------------------------------------ 6. 事件回放
  section('6. 事件日志（唯一真相源）');
  const full = await bob.sync(); // 首次从 0 拉取
  ok(full.length > 0, `bob 全量回放拿到 ${full.length} 条事件`);
  ok(
    full.every((e, i) => i === 0 || e.seq > full[i - 1].seq),
    'seq 严格单调递增',
  );
  ok(
    full.some((e) => e.type === 'branch.pushed') && full.some((e) => e.type === 'task.claimed'),
    '含 branch.pushed / task.claimed 等关键事件',
  );

  const cursor = bob.lastSeq;
  await alice.message('事件日志联调完毕，求审', { channel: 'general' });
  const inc = await bob.sync();
  ok(inc.length === 1 && inc[0].type === 'message.posted', '增量回放只取游标之后的事件');
  ok(bob.lastSeq > cursor, `游标推进 ${cursor} → ${bob.lastSeq}`);

  // ------------------------------------------------------------ 7. 审核与合并
  section('7. PR 审核与合并闸门');
  const bobWork = cloneWork('work-bob');
  const bobSha = commitOn(bobWork, 'dev/bob', 'sdk.md', '# sdk\n', 'feat: agent sdk');
  await bob.branch.push('dev/bob', makeBundle(bobWork, 'dev/bob', 'bob.bundle'));

  const { review: bobReview } = await bob.review.request({ branch: 'dev/bob' });
  ok(bobReview.status === 'open', 'bob 发起 PR');
  await rejects(() => bob.review.approve(bobReview.id), 403, '自审被拒');
  await rejects(() => bob.review.merge(bobReview.id), 409, '未 approved 直接合并被拒');
  await alice.review.approve(bobReview.id);
  ok((await bob.review.list({ status: 'approved' })).reviews.length === 1, 'alice 批准通过');

  const merged = await bob.review.merge(bobReview.id);
  ok(merged.merge.to === bobSha, `fast-forward 合入 main → ${merged.merge.to.slice(0, 7)}`);
  ok(g(['rev-parse', 'main'], PATHS.repo) === bobSha, 'main 引用确实已推进');

  // alice 的分支此时已与 main 分叉 → 应命中非快进冲突
  const { review: aliceReview } = await alice.review.request({ branch: 'dev/alice' });
  await bob.review.approve(aliceReview.id);
  await rejects(() => alice.review.merge(aliceReview.id), 409, '分叉后合并被拒（需 rebase）');

  // ------------------------------------------------------------ 8. 强制释放他人任务
  section('8. 敏感操作：释放他人任务');
  await rejects(() => alice.task.release(task.id), 403, '无审核直接释放他人任务被拒');
  const { review: releaseReview } = await alice.review.request({ taskId: task.id });
  await bob.review.approve(releaseReview.id);
  const released = await alice.task.release(task.id, { reviewId: releaseReview.id });
  ok(released.task.assignee === null, '凭 approved 审核记录释放成功');
  ok((await alice.task.claim(task.id)).task.assignee === 'alice', '释放后 alice 可重新认领');

  // ------------------------------------------------------------ 9. 用户管理 API
  section('9. 用户管理 API');
  ok(defaultTokensActive().includes('alice'), '检测到种子默认 token 仍在使用（启动警告依据）');
  const carolRes = await alice.users.create({
    id: 'carol',
    name: 'Carol',
    scopes: ['events:read', 'context:read', 'context:write', 'task:read', 'task:write'],
  });
  ok(!!carolRes.user.token, 'alice 开户 carol 并签发 token');
  ok(!carolRes.user.scopes.includes('admin:write'), 'carol 不带管理权限');
  ok(!(await alice.users.list()).users.some((u) => 'token' in u), '用户列表不外泄 token');

  const carol = new HubClient({ hubUrl, token: carolRes.user.token });
  ok((await carol.me()).userId === 'carol', 'carol 用新工牌登录');
  await rejects(() => carol.users.create({ id: 'mallory' }), 403, 'carol 开户被拒（无 admin scope）');

  // 开户不传 scopes 时，默认只发普通 agent 权限——绝不能顺手给管理员
  const daveRes = await alice.users.create({ id: 'dave', name: 'Dave' });
  ok(!daveRes.user.scopes.includes('admin:write'), '开户默认不含 admin:write（防越权）');

  const rotated = await alice.users.rotate('carol');
  await rejects(() => carol.me(), 401, '轮换后旧 token 立即失效');
  ok(
    (await new HubClient({ hubUrl, token: rotated.user.token }).me()).userId === 'carol',
    '轮换后的新 token 可用',
  );

  await rejects(() => alice.users.remove('alice'), 403, '注销自己被拒');
  ok((await alice.users.remove('carol')).removed, 'alice 注销 carol');
  await rejects(
    () => new HubClient({ hubUrl, token: rotated.user.token }).me(),
    401,
    '注销后其凭证立即失效',
  );

  // ------------------------------------------------------------ 10. 实时总线（WebSocket）
  section('10. 实时总线（WebSocket）');
  await rejects(() => alice.request('GET', '/ws'), 426, '普通 HTTP 访问 /ws → 426 要求升级连接');

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let wsOpenResolve;
  const wsOpened = new Promise((r) => (wsOpenResolve = r));
  const received = [];
  const ws = connectHubWs({
    hubUrl,
    token: 'tok_bob_0002',
    types: ['task.created', 'task.claimed', 'agent.status'],
    onEvent: (ev) => received.push(ev),
    onOpen: () => wsOpenResolve(),
  });
  await wsOpened;
  ok(true, 'bob 建立实时连接（只订阅 task 与 agent.status）');

  await alice.task.create({ title: '实时总线验证任务' });
  await alice.context.append({ type: 'note', title: '这条不该推给 bob 的实时连接' });
  await sleep(300);
  ok(
    received.some((e) => e.type === 'task.created' && e.payload.title === '实时总线验证任务'),
    '任务事件实时到达',
  );
  ok(!received.some((e) => e.type === 'context.appended'), '订阅过滤生效：context 事件未推送');

  ws.send({ type: 'agent.status', payload: { state: 'working', harness: 'claude-code' } });
  await sleep(300);
  const allEvents = await alice.request('GET', '/events', { query: { after: 0, limit: 1000 } });
  ok(
    allEvents.events.some((e) => e.type === 'agent.status' && e.payload.harness === 'claude-code'),
    '经 WS 上报的 agent.status 已落盘',
  );

  // 断线重连的兜底：since=0 全量回放（含断线期间错过的所有事件）
  const replayed = [];
  const rws = connectHubWs({ hubUrl, token: 'tok_alice_0001', since: 0, onEvent: (ev) => replayed.push(ev) });
  await sleep(400);
  ok(replayed.length >= allEvents.events.length, `重连回放完整（收到 ${replayed.length} 条）`);
  rws.close();
  ws.close();
  await sleep(100);

  // ------------------------------------------------------------ 11. 整仓读通道 + agent CLI
  section('11. 整仓读通道与 agent CLI');
  const info = await alice.repo.info();
  ok(info.refs.length >= 3, `整仓信息含 ${info.refs.length} 个分支`);
  ok(info.refs.every((r) => /^[0-9a-f]{40}$/.test(r.sha)), '每个分支都带完整 sha');

  const snapFile = path.join(TMP_ROOT, 'snapshot.bundle');
  fs.writeFileSync(snapFile, await alice.repo.snapshot());
  ok(fs.statSync(snapFile).size > 0, '整仓快照可下载');

  // 用快照 clone 出全新工作目录，验证远端 agent 的首次接入路径
  const fresh = path.join(TMP_ROOT, 'fresh-work');
  g(['clone', snapFile, fresh]);
  ok(fs.existsSync(path.join(fresh, '.git')), '快照可直接 git clone（远端 agent 开工路径通）');
  ok(g(['log', '--oneline'], fresh).length > 0, 'clone 出来的仓库有提交历史');

  // CLI 内嵌调用（不 spawn 子进程：沙箱环境下子进程网络请求可能被掐）
  const { run: cliRun } = await import('../scripts/hub.mjs');
  // 剥离 ANSI 颜色码，让断言基于纯文本匹配
  const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
  const cli = async (args) => stripAnsi(await cliRun(args));

  const cliWork = path.join(TMP_ROOT, 'cli-work');
  await cli(['init', cliWork, '--hub', hubUrl, '--token', 'tok_alice_0001']);
  ok(fs.existsSync(path.join(cliWork, '.coagent.json')), 'CLI init：项目拉取 + 生成 .coagent.json 配置');
  ok(g(['rev-parse', '--abbrev-ref', 'HEAD'], cliWork) === 'dev/alice', 'CLI init 切到私有分支 dev/alice');

  fs.writeFileSync(path.join(cliWork, 'cli.md'), '# from cli\n');
  g(['add', 'cli.md'], cliWork);
  g(['commit', '--quiet', '-m', 'feat: cli push'], cliWork);
  const pushOut = await cli(['push', '--dir', cliWork]);
  ok(pushOut.includes('已推送'), `CLI push 成功：${pushOut.split('\n')[0] ?? ''}`);

  const pullOut = await cli(['pull', '--dir', cliWork]);
  ok(pullOut.includes('hub/main'), 'CLI pull 拉到 hub/* 远端引用');

  const statusOut = await cli(['status', '--dir', cliWork]);
  ok(statusOut.includes('任务板') && statusOut.includes('dev/alice'), 'CLI status 输出任务板与分支差距');

  // 体验简化命令：note / task / claim / adduser
  const noteOut = await cli(['note', 'CLI 快捷笔记', '--body', '不用写代码也能上墙', '--dir', cliWork]);
  ok(noteOut.includes('CLI 快捷笔记'), 'CLI note 一句话上墙');
  ok(
    (await alice.context.query({ q: 'CLI 快捷笔记' })).entries.length === 1,
    'note 的内容确实进了共享上下文',
  );

  const taskOut = await cli(['task', 'CLI 快捷任务', '--dir', cliWork]);
  const taskIdShort = /✓ 任务已创建：([0-9a-f]{8})/.exec(taskOut)?.[1];
  ok(!!taskIdShort, 'CLI task 一句话建任务');
  const claimOut = await cli(['claim', taskIdShort, '--dir', cliWork]);
  ok(claimOut.includes('已认领'), 'CLI claim 认领成功');

  const addOut = await cli(['adduser', 'erin', 'Erin', '--hub', hubUrl, '--token', 'tok_alice_0001']);
  ok(addOut.includes('发给这位同学') && addOut.includes('--token tok_'), 'CLI adduser 打印可转发的接入卡片');
  const erinToken = /--token (tok_\S+)/.exec(addOut)?.[1];
  ok(
    (await new HubClient({ hubUrl, token: erinToken }).me()).userId === 'erin',
    '接入卡片里的 token 真实可用',
  );

  // ------------------------------------------------------------ 12. 输入校验与加固回归
  section('12. 输入校验与加固回归');
  {
    // tags 传非数组：必须 400，且不能在任务表里留下会让 /search 崩的脏数据
    await rejects(() => alice.task.create({ title: '毒任务', tags: 'not-an-array' }), 400, 'tags 传字符串被拒（400）');
    await rejects(() => alice.task.create({ title: '毒任务', labels: { a: 1 } }), 400, 'labels 传对象被拒（400）');
    const sr = await alice.search('anything');
    ok(Array.isArray(sr.tasks) && Array.isArray(sr.context), '搜索端点不再被脏数据毒化（200）');

    // PATCH 状态一致性：assignee 禁改；claimed/open 走专用接口
    const { task: vt } = await alice.task.create({ title: '校验用任务', tags: ['hardening'] });
    await rejects(() => alice.task.update(vt.id, { status: 'claimed', assignee: 'alice' }), 400, 'PATCH 携带 assignee 被拒');
    await rejects(() => alice.task.update(vt.id, { status: 'banana' }), 400, 'PATCH 非法 status 被拒');
    await rejects(() => alice.task.update(vt.id, { status: 'claimed' }), 400, 'PATCH 直改 claimed 被拒（请走 claim）');
    await rejects(() => alice.task.update(vt.id, { title: '   ' }), 400, 'PATCH 空 title 被拒');
    await alice.task.update(vt.id, { status: 'done' });
    await alice.task.update(vt.id, { status: 'open' });
    ok((await alice.task.get(vt.id)).task.assignee === null, 'PATCH open 归位后 assignee 一并清空');
    await bob.task.claim(vt.id);
    await rejects(() => alice.task.update(vt.id, { status: 'open' }), 403, 'PATCH open 释放他人任务被拒（走 release+审核）');

    // 长度上限
    await rejects(() => alice.task.create({ title: 'x'.repeat(301) }), 400, '超长 title 被拒');
    await rejects(() => alice.context.append({ title: 't', body: 'x'.repeat(100_001) }), 400, '超长 context body 被拒');
    await rejects(() => alice.request('POST', '/messages', { body: { text: 'x'.repeat(10_001) } }), 400, '超长消息被拒');
    await rejects(() => bob.task.addComment(vt.id, 'x'.repeat(10_001)), 400, '超长评论被拒');
  }

  // ------------------------------------------------------------ 13. 收尾一致性
  section('13. 一致性');
  const finalEvents = await alice.replay();
  ok(finalEvents.events[finalEvents.events.length - 1].seq === finalEvents.lastSeq, '回放末条 seq == lastSeq');
  ok(alice.lastSeq === 0, 'alice 游标未被意外修改（回放不推进游标）');
  const finalBranches = (await alice.branch.list()).branches;
  ok(finalBranches.includes('dev/alice') && finalBranches.includes('dev/bob'), '分支全景完整');

  // ------------------------------------------------------------ 14. 语义检索（mock Ollama）
  section('14. 语义检索（mock Ollama）');
  {
    // 等启动回填把既有条目嵌入完成（coverage 收敛）
    let st = null;
    for (let i = 0; i < 50; i++) {
      st = await alice.request('GET', '/embed/status');
      if (st.available && st.coverage.total > 0 && st.coverage.embedded >= st.coverage.total) break;
      await sleep(100);
    }
    ok(st.available === true, 'mock Ollama 探测成功（/embed/status available）');
    ok(st.provider === 'ollama' && st.model === 'bge-m3' && st.dim === EMBED_DIMS, `嵌入来源/模型/维度正确（${st.provider} / ${st.model} / ${st.dim} 维）`);
    ok(st.coverage.embedded > 0 && st.coverage.embedded >= st.coverage.total, `历史条目已回填向量（${st.coverage.embedded}/${st.coverage.total}）`);

    // 语义-only 召回：查询词与条目无任何关键词/bigram 重合，仅靠向量相似命中
    await alice.context.append({ type: 'note', title: '移动端支持短信验证码快捷登录' });
    let semEntry = null;
    for (let i = 0; i < 50; i++) {
      const r = await bob.context.query({ q: '手机认证' });
      semEntry = r.entries.find((e) => e.title.includes('短信验证码'));
      if (semEntry) break;
      await sleep(100);
    }
    ok(!!semEntry, '语义-only 命中：零关键词重合仍能召回（BM25 单独做不到）');
    ok(semEntry?._via === 'semantic', `标记为 semantic（实际：${semEntry?._via ?? '无'}）`);

    // hybrid：查询与条目既有关键词重合又有语义相似
    const both = await bob.context.query({ q: '登录 短信' });
    ok(both.entries.some((e) => e.title.includes('短信验证码') && e._via === 'hybrid'), 'hybrid 命中并标记 _via=hybrid');

    // 降级：嵌入服务宕机 → 自动退回 BM25，行为与未启用完全一致
    mockOllama.closeAllConnections?.();
    await new Promise((resolve) => mockOllama.close(resolve));
    await sleep(50);
    const fb = await bob.context.query({ q: '配色稿' });
    ok(fb.entries.length === 1 && fb.entries[0]._via === undefined, '嵌入服务宕机：自动退回 BM25（结果无 _via 标记）');
    const st2 = await alice.request('GET', '/embed/status');
    ok(st2.available === false && !!st2.lastError, '/embed/status 如实报告不可用与原因');

    // 备份完整性：/admin/export 包含向量 sidecar
    const exp = await alice.request('GET', '/admin/export');
    ok(Array.isArray(exp.vectors) && exp.vectors.length > 0, '/admin/export 包含向量数据');

    // /events type 过滤：消息页拉聊天历史用
    await alice.request('POST', '/messages', { body: { text: 'smoke 消息过滤测试', channel: 'smoke-chan' } });
    const filtered = await alice.request('GET', '/events?type=message.posted&after=0&limit=500');
    ok(filtered.events.length > 0 && filtered.events.every((ev) => ev.type === 'message.posted'), '/events type 过滤只返回指定类型');
  }
} finally {
  server.close();
  // close() 只停止接受新连接，keep-alive 长连接会让进程滞留到超时；
  // 测试结束必须显式断开，否则进程挂住不退出。
  server.closeAllConnections?.();
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch (err) {
    console.warn(`（临时目录清理失败，可手动删除：${TMP_ROOT}）`);
  }
}

console.log(`\n${'='.repeat(56)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log('Phase 1 最小 Hub 冒烟全绿 👑');
}
