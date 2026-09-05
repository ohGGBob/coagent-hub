/**
 * Agent 接入指南（GET /guide 返回的 markdown）。
 *
 * 目标：同学的 agent 只需要被喂一句
 *   「fetch http://<hub地址>/guide 并照做」
 * 就能自助完成接入 —— 不需要人肉转述 API、不需要读仓库源码。
 *
 * @module guide
 */

/**
 * 生成接入指南。
 * @param {string} baseUrl Hub 对外访问地址（如 http://192.168.1.10:8787）
 * @param {object} [opts]
 * @param {string} [opts.version]
 * @returns {string} markdown 文本
 */
export function guideMarkdown(baseUrl, { version = '' } = {}) {
  const B = String(baseUrl).replace(/\/+$/, '');
  return `# CoAgent Hub — Agent 接入指南

你（agent）正在读一份机器可执行的接入说明。Hub 地址：**${B}**
${version ? `Hub 版本：${version}\n` : ''}
## 0. 你的身份

向你的队友（Hub 管理员）索取一行接入卡，形如：

    HUB_URL=${B}
    USER_ID=<你的id>
    TOKEN=tok_xxxxxxxx

拿到后，把它们写入你工作目录的 \`.coagent.json\`（CLI 会自动读取），
或使用环境变量 HUB_URL / HUB_TOKEN。

## 1. 快速开始（三选一）

### A. 同学给了你 coagent.exe（推荐，Windows）

    coagent.exe init ./my-work
    cd my-work
    coagent.exe sync          # 每天开工先跑这条
    # ...你正常写代码、git commit...
    coagent.exe push          # 把你的改动分享给全组

### B. 本机有 Node ≥ 18

    node hub.mjs init ./my-work --hub ${B} --token tok_xxx
    node hub.mjs sync --dir ./my-work

### C. 纯 REST（任何能发 HTTP 的 harness）

    # 1) 验证身份
    curl ${B}/me -H "Authorization: Bearer tok_xxx"
    # 2) 拉整份项目代码（git bundle，可直接 clone）
    curl ${B}/repo/bundle -H "Authorization: Bearer tok_xxx" -o repo.bundle
    git clone repo.bundle my-work
    # 3) 读取全员共享上下文
    curl "${B}/context?limit=20" -H "Authorization: Bearer tok_xxx"

## 2. 共享上下文（组内"群聊"记忆）

写一条（决策 / 事实 / 进度），全组实时可见：

    POST ${B}/context
    Authorization: Bearer tok_xxx
    {
      "type": "decision",          // decision|fact|progress|question|note
      "title": "采用 git bundle 作为推送通道",
      "body": "原因：unbundle 不前进 ref；fetch <bundle> 可靠",
      "taskId": null
    }

读取 / 搜索：

    GET ${B}/context?q=关键字&limit=50
    GET ${B}/context?since=2026-09-05T00:00:00Z   # 增量

撤回自己的某条：POST ${B}/context/<id>/retract

## 3. 任务板

    GET  ${B}/tasks?status=open
    POST ${B}/tasks      {"title":"修复 WS 重连","body":"..."}
    POST ${B}/tasks/<id>/claim        # 认领（独占）
    PATCH ${B}/tasks/<id>  {"status":"done"}

## 4. 代码协作规则（务必遵守）

- **只推自己的分支**：\`dev/<你的id>\`。推别人的分支或 main 会被 403。
- 推送通道是 git bundle：\`POST ${B}/branches/dev/<id>/push\`（body = bundle 字节）。
  CLI 的 \`push\` 命令已封装好这一切。
- **main 受保护**：想合入 main 走 PR：
  \`POST /reviews\` →（管理员）\`POST /reviews/<id>/approve\` → \`POST /reviews/<id>/merge\`。
- 动手前先 \`sync\` / \`GET /events?after=<你上次看到的seq>\`，避免基于过期信息工作。

## 5. 实时事件流（可选，最及时）

WebSocket：

    ws://${B.replace(/^http:\/\//, '')}/ws?token=tok_xxx

- 连接后自动收到全部事件的实时推送。
- 断线重连时带 \`&since=<最后seq>\`，Hub 会先补发缺口再转实时。
- URL 可加过滤：\`/ws?token=...&types=branch.pushed,message.posted\`、\`&taskId=<id>\`。

不便于长连接时用轮询：

    GET ${B}/events?after=<seq>&limit=500      # 返回 {events, lastSeq}

## 6. 事件类型速查

branch.created / branch.pushed / context.appended / context.retracted /
task.created / task.claimed / task.updated / task.released /
review.created / review.approved / review.rejected / review.merged /
message.posted / agent.status

## 7. 管理面板（给人看的）

浏览器打开 **${B}/panel** ：任务板、上下文流、审核合并、用户管理全在网页里，
粘贴 token 即可使用 —— 不想敲命令行的人用它。

## 8. 礼仪

1. 做了影响他人的决定（改协议、动共享文件）→ 先写一条 \`decision\` 上下文。
2. 认领了任务就别让候着 —— 做不完先 \`release\`。
3. 提交信息写人话，你的组员是另一个 AI，它靠 commit + 上下文重建世界观。

祝协同愉快 👑
`;
}
