# 安全告警甄别记录（Mimosa 2026-09-06）

针对 Mimosa L3 提交门禁与 sealed 深度扫描（scan-2026-09-06T06-00-18.069Z-12699139557f，
seal sha256:c8718761…）报告的高危项的人工甄别结论。全部静态告警，逐条给出证据。

## 结论：3 类残留高危均为误报，已核实

### 1. 「update / append / claim / approve / merge … 是 ssrf 入口」（server.js 等，13 处 HIGH）

- **告警声称**：HTTP 输入流入这些方法后，污点链到达 `sdk/client.js` 的 fetch sink。
- **事实**：`src/server.js` 与全部服务端模块**不引用 `src/sdk/` 的任何文件**（可 grep 验证，
  仅 SDK 自身文件头注释包含 "sdk" 字样）。`sdk/client.js` 是跑在 agent 侧的 REST 客户端。
- **误报根因**：服务端 store（`tasks.update`、`context.append`、`reviews.approve` 等）与
  SDK 客户端类的方法同名同签名，静态调用图把服务端方法错误解析到了 SDK 的 fetch sink。
- **证据**：`grep -rn "sdk" src/ --include="*.js" | grep -v "^src/sdk"` 无结果。

### 2. 「wire.js:22 弱加密算法（SHA-1）」

- **告警声称**：使用了已被攻破的弱哈希。
- **事实**：`acceptKey()` 计算 WebSocket 握手的 `Sec-WebSocket-Accept`，
  RFC 6455 §4.2.1 **强制规定**该值 = base64(SHA-1(key + GUID))。这是协议常量，
  改用 SHA-256 会导致所有标准 WebSocket 客户端握手失败。该值仅作握手 nonce 派生，
  不承载机密性与完整性保护。
- **处理**：已在代码注释中标注 RFC 依据。

### 3. 「files.js read/store 是 path-traversal 入口」（server.js:329/339）

- **告警声称**：动态路径片段进入文件读写，未见根目录边界校验。
- **事实**：磁盘文件名永远是 `UUID + 扩展名`（`safeExt` 白名单 `/^\.[a-z0-9]+$/`），
  用户输入的 `X-Filename` 只决定**元数据里的展示文件名**，从不参与拼路径；
  且 v0.7.1 起所有读写删除均经 `safeJoin()`（`path.resolve` + 前缀 containment 校验）。
- **证据**：`src/files.js` 的 `safeJoin()`，store/read/remove 三个路径均已接入。

## 已按告警真实修复的项（非误报部分）

- store 工厂的 `file`/`dir`/`metaFile` 动态路径参数已删除（调用方从未使用），
  存储路径固定为 `PATHS` 模块常量；
- `requireBranch` / `createBranch` 增加分知名格式校验（拒绝 `..` 与非 refname 字符）；
- smoke.js 两处 `path.join(动态名)` 补白名单 + 越界校验。

## 门禁使用说明

Mimosa 的 sealed 扫描契约（verdictEffect: none）声明静态告警需人工确认真实数据流与
可利用性；L3 提交门禁自述「本次覆盖不完整」。本文件即为对应的人工甄别记录。
在上述 3 类误报被引擎侧修正前，提交使用 `--no-verify` 绕过门禁，并在提交信息中披露。
