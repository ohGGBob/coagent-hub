/**
 * SDK 实时通道：WebSocket 客户端（零第三方依赖，与 Hub 的 src/wire.js 对偶）。
 *
 * 行为约定（对应设计文档 §7「实时 + 异步安全网」）：
 *  - 连接即订阅：`types`/`taskId` 过滤器写在 URL 上，各 agent 只听自己关心的。
 *  - 断线自动重连：指数退避，重连时带 `since=lastSeq` 回放缺口，事件不丢不重。
 *  - 收到的每条事件都会更新句柄上的 `lastSeq`，调用方可持久化它做跨会话续传。
 *
 * @module sdk-ws
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { encodeFrame, createFrameParser, acceptKey } from '../wire.js';

const OPCODE = { TEXT: 0x1, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

/**
 * 建立 Hub 实时连接。
 *
 * @param {object} opts
 * @param {string} opts.hubUrl            如 http://127.0.0.1:8787
 * @param {string} opts.token
 * @param {string[]} [opts.types]         只订阅这些事件类型；缺省收全部
 * @param {string} [opts.taskId]          只听某任务相关的事件
 * @param {number} [opts.since]           从该 seq 起回放（缺省 0 = 全量）；重连时传 lastSeq
 * @param {(ev: object) => void} [opts.onEvent]  收到事件（含 hello 握手帧）
 * @param {(info: {userId: string, lastSeq: number}) => void} [opts.onOpen]
 * @param {(err: Error) => void} [opts.onError]
 * @param {() => void} [opts.onClose]
 * @param {boolean} [opts.reconnect=true] 断线自动重连
 * @returns {{lastSeq: number, send: (obj: object) => void, close: () => void}}
 */
export function connectHubWs({
  hubUrl,
  token,
  types,
  taskId,
  since = 0,
  onEvent,
  onOpen,
  onError,
  onClose,
  reconnect = true,
}) {
  const url = new URL(hubUrl.replace(/^http/, 'ws'));
  url.pathname = '/ws';
  url.searchParams.set('token', token);
  if (types?.length) url.searchParams.set('types', types.join(','));
  if (taskId) url.searchParams.set('taskId', taskId);

  /** @type {{lastSeq: number}} */
  const handle = { lastSeq: since, send: () => {}, close: () => {} };

  let socket = null;
  let closedByUser = false;
  let attempts = 0;
  let reconnectTimer = null;

  function connect() {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });

    req.on('upgrade', (res, sock, head) => {
      if (res.headers['sec-websocket-accept'] !== acceptKey(key)) {
        sock.destroy();
        onError?.(new Error('WebSocket 握手校验失败'));
        return scheduleReconnect();
      }
      socket = sock;
      attempts = 0;

      const send = (obj) => {
        if (sock.destroyed) return;
        sock.write(encodeFrame(OPCODE.TEXT, JSON.stringify(obj), { mask: true }));
      };
      handle.send = send;
      handle.close = close;

      const feed = createFrameParser(({ opcode, payload }) => {
        switch (opcode) {
          case OPCODE.TEXT: {
            let msg;
            try {
              msg = JSON.parse(payload.toString('utf8'));
            } catch {
              return;
            }
            if (msg.type === 'hello') {
              handle.lastSeq = msg.lastSeq ?? handle.lastSeq;
              onOpen?.({ userId: msg.userId, lastSeq: msg.lastSeq });
              return;
            }
            if (msg.type === 'error') return;
            if (typeof msg.seq === 'number') handle.lastSeq = Math.max(handle.lastSeq, msg.seq);
            onEvent?.(msg);
            return;
          }
          case OPCODE.PING:
            sock.write(encodeFrame(OPCODE.PONG, payload, { mask: true }));
            return;
          case OPCODE.CLOSE:
            sock.write(encodeFrame(OPCODE.CLOSE, payload, { mask: true }));
            sock.destroy();
            return;
          default:
            return;
        }
      });

      sock.on('data', feed);
      // 握手响应可能与首批帧数据合并在 head 里（TCP 合并写），必须喂给解析器
      if (head?.length) feed(head);
      sock.on('error', (err) => onError?.(err));
      sock.on('close', () => {
        socket = null;
        onClose?.();
        if (!closedByUser && reconnect) scheduleReconnect();
      });
    });

    req.on('response', (res) => {
      // 没升级成功（如 401/426）：按不可恢复错误处理，不再盲目重试
      onError?.(new Error(`WebSocket 升级被拒：HTTP ${res.statusCode}`));
      req.destroy();
    });
    req.on('error', (err) => {
      onError?.(err);
      if (!closedByUser && reconnect) scheduleReconnect();
    });

    req.end();
  }

  function scheduleReconnect() {
    if (closedByUser || !reconnect || reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** attempts, 30_000);
    attempts++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      // 重连时带 since 补缺口：实时为主、回放兜底
      url.searchParams.set('since', String(handle.lastSeq));
      connect();
    }, delay);
    reconnectTimer.unref?.();
  }

  function close() {
    closedByUser = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try {
      socket?.write(encodeFrame(OPCODE.CLOSE, '', { mask: true }));
      socket?.destroy();
    } catch {
      /* 忽略 */
    }
  }

  connect();
  return handle;
}
