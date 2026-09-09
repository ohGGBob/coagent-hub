/**
 * Hub 实时总线（Phase 2 提前落地）。
 *
 * 设计要点（对应设计文档 §2 / §7）：
 *  - 实时是「通知」，不是「授权」：推给客户端的只是事件，敏感动作仍需走 REST 审核。
 *  - 连接参数即订阅过滤器：`?types=a,b&taskId=x&since=N`——不同任务可以只听自己关心的。
 *  - `since` 支持重连补发：先回放历史，再无缝接上实时流；断线期间的事件不会丢。
 *  - 心跳保活 + 死连接清理，防止半开连接堆积。
 *
 * @module ws
 */

import { acceptKey, encodeFrame, createFrameParser } from './wire.js';

const OPCODE = { TEXT: 0x1, CLOSE: 0x8, PING: 0x9, PONG: 0xa };
const HEARTBEAT_MS = 25_000;
const DEAD_AFTER_MS = 60_000;
/** 单帧上限（agent 上行的都是小 JSON，1MB 已远超需要） */
const MAX_FRAME_SIZE = 1024 * 1024;
/** agent.status payload 的字节上限（会原样落进事件日志） */
const MAX_STATUS_PAYLOAD = 8192;
/** agent.status 频率限制：单连接每窗口最多上报条数 */
const STATUS_MAX_PER_WINDOW = 30;
const STATUS_WINDOW_MS = 60_000;

/**
 * 把 WebSocket 总线挂到 HTTP 服务上（处理 Upgrade 请求）。
 *
 * 连接地址：`ws://host:port/ws?token=<token>&types=t1,t2&taskId=<id>&since=<seq>`
 *
 * 客户端可发送的 JSON 消息：
 *  - `{"type":"ping"}`                       → 回 `{"type":"pong"}`
 *  - `{"type":"agent.status","payload":{}}`  → 落盘为 agent.status 事件并广播
 *
 * @param {import('node:http').Server} server
 * @param {{verify: (header: string|undefined) => {id: string, scopes: string[]}, requireScope?: (user: any, scope: string) => void, eventLog: any}} deps
 */
export function attachWebSocket(server, { verify, requireScope, eventLog }) {
  /** @type {Set<object>} */
  const connections = new Set();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      return socket.destroy();
    }

    let user;
    try {
      user = verify(url.searchParams.get('token') ? `Bearer ${url.searchParams.get('token')}` : undefined);
      if (requireScope) requireScope(user, 'events:read');
      else if (!user.scopes?.includes('events:read')) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        return socket.destroy();
      }
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }

    const key = req.headers['sec-websocket-key'];
    if (!key || (req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      return socket.destroy();
    }

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    socket.setNoDelay(true);

    // ---- 订阅过滤器 ----
    const types = url.searchParams.get('types')
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ?? null;
    const taskId = url.searchParams.get('taskId') ?? null;

    /** @param {{type: string, payload: object}} ev */
    const matches = (ev) => {
      if (types && !types.includes(ev.type)) return false;
      if (taskId) {
        const inPayload = ev.payload?.taskId === taskId || ev.payload?.id === taskId;
        if (!inPayload) return false;
      }
      return true;
    };

    const conn = { socket, user, filter: { types, taskId }, alive: Date.now() };
    connections.add(conn);

    // 本连接 agent.status 上报的令牌桶窗口
    let statusCount = 0;
    let statusWindowStart = Date.now();

    const send = (opcode, payload) => {
      if (socket.destroyed) return;
      socket.write(encodeFrame(opcode, payload));
    };
    const sendJson = (obj) => send(OPCODE.TEXT, JSON.stringify(obj));

    // ---- 先回放历史（since），再接实时流：两段之间同步执行，无缝隙 ----
    const since = Number(url.searchParams.get('since') ?? 0);
    if (Number.isInteger(since) && since >= 0) {
      for (const ev of eventLog.since(since, 10_000)) {
        if (matches(ev)) sendJson(ev);
      }
    }
    sendJson({ type: 'hello', userId: user.id, filter: conn.filter, lastSeq: eventLog.lastSeq });

    const unsubscribe = eventLog.subscribe((ev) => {
      if (matches(ev)) sendJson(ev);
    });

    const feed = createFrameParser(({ opcode, payload, error }) => {
      if (error) {
        // 超长帧：回 CLOSE(1009 Message Too Big) 后断开，防止内存堆积
        send(OPCODE.CLOSE, 'frame too big');
        return socket.destroy();
      }
      conn.alive = Date.now();
      switch (opcode) {
        case OPCODE.TEXT: {
          let msg;
          try {
            msg = JSON.parse(payload.toString('utf8'));
          } catch {
            return sendJson({ type: 'error', message: '消息必须是 JSON' });
          }
          if (msg.type === 'ping') return sendJson({ type: 'pong', ts: msg.ts ?? null });
          if (msg.type === 'agent.status') {
            // payload 落盘进事件日志，必须限额防止日志被灌爆
            const payload = msg.payload ?? {};
            if (JSON.stringify(payload).length > MAX_STATUS_PAYLOAD) {
              return sendJson({ type: 'error', message: `agent.status payload 过大（上限 ${MAX_STATUS_PAYLOAD} 字节）` });
            }
            // 频率限制：events:read 是默认 scope，不限流的话任何人都能
            // 无限追加事件（同步落盘 + 向全体广播），把日志和带宽一起拖垮。
            const now = Date.now();
            if (now - statusWindowStart > STATUS_WINDOW_MS) {
              statusWindowStart = now;
              statusCount = 0;
            }
            if (statusCount >= STATUS_MAX_PER_WINDOW) {
              return sendJson({
                type: 'error',
                message: `agent.status 过于频繁（每 ${STATUS_WINDOW_MS / 1000} 秒最多 ${STATUS_MAX_PER_WINDOW} 条）`,
              });
            }
            statusCount++;
            const ev = eventLog.append({ type: 'agent.status', authorId: user.id, payload });
            return sendJson(ev);
          }
          return sendJson({ type: 'error', message: `未知消息类型：${msg.type}` });
        }
        case OPCODE.PING:
          return send(OPCODE.PONG, payload);
        case OPCODE.PONG:
          conn.alive = Date.now();
          return;
        case OPCODE.CLOSE:
          send(OPCODE.CLOSE, payload);
          return socket.destroy();
        default:
          return; // binary 等暂不处理
      }
    });

    socket.on('data', feed);
    // 客户端升级后立刻发的帧可能合并在 head 里，必须喂给解析器
    if (head?.length) feed(head);
    socket.on('error', () => cleanup());

    const heartbeat = setInterval(() => {
      if (Date.now() - conn.alive > DEAD_AFTER_MS) {
        send(OPCODE.CLOSE, 'heartbeat timeout');
        socket.destroy();
        return;
      }
      send(OPCODE.PING, 'hb');
    }, HEARTBEAT_MS);
    heartbeat.unref();

    function cleanup() {
      clearInterval(heartbeat);
      unsubscribe();
      connections.delete(conn);
    }
    socket.on('close', cleanup);
  });

  return {
    /** 当前在线连接数（监控用） */
    get count() {
      return connections.size;
    },
    /** 当前在线用户 ID 列表（去重） */
    onlineUsers() {
      return [...new Set([...connections].map((c) => c.user.id))];
    },
    /** 检查某用户是否在线 */
    isOnline(userId) {
      return [...connections].some((c) => c.user.id === userId);
    },
    connections,
  };
}
