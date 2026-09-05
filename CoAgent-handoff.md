# CoAgent — 多 Agent 协同开发中枢（新对话交接文档）

> 用途：把项目背景、已确认决策、设计要点浓缩到一份自包含文档，可直接粘贴进新对话继续。
> 版本：v1（2026-09-04，由琉璃起草）

## 1. 项目目标
让多个开发者各自用**本地 agent** 协同开发同一项目：共享上下文、不必互传文件夹、加快协同。
类比"AI 自建群聊"：所有 agent 看到相同上下文，像开群聊一样分配 / 同步任务。

## 2. 已确认的三项关键决策（必须遵循）
| 维度 | 决策 |
|------|------|
| 承载方式 | **自建中枢服务 Hub**（不依赖 GitHub/Discord 拼装，Hub 为唯一事实源） |
| 协作节奏 | **异步轮询为主**：agent 定期 `hub.sync()` 拉增量事件（5~10s），实时 WS 推迟到 Phase 2+ |
| 写入模型 | **只读共享上下文 + 私有分支**：他人可读不能改你的代码；合 main 走 PR/审核 |

### 2.1 v2 修订（2026-09-04 晚，与尤利乌斯确认的真实场景）
> **真实场景**：尤利乌斯和同学们各用**不同的电脑**跑本地 agent 共同开发一个项目；
> 痛点是传文件夹乱、GitHub 式"下载到本地"丢失上下文。

| 维度 | 修订后决策 | 说明 |
|------|-----------|------|
| 部署形态 | **多机**：一台电脑当主机跑 Hub，其余经网络连入 | 同 WiFi/校园网直连主机 IP；跨网络用 **Tailscale** 组虚拟局域网（免费、免公网 IP） |
| Git 读写 | **读写全走 HTTP** | 远端 agent 无法直连本地路径：push 走 bundle 上传接口，clone/fetch 走 Hub 的 bundle 下载端点；本机路径直连仅主机可用 |
| 用户管理 | **提供用户管理 API** | `POST /users` 注册、轮换 token 等管理端点（管理员 scope），不做手改文件 |
| 上下文检索 | **Phase 1 关键词过滤**；embedding 字段与检索接口签名**现在定好** | Phase 3 接本地语义模型（bge-small/nomic-embed）时不动 API |
| 实时性 | **轮询可接受** | WS 保持 Phase 2，但事件订阅点（eventlog.subscribe）已就绪 |

## 3. 总体架构（三层解耦）
1. **代码事实源**：Hub 托管 git，每人一条私有分支 `dev/<userId>`；main 受保护，仅经 PR 合并。
2. **共享上下文层**：追加式事件日志 + 向量索引（RAG）。agent 开工前按"任务 / 分支 / 时间"拉取相关片段。
3. **协作总线**：实时 WebSocket 广播 + 异步事件日志回放。结构化群聊（更新 / 认领 / 求审 / 交接）。

Hub 内部模块：Auth&分支权限 / Git 编排器 / 上下文存储 / 实时协作总线 / 任务协调板 / Agent SDK 协议层。

## 4. 核心数据模型（要点）
- **Identity**：人类用户；每用户可有 1+ agent，凭证绑定 userId，带 scope。
- **Branch**：私有分支 `dev/<userId>`，仅本人可 push；main protected。
- **ContextEntry**：一条共享上下文（decision / progress / blocker / note / summary）。**所有人可读，仅作者可写** → 即"只读共享上下文"。字段：authorId / branchId? / taskId? / type / title / body / tags / embedding? / createdAt。
- **Event**：事件日志中的不可变记录，**全系统真相源**。字段：seq(单调递增) / id / type / payload / authorId / ts。
- **Task**：协调板任务卡，可认领、关联分支与上下文。
- **PullRequest**：私有分支合 main 的审核闸门。

## 5. 事件 Schema（EventType）
通用字段：`seq, id, type, authorId, ts`。
类型：`context.appended` / `task.created` / `task.claimed` / `task.updated` / `task.released` / `branch.pushed` / `branch.merged` / `review.requested` / `review.approved` / `message.posted` / `agent.status`。
原则：**所有事件先落盘事件日志，再广播**；离线者用 `GET /events?after=<seq>` 回放。

## 6. Agent SDK 协议（接入契约）
本地 agent 通过 SDK 接入 Hub，两套通道：
- **REST**（异步主路径）：`/auth/login`、`/context`(GET/POST)、`/tasks`(GET/POST/PATCH/`claim`)、`/branches`(GET/POST/`diff`)、`/reviews`(POST/`approve`)、`/events?after=seq`(回放)。
- **WebSocket**（实时）：`ws://hub/ws?token=`；客户端发 `bus.publish / context.append / task.update`，服务端落盘后广播；离线重连用 events 回放。
- 给 agent 的工具：`hub.sync()` / `hub.context.query()` / `hub.context.append()` / `hub.bus.send|subscribe()` / `hub.task.claim|update|release()` / `hub.review.request|approve()`。

## 7. 实时 / 异步一致性
事件日志为唯一真相源，seq 单调。实时 WS 顺序投递；离线 / 新会话重连用 `GET /events?after=lastSeq` 补齐。**实时 ≠ 自动触发他人动作**：改代码 / 合 main / 释放他人任务等敏感操作必须人工 / 审核确认。

## 8. 权限模型
- 上下文：可读全部，仅可写自己的。
- 分支：仅可向自己 `dev/<userId>` push；main 经 PR + reviewer 合入。
- 总线：可发布到共享 channel；建议按 task 命名空间隔离。

## 9. 风险与开放问题
1. 上下文相关性：RAG 召回质量决定"共享上下文"是否真有用，须按分支 / 任务 / 时间过滤。
2. 本地隐私边界：本地 agent 看到的密钥 / 环境配置不能无故上传；仅显式 `context.append` 的内容才上传。
3. 实时安全：某 agent 出错不得自动触发他人动作。
4. 合并冲突：私有分支再多，合 main 仍可能冲突，PR 闸门兜底但需定义冲突 UX。
5. 离线分歧：本地离线提交后 sync 需 rebase / merge 到私有分支最新 HEAD。

## 10. 路线图
- Phase 0 定义协议（✅ 已完成：数据模型 / 事件 schema / SDK 协议）
- Phase 1 最小 Hub：git 私有分支 + 事件日志(JSONL) + 任务板 + 异步拉取
- Phase 2 实时总线(WebSocket) + 离线回放
- Phase 3 RAG 向量检索 + 上下文策展 UI
- Phase 4 PR / review 闸门 + 权限细化

## 11. 技术选型建议（实现层）
- 后端：Node + TypeScript（Fastify）优先。
- Git：服务端裸仓；`simple-git` / `libgit2`；私有分支 `dev/<userId>`。
- 上下文 Phase 1：文件系统 + JSONL 事件日志；Phase 3 升级 Postgres + pgvector。
- 实时：WebSocket（`ws` / Socket.IO）。
- 嵌入：隐私优先本地模型（bge-small / nomic-embed）。
- 鉴权：token + scope 校验。

## 12. 当前进度与下一步
- 设计阶段完成（v1）：三层架构、数据模型、事件 schema、SDK 协议、权限、路线图、风险均已定义；v2 修订见 §2.1。
- **Phase 1 骨架已落地且冒烟全绿**（2026-09-05，63/63 断言通过，多轮稳定）：零依赖 Node ESM 实现，位于 `src/`：
  `config / errors / eventlog(JSONL+订阅挂点) / jsonfile / auth(含用户管理) / context / tasks / reviews / git-repo(裸仓+bundle) / server(REST)`，
  SDK 在 `src/sdk/client.js`（含 repo 整仓读通道与 users 管理），端到端冒烟 `scripts/smoke.js`（`npm run smoke`），
  agent 命令行工具 `scripts/hub.mjs`（`npm run hub -- init/pull/push/status/sync/whoami`，支持内嵌调用），部署/接入文档 `README.md`。
- **整仓读通道已补齐**：`GET /repo/info`（分支+sha）、`GET /repo/bundle`（整仓快照，可直接 git clone）——跨机场景 agent 拿不到主机路径，这是代码读的唯一入口；CLI 的 `init/pull` 建立在其上。
- **推送通道定稿**：`git fetch <bundle> ref:ref` 取代 unbundle（尤利乌斯修正）——真正推进目标 ref 且天然拒绝非快进。
- **间歇性 ECONNRESET 已根治**：根因是 Node 服务端默认 keepAliveTimeout=5s，在 git 子进程同步执行造成的请求空档期掐掉闲置连接，客户端复用即被 RST。修复：`server.keepAliveTimeout=120s`（headersTimeout 相应加大）。
- 已验证：鉴权、任务认领冲突、分支权限拦截、上下文只读共享+作者撤回、事件回放与增量游标、PR 审核+快进合并、强制释放他人任务需 approved 审核、用户管理 API（开户/轮换/注销）、**CLI 全流程**（init 带远端已有分支状态切分支，避免非快进拒绝；push；pull；status）。
- **多机就绪**：服务监听所有网卡，启动时打印局域网接入地址；跨网络走 Tailscale（README 有步骤）。
- **待办（Phase 1 收尾）**：
  1. 拉同学的 agent 真实联测：同 WiFi 直连 + Tailscale 各验一轮（防火墙放行端口）。
  2. 主机部署为常驻服务（pm2 / 计划任务）由使用者自选。
- 下一步建议：先做多机实测，再决定 Phase 2（WS 实时总线）或 Phase 3（语义检索）优先级。
- 典型协作时序：agent 拉上下文 → 认领任务 → 本地实现 → bundle 推私有分支 + 发上下文/进度事件 → 他人 sync 同步 → PR 合 main（审核闸门）。

> 注：本对话曾建立过 `D:\CoAgent` 工程（含完整设计规格 `design/agent-collab-hub-design.md` 与 README）。本 md 已自包含上述要点；若需完整规格，原工程文件已归档可恢复。
