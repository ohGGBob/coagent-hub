/**
 * 应用图标生成器 —— 纯 Node 绘制，零依赖。
 *
 * 设计：微信绿渐变圆角方块 + 白色对话气泡 + 气泡内皇冠（CoAgent 品牌元素 👑）。
 * 产出：
 *   dist/icon.ico        Windows exe 图标（256/64/48/32/16，PNG 内嵌格式）
 *   dist/icon.icns       macOS .app 图标（512/256/128）
 *   dist/icon-512.png    通用 PNG
 *   src/assets/icon.svg  网页 favicon 源（内嵌到 panel/launcher）
 *
 * 绘制方式：2× 超采样光栅化（1024²）→ 盒式降采样到 512，各形状用 SDF/点在多边形内判定。
 * @module gen-icon
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = path.join(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '..', 'dist');
const S = 2;                     // 超采样倍数
const SIZE = 512;
const W = SIZE * S;

/* ---------- 形状判定（逻辑坐标 512，按 S 缩放） ---------- */
const px = (v) => v * S;

/** 圆角矩形判定：把点clamp到内核区后做圆判定（标准 SDF 简化） */
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r;
}

/** 点是否在多边形内（射线法） */
function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const BUBBLE = { x0: 96, y0: 112, x1: 416, y1: 356, r: 52 };
const BUBBLE_TAIL = [[168, 332], [128, 424], [246, 348]];      // 左下尾巴
const CROWN = [[186, 316], [198, 208], [250, 262], [276, 198], [302, 262], [354, 208], [366, 316]];
const CROWN_BAR = { x0: 186, y0: 316, x1: 366, y1: 340, r: 8 }; // 皇冠底座

/** 逻辑坐标 → 颜色（含背景/气泡/皇冠三层） */
function shade(lx, ly) {
  // 背景：圆角方块 + 垂直渐变
  const bgHit = inRoundRect(lx, ly, 0, 0, 512, 512, 118) < 0;
  if (!bgHit) return null; // 透明（圆角外）
  const t = Math.min(1, Math.max(0, ly / 512));
  let r = Math.round(0x2b + (0x05 - 0x2b) * t);
  let g = Math.round(0xd8 + (0x9f - 0xd8) * t);
  let b = Math.round(0x6a + (0x4c - 0x6a) * t);
  // 白色气泡（圆角矩形 + 尾巴）
  const bubble = inRoundRect(lx, ly, BUBBLE.x0, BUBBLE.y0, BUBBLE.x1, BUBBLE.y1, BUBBLE.r) < 0 || inPoly(lx, ly, BUBBLE_TAIL);
  if (bubble) {
    // 气泡内皇冠（微信绿）
    if (inPoly(lx, ly, CROWN) || inRoundRect(lx, ly, CROWN_BAR.x0, CROWN_BAR.y0, CROWN_BAR.x1, CROWN_BAR.y1, CROWN_BAR.r) < 0) {
      r = 0x07; g = 0xc1; b = 0x60;
    } else {
      r = g = b = 0xff;
    }
  }
  return [r, g, b, 255];
}

/* ---------- 光栅化（超采样） + 降采样 ---------- */
const raw = Buffer.alloc(W * W * 4);
for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    const c = shade(x / S, y / S);
    const o = (y * W + x) * 4;
    if (c) { raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]; raw[o + 3] = c[3]; }
  }
}
function downsample(buf, from, to) {
  const f = from / to;
  const out = Buffer.alloc(to * to * 4);
  for (let y = 0; y < to; y++) {
    for (let x = 0; x < to; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < f; dy++) {
        for (let dx = 0; dx < f; dx++) {
          const o = ((y * f + dy) | 0) * from * 4 + (((x * f + dx) | 0) * 4);
          r += buf[o]; g += buf[o + 1]; b += buf[o + 2]; a += buf[o + 3];
        }
      }
      const n = f * f, o2 = (y * to + x) * 4;
      out[o2] = r / n; out[o2 + 1] = g / n; out[o2 + 2] = b / n; out[o2 + 3] = a / n;
    }
  }
  return out;
}
const img512 = downsample(raw, W, SIZE);

/* ---------- PNG 编码（RGBA8，filter 0） ---------- */
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** Node < 22 兜底的 CRC32 */
function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = [];
    for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function encodePNG(img, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  const rawScan = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rawScan[y * (size * 4 + 1)] = 0;
    img.copy(rawScan, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(rawScan, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- ICO / ICNS 封装 ---------- */
function packICO(pngs) { // pngs: [{size, data}]
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  const entries = [];
  const blobs = [];
  let offset = 6 + count * 16;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
    blobs.push(data);
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}
function packICNS(pngs) { // pngs: [{type, data}]
  const parts = [];
  let total = 8;
  for (const { type, data } of pngs) {
    const head = Buffer.alloc(8);
    head.write(type);
    head.writeUInt32BE(data.length + 8, 4);
    parts.push(Buffer.concat([head, data]));
    total += data.length + 8;
  }
  const header = Buffer.alloc(8);
  header.write('icns');
  header.writeUInt32BE(total, 4);
  return Buffer.concat([header, ...parts]);
}

/* ---------- 产出 ---------- */
fs.mkdirSync(OUT, { recursive: true });
const png = (s) => encodePNG(s === SIZE ? img512 : downsample(img512, SIZE, s), s);
const p512 = png(512), p256 = png(256), p128 = png(128), p64 = png(64), p48 = png(48), p32 = png(32), p16 = png(16);
fs.writeFileSync(path.join(OUT, 'icon.ico'), packICO([
  { size: 256, data: p256 }, { size: 64, data: p64 }, { size: 48, data: p48 }, { size: 32, data: p32 }, { size: 16, data: p16 },
]));
fs.writeFileSync(path.join(OUT, 'icon.icns'), packICNS([
  { type: 'ic09', data: p512 }, { type: 'ic08', data: p256 }, { type: 'ic07', data: p128 },
]));
fs.writeFileSync(path.join(OUT, 'icon-512.png'), p512);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2bd86a"/><stop offset="1" stop-color="#059f4c"/></linearGradient></defs><rect width="512" height="512" rx="118" fill="url(#g)"/><path d="M96 164 a52 52 0 0 1 52 -52 h216 a52 52 0 0 1 52 52 v140 a52 52 0 0 1 -52 52 h-166 l-68 74 20 -74 h-2 a52 52 0 0 1 -52 -52 z" fill="#fff"/><path d="M186 316 L198 208 L250 262 L276 198 L302 262 L354 208 L366 316 Z" fill="#07c160"/><rect x="186" y="316" width="180" height="24" rx="8" fill="#07c160"/></svg>`;
fs.mkdirSync(path.join(OUT, '..', 'src', 'assets'), { recursive: true });
fs.writeFileSync(path.join(OUT, '..', 'src', 'assets', 'icon.svg'), svg);
console.log(`图标生成完成 → dist/icon.ico / icon.icns / icon-512.png / src/assets/icon.svg`);
