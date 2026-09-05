# CoAgent Hub — 多 Agent 协同开发中枢

让多个人**各用自己的本地 AI agent**，在**各自不同的电脑**上协同开发同一个项目：
共享上下文、不用互传文件夹、进度互相可见。

## 快速开始（单机试玩）

```bash
npm start          # Hub 监听 http://localhost:8787
npm run smoke      # 端到端冒烟测试（63 项断言）
```

首次启动自动生成 `data/`：`users.json`（种子账号 alice/bob）、`repo.git`（托管裸仓）、
`events.jsonl`（事件日志）等。种子 token 见 `data/users.json`。

## 多人协同部署（真实场景）

**1. 选一台电脑当主机**（建议项目发起人的），启动：

```bash
npm start
# 监听 http://0.0.0.0:8787，打印本机地址
```

**2. 同学们的 agent 连过来**：

- **同一个 WiFi / 校园网**：直接用主机内网 IP，如 `http://192.168.1.10:8787`
  （Windows 查 IP：`ipconfig`；注意防火墙放行 8787 端口）
- **不在同一网络**：全员安装 [Tailscale](https://tailscale.com)（免费），
  每人获得一个 `100.x.x.x` 虚拟 IP，之后照样 `http://100.x.x.x:8787` 直连

**3. 开户**（任何持 `admin:write` 凭证的人执行）：

```js
import { HubClient } from './src/sdk/client.js';
const admin = new HubClient({ hubUrl: 'http://100.x.x.x:8787', token: '<管理员token>' });
const { user } = await admin.users.create({ id: 'carol', name: 'Carol' });
// user.token 只出现这一次，发给同学本人保存
```

不传 `scopes` 的新用户默认只有普通 agent 权限（**不含** `admin:write`）；
要开管理员需显式传入完整 scope 清单（见 `src/auth.js` 的 `SCOPES`）。

## Agent 接入五步曲

最快路径：用自带的 CLI（`npm run hub -- <命令>`），一条命令开工：

```bash
# 首次开工：把整个项目拉到本地，自动建好你的私有分支
npm run hub -- init ./my-work --hub http://100.x.x.x:8787 --token tok_xxx

# 每天开工前：拉全员进度 + 看任务板
npm run hub -- sync --dir ./my-work

# 干完活：推送自己的改动
npm run hub -- push --dir ./my-work
```

CLI 会在工作目录写 `.coagent.json`（保存 Hub 地址与 token，**别提交或外发**）。

等价的 SDK 用法（agent 更适合直接用 SDK）：

```js
const hub = new HubClient({ hubUrl, token });

// 1. 开工前：同步错过的事件 + 拉相关上下文
const missed = await hub.sync();                       // 流水账增量回放
const notes  = await hub.context.query({ taskId });    // 共享笔记墙

// 2. 领任务
await hub.task.claim(taskId);

// 3. 本地实现，git 提交后打包推送（自己的私有分支）
const bundle = exec('git bundle create push.bundle dev/<userId>');
await hub.branch.push(`dev/${userId}`, bundle);

// 4. 贴进度笔记，让别人看得见
await hub.context.append({ type: 'progress', title: '事件日志完成', taskId });

// 5. 求审 → 他人批准 → 合入 main
const { review } = await hub.review.request({ branch: `dev/${userId}` });
// ……另一位同学：await reviewer.review.approve(review.id);
await hub.review.merge(review.id);
```

## 安全模型（一页纸）

| 资源 | 读 | 写 |
|------|----|----|
| 共享上下文 | 所有人 | 仅作者（撤回=软删除，留痕） |
| 任务 | 所有人 | 持有者/创建者；**释放他人任务须出示 approved 审核** |
| 代码分支 | 所有人可 fetch | 仅自己的 `dev/<userId>`；**main 受保护**，PR 批准 + 可快进才可合 |
| 事件日志 | 所有人 | 无人可改（追加式，唯一真相源） |
| 用户管理 | — | 仅 `admin:write`；token 只在创建/轮换响应出现一次 |

代码写通道：`git bundle` 打包 → `POST /branches/:name/push` → Hub 校验归属 →
`git fetch <bundle> ref:ref` 落入裸仓（天然拒绝非快进）。读通道：直接
`git fetch <主机>/data/repo.git`（同机）或经 Hub 的 bundle 下载端点（跨机）。

## REST 端点速查

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/auth/login` | 校验 userId+token |
| GET | `/events?after=<seq>` | 事件回放（离线补齐唯一口） |
| GET/POST | `/context` | 共享上下文查询 / 追加 |
| POST | `/context/:id/retract` | 作者撤回 |
| GET/POST | `/tasks`，POST `/tasks/:id/claim`·`release`，PATCH `/tasks/:id` | 任务板 |
| GET/POST | `/branches`，POST `/branches/:name/push`，GET `/branches/:name/diff`·`bundle` | 分支 |
| GET | `/repo/info`，`/repo/bundle` | 整仓读通道（跨机 clone / fetch 的唯一入口） |
| GET/POST | `/reviews`，POST `/reviews/:id/approve`·`reject`·`merge` | 审核闸门 |
| GET/POST/DELETE | `/users`，POST `/users/:id/rotate` | 用户管理（admin:write） |
| POST | `/messages` | 结构化群聊消息 |
| GET | `/healthz`，`/me` | 健康 / 身份 |
| GET | `/ws` | Phase 2 实时总线挂点（501） |

## 技术要点与已知限制

- **零第三方依赖**：Node ≥18 ESM + 系统 git（子进程）。
- **单进程假设**：事件 seq 与任务板状态在单进程内保证一致；多进程部署需引入文件锁/数据库（Phase 3）。
- **检索**：Phase 1 为关键词/标签/时间过滤；`ContextEntry.embedding` 字段与接口签名已预留，Phase 3 接本地语义模型。
- **主机离线 = 全员离线**：这是自建中枢的固有代价；Tailscale + 一台常开的机器可缓解。
