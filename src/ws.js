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
 * @param {{verify: (header: string|undefined) => {id: string}, eventLog: any}} deps
 */
export function attachWebSocket(server, { verify, eventLog }) {
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

    const feed = createFrameParser(({ opcode, payload }) => {
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
            const ev = eventLog.append({ type: 'agent.status', authorId: user.id, payload: msg.payload ?? {} });
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
