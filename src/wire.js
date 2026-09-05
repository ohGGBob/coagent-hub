/**
 * WebSocket 帧编解码（RFC 6455 最小实现，零第三方依赖）。
 *
 * 服务端与 SDK 客户端共用：客户端发出的帧必须掩码，服务端发出的帧不掩码，
 * 由调用方通过 `mask` 选项控制；解析器对两种帧都能处理。
 *
 * 只实现本 Hub 用得到的子集：text/binary/ping/pong/close，不分片重组
 * （我们的消息都是小 JSON，单帧足够）。
 *
 * @module wire
 */

import crypto from 'node:crypto';

/** WebSocket 握手 GUID（RFC 6455 固定值） */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** @param {string} key 客户端的 Sec-WebSocket-Key */
export function acceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

/** 随机掩码密钥 */
const newMask = () => crypto.randomBytes(4);

/**
 * 编码一帧。
 * @param {number} opcode 0x1 text | 0x2 binary | 0x8 close | 0x9 ping | 0xA pong
 * @param {Buffer|string} payload
 * @param {{mask?: boolean}} [opts] 客户端→服务端必须 mask:true
 * @returns {Buffer}
 */
export function encodeFrame(opcode, payload, opts = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = opts.mask ? newMask() : null;
  const maskLen = mask ? 4 : 0;

  /** @type {Buffer} */
  let header;
  const len = body.length;
  if (len < 126) {
    header = Buffer.alloc(2 + maskLen);
    header[0] = 0x80 | opcode;
    header[1] = mask ? 0x80 | len : len;
  } else if (len < 65536) {
    header = Buffer.alloc(4 + maskLen);
    header[0] = 0x80 | opcode;
    header[1] = mask ? 0x80 | 126 : 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10 + maskLen);
    header[0] = 0x80 | opcode;
    header[1] = mask ? 0x80 | 127 : 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  if (!mask) return Buffer.concat([header, body]);

  header.set(mask, header.length - maskLen);
  const masked = Buffer.from(body); // 拷贝后再掩码，不动调用方的缓冲区
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, masked]);
}

/**
 * 创建流式帧解析器。把 socket 的 data 块依次喂进来，每解析出完整帧回调一次。
 * @param {(frame: {fin: boolean, opcode: number, payload: Buffer}) => void} onFrame
 * @returns {(chunk: Buffer) => void}
 */
export function createFrameParser(onFrame) {
  let buf = Buffer.alloc(0);

  return function feed(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;

    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }

      /** @type {Buffer|null} */
      let maskKey = null;
      if (masked) {
        if (buf.length < offset + 4) return;
        maskKey = buf.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buf.length < offset + len) return;

      let payload = buf.subarray(offset, offset + len);
      if (maskKey) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
      }
      buf = buf.subarray(offset + len);
      onFrame({ fin, opcode, payload });
    }
  };
}
