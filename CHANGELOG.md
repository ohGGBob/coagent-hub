# Changelog

所有重要变更记录在此文件。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.7.1] — 2026-09-06

### 修复
- **看板拖拽回归**：面板拖拽改走 `claim` / `release` 专用接口（上一版服务端已禁止 PATCH 携带 assignee，面板未同步导致移动任务卡报 400）
- **面板致命语法错误**：移除 `CTX_Q` / `CTX_TYPE` 的重复 `let` 声明（同作用域重复声明会使整个面板脚本失效）
- **登录收紧**：`POST /auth/login` 必须 userId + token 双匹配（此前只带 token 可命中任意账号）
- **bootstrap 限回环**：`GET /auth/bootstrap`（含种子管理员 token）仅允许本机 127.0.0.1 访问
- **任务删除权限**：仅创建者或 `admin:write` 可删任务（此前任何持 task:write 者可删任意任务）
- **WebSocket 鉴权**：WS 连接同样要求 `events:read` scope

### 安全加固
- **输入校验**：`tags` / `labels` 必须是字符串数组（此前传字符串会让 `/search` 对所有人 500）；`status` 限定 open/claimed/done 枚举；PATCH 直改 `claimed` 被拒（走 claim），`open` 归位时自动清空 assignee，释放他人认领的任务一律走 release+审核
- **长度上限**：任务 title 300 / description 100k、上下文 title 300 / body 100k、评论与群聊消息 10k、`agent.status` payload 8KB
- **WS 帧上限**：单帧超过 1MB 回 CLOSE(1009) 并断开，防止超长帧堆积内存、灌爆事件日志
- **常量时间 token 比较**：鉴权与登录改为先哈希再 `timingSafeEqual`，消除逐字节比较的时序侧信道
- **healthz 瘦身**：不再返回用户清单、不再执行 git 子进程，仅暴露 ok/version/lastSeq/uptimeSec（无鉴权端点最小暴露面）
- **Markdown 链接白名单**：面板 Markdown 渲染只放行 http(s)/mailto/相对路径，拦截 `javascript:` 伪协议；外链补 `rel="noopener noreferrer"`

### 变更
- 冒烟测试新增「输入校验与加固回归」一节（82 → 96 项断言）

## [0.7.0] — 2026-09-06

### 新增
- **在线用户状态**：WS 总线新增 `onlineUsers()` / `isOnline()`，`/stats` 暴露在线用户列表，面板顶栏实时显示在线人数
- **任务活动历史**：`GET /tasks/:id/activity` 返回任务相关全部事件，任务详情模态新增「描述/评论/活动」三标签页切换
- **桌面通知**：浏览器 Notification API，面板不可见时新事件自动弹出桌面通知（任务/上下文/PR/评论/推送/消息），设置页可开关
- **任务批量操作**：看板支持多选模式，批量完成/批量改优先级/批量删除
- **上下文修订**：`POST /context/:id/revise` 追加修订版本（不可变原则下通过 revision 标记更新），查询自动解析最新修订，面板支持一键修订
- **API 文档端点**：`GET /api` 返回全部路由列表（方法/路径/鉴权要求），无鉴权

### 变更
- 任务详情模态重构为三标签页（描述/评论/活动历史）
- 顶栏新增在线用户状态指示
- 冒烟测试 82 项全绿

## [0.6.0] — 2026-09-06

### 新增
- **文件附件系统**：
  - `POST /files` 原始二进制上传（X-Filename 指定文件名，单文件上限 50MB，`COAGENT_MAX_FILE_MB` 可配置）
  - `GET /files/:id` 下载（Content-Disposition + 正确 MIME）、`GET /files` 列表、`DELETE /files/:id` 删除
  - 文件存储在 `data/files/`，元数据在 `data/files.json`，新增 `src/files.js` 模块
- **上下文数据模型扩展**：
  - `attachments`：文件附件 ID 列表，上下文可挂载任意文件
  - `metadata`：任意键值对元数据、`source`：来源标识、`links`：关联 URL
  - `pinned`：置顶标记，`POST /context/:id/pin` 切换置顶，查询默认置顶优先
  - 查询默认返回上限 200 → 500
- **启动流程大幅简化**：
  - 端口冲突自动递增（8787→8788→…最多试 10 个），不再因端口被占而启动失败
  - 首次启动自动打开浏览器到面板页（`--no-browser` 可禁用）
  - 首次启动显示「快速开始」卡片，内含管理员账号和 token
  - 面板登录页通过 `/auth/bootstrap` 自动填充种子管理员 token，按 Enter 即登录
- **任务删除**：`DELETE /tasks/:id`，创建者可删；面板任务详情模态新增删除按钮
- **数据导出**：`GET /admin/export`（管理员），一键导出全部 JSON 数据为备份文件；面板设置页新增导出按钮
- **任务优先级过滤**：看板页新增优先级筛选下拉框
- **增强统计**：`/stats` 新增上下文总数/按类型分布、评论总数/按类型分布

### 性能优化
- **用户表内存缓存**：`loadUsers()` 带 mtime 失效，避免每次请求都读文件（鉴权热路径）
- **事件日志 ring buffer**：缓存最近 1000 条事件，`since()` 查询优先走内存，避免全量读文件
- **面板静态缓存**：`/panel` 返回 ETag + Cache-Control，支持 304 协商缓存

### 变更
- `serve.mjs` 和 `sea-entry.mjs` 统一端口回退逻辑和自动开浏览器行为
- 种子 token 警告仅在非首次启动时显示（首次启动改为正向引导）

### 技术
- 冒烟测试 82 项全绿
- 零运行时依赖原则不变

## [0.5.0] — 2026-09-06

### 新增
- **任务模型扩展**：priority（urgent/high/medium/low，带权重排序）、labels、dueDate、commentCount 字段；list() 支持 priority/label/q 过滤；stats() 返回按状态/优先级/负责人分布及逾期计数
- **评论系统**：任务评论 + PR 评论，软删除留痕，事件日志记录，触发任务评论计数自动增减
- **全局搜索** `GET /search`：任务 + 上下文跨域搜索，BM25 相关性排序
- **统计端点** `GET /stats`：任务统计 + 分支数 + 用户数 + WS 连接数 + 运行时长
- **速率限制**：按 IP 令牌桶（默认 600/min，`COAGENT_RATE_LIMIT` 可配置），定期清理过期桶
- **CLI 新命令**：`comment`（发评论）、`log`（事件历史）、`search`（全局搜索）、`diff`（分支 diff，支持 --full）
- **面板 v0.5 大幅升级**（54KB → 74KB）：
  - 命令面板（Ctrl+K）：全局搜索 + 快捷操作，键盘导航
  - 任务详情模态：Markdown 描述渲染 + 评论区 + 活动历史
  - 看板拖拽：HTML5 drag & drop，三列状态切换
  - SVG 图表：活动趋势柱状图（动画）+ 任务分布环形图
  - 轻量 Markdown 渲染器：标题/粗体/代码块/列表/引用/链接
  - 通知系统：未读计数 + 铃铛 + 最近事件面板
  - 键盘快捷键：N 新建任务、/ 搜索、Esc 关闭模态
  - 优先级/标签/截止日 UI：彩色 chip、逾期高亮
  - 骨架屏加载态、空状态插画、卡片悬浮动效

### 变更
- SDK client.js 新增 task.comments/addComment、review.comments/addComment、search()、stats() 方法；task.create 类型补充 priority/labels/dueDate
- tasks.js normalize() 兼容旧数据，incComment() 供评论模块回调
- config.js 新增 PATHS.comments

### 技术
- 面板 token 继续存 sessionStorage，WebSocket 实时 + 30s 兜底轮询
- 速率限制器内存中按 IP 维护令牌桶，每 60s 清理过期桶

## [0.4.0] — 2026-09-06

### 新增
- **全新 Web 管理面板**：从简陋表格页升级为现代化 SaaS 控制台
  - 侧边栏导航 + 顶部状态栏（实时连接指示、事件序号、主题切换）
  - 仪表盘首页：统计卡片 + 最近活动 + 快速操作 + 系统状态
  - 任务看板视图（待认领 / 进行中 / 已完成三列）
  - 共享上下文时间线（类型筛选、搜索、撤回）
  - 审核中心（PR 列表、批准/拒绝/合并）
  - 分支管理（分支列表、领先/落后统计、diff 弹窗）
  - 活动流（全系统事件时间线，按类型着色）
  - 用户管理（开户模态框、token 一次性展示）
  - 设置页（系统信息、接入地址、外观切换）
  - 深色/浅色主题切换，默认深色
  - WebSocket 实时更新 + 30s 兜底轮询
  - 响应式布局，适配窄屏
  - token 存 sessionStorage（关闭浏览器即清除，比 localStorage 更安全）
- **/metrics 端点**：Prometheus 文本格式，含请求数、状态码分桶、运行时长、WS 连接数、用户数、分支数、事件序号
- **结构化访问日志**：每行含方法/路径/状态码/耗时/字节数/User-Agent，可被 Loki/ELK 采集；可通过 `COAGENT_ACCESS_LOG=0` 关闭
- **优雅关闭**：SIGINT/SIGTERM 时先关闭 WS 连接、停止接受新请求、等待现有请求完成，5s 宽限期后强制退出
- **CORS 配置化**：默认 `*`，生产可通过 `COAGENT_CORS_ORIGIN` 限定具体源
- **CLI 彩色输出**：成功(绿)/错误(红)/警告(黄)/信息(青)，支持 `NO_COLOR` 环境变量和非 TTY 自动降级
- **版本号统一管理**：从 package.json 读取，源码运行和 SEA 打包均自动注入，不再手动同步

### 变更
- 面板 token 存储从 localStorage 改为 sessionStorage
- 启动横幅使用彩色输出
- CLI `status` 输出重新排版，使用分隔线和彩色状态标签
- CLI `adduser` 接入卡片使用彩色高亮关键信息

### 技术
- 服务端新增 `close()` 方法和 `metrics` 对象，供外部调用
- esbuild 构建时注入 `COAGENT_VERSION` 环境变量

## [0.3.0] — 2026-09-05

### 新增
- Phase 2 实时总线（零依赖手写 RFC 6455 WebSocket）
- CLI `watch` 命令（定时轮询 + `--live` 实时混合模式）
- Web 管理面板（基础版：任务/上下文/审核/用户四个 tab）
- Agent 自助接入指南 `/guide`
- 单文件 exe 打包（Node SEA + esbuild + postject）
- 整仓读通道（`/repo/info`、`/repo/bundle`）

### 修复
- 间歇性 ECONNRESET：根因是 Node 默认 keepAliveTimeout=5s，修复为 120s

## [0.2.0] — 2026-09-05

### 新增
- 事件日志（JSONL 追加式，seq 单调，断线回放，半行修复）
- 共享上下文（BM25 检索，仅作者可写，撤回留痕）
- 任务板（认领/释放，释放他人任务需审核）
- 代码仓（裸仓 + bundle 推送，分支权限硬校验）
- 审核闸门（PR → 批准 → 快进合并）
- 用户管理（开户/轮换/注销，scope 权限）
- Agent SDK（REST + WebSocket 客户端）
- Agent CLI（init/pull/push/status/sync/note/task/claim/whoami）
- 端到端冒烟测试（75+ 项断言）

## [0.1.0] — 2026-09-04

### 新增
- 项目设计文档与架构定义
- 三层架构：代码事实源 / 共享上下文层 / 协作总线
- 数据模型与事件 Schema 定义
- SDK 接入协议定义
