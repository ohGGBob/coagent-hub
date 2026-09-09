/**
 * 文件附件存储 —— 零依赖，原始二进制落盘 + JSON 元数据。
 *
 * 设计：
 *  - 文件以 UUID 存储在 data/files/，保留原始扩展名（便于下载时识别）
 *  - 元数据（文件名/大小/MIME/上传者/时间）存在 data/files.json
 *  - 上传走原始二进制（Content-Type: application/octet-stream），X-Filename 头指定文件名
 *  - 单文件上限 50MB（COAGENT_MAX_FILE_MB 可配置）
 *  - 上下文条目通过 attachments: [fileId] 关联文件
 *
 * @module files
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PATHS } from './config.js';
import { readJson, writeJson } from './jsonfile.js';
import { notFound, badRequest, forbidden } from './errors.js';

/** 单文件最大字节数（默认 50MB） */
const MAX_FILE_SIZE = Number(process.env.COAGENT_MAX_FILE_MB ?? 50) * 1024 * 1024;

/**
 * 允许存储的 MIME 白名单。
 *
 * 上传时的 Content-Type 完全由客户端控制，若原样存下来并在下载时原样回写，
 * 就等于给了一个存储型 XSS 通道：传 text/html + 一段脚本，
 * 别人在面板里点开即以同源身份执行（sessionStorage 里的 token 直接被拿走）。
 * 因此这里只放行不可能被浏览器当活动文档执行的类型，其余一律降级为
 * application/octet-stream 并以附件形式下载。
 */
const SAFE_MIME = new Set([
  'application/octet-stream',
  'application/json',
  'application/pdf',
  'application/zip',
  'application/gzip',
  'application/x-tar',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/markdown',
  'text/csv',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/x-icon',
  'audio/mpeg', 'audio/wav', 'audio/ogg',
  'video/mp4', 'video/webm',
]);

/**
 * 把客户端声明的 MIME 收敛到白名单内。
 * @param {string} [declared]
 * @returns {string}
 */
function sanitizeMime(declared) {
  const raw = String(declared ?? '').split(';')[0].trim().toLowerCase();
  return SAFE_MIME.has(raw) ? raw : 'application/octet-stream';
}

/**
 * @typedef {object} FileMeta
 * @property {string} id          UUID
 * @property {string} filename    原始文件名
 * @property {string} storedName  磁盘存储名（UUID + 扩展名）
 * @property {number} size        字节数
 * @property {string} mimeType    MIME 类型
 * @property {string} uploadedBy  上传者 userId
 * @property {string} createdAt   ISO 时间
 */

/**
 * @param {{dir?: string, metaFile?: string}} [deps]
 */
export function createFileStore() {
  // 存储路径固定为模块常量，不接受调用方注入
  const dir = PATHS.files;
  const metaFile = PATHS.fileMeta;
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(metaFile)) writeJson(metaFile, {});

  /** @returns {Record<string, FileMeta>} */
  const loadMeta = () => readJson(metaFile, {});
  /** @param {Record<string, FileMeta>} meta */
  const saveMeta = (meta) => writeJson(metaFile, meta);

  /**
   * 从文件名提取安全扩展名（防止路径穿越）。
   * @param {string} filename
   * @returns {string}
   */
  function safeExt(filename) {
    const ext = path.extname(String(filename || '')).toLowerCase().slice(0, 16);
    return /^\.[a-z0-9]+$/.test(ext) ? ext : '';
  }

  /**
   * 目录内安全路径：解析后必须仍落在 dir 内，否则拒绝。
   * storedName 虽由 UUID + 白名单扩展名拼成，这里再加一道 containment 保险。
   * @param {string} name
   * @returns {string}
   */
  function safeJoin(name) {
    const resolved = path.resolve(dir, String(name));
    if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
      throw badRequest('非法的文件路径');
    }
    return resolved;
  }

  /**
   * 存储一个文件。
   * @param {{buffer: Buffer, filename: string, mimeType?: string, uploadedBy: string}} input
   * @returns {FileMeta}
   */
  function store({ buffer, filename, mimeType, uploadedBy }) {
    if (!buffer || !buffer.length) throw badRequest('文件内容为空');
    if (buffer.length > MAX_FILE_SIZE) {
      throw badRequest(`文件超过上限 ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB`, { size: buffer.length, max: MAX_FILE_SIZE });
    }
    const id = randomUUID();
    const ext = safeExt(filename);
    const storedName = id + ext;
    const filePath = safeJoin(storedName);
    fs.writeFileSync(filePath, buffer);

    /** @type {FileMeta} */
    const meta = {
      id,
      filename: String(filename || 'file').slice(0, 255),
      storedName,
      size: buffer.length,
      mimeType: sanitizeMime(mimeType),
      uploadedBy,
      createdAt: new Date().toISOString(),
    };
    const all = loadMeta();
    all[id] = meta;
    saveMeta(all);
    return meta;
  }

  /** 文件 id 格式白名单（UUID）：在进入任何路径运算前先拒绝畸形输入 */
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /**
   * 获取文件元数据。
   * @param {string} id
   * @returns {FileMeta}
   */
  function get(id) {
    if (!UUID_RE.test(String(id))) throw notFound(`文件不存在：${id}`);
    const meta = loadMeta()[id];
    if (!meta) throw notFound(`文件不存在：${id}`);
    return meta;
  }

  /**
   * 读取文件内容。
   * @param {string} id
   * @returns {{meta: FileMeta, data: Buffer}}
   */
  function read(id) {
    const meta = get(id);
    const data = fs.readFileSync(safeJoin(meta.storedName));
    return { meta, data };
  }

  /**
   * 列出所有文件元数据。
   * @returns {FileMeta[]}
   */
  function list() {
    return Object.values(loadMeta()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * 删除文件（元数据 + 磁盘文件）。
   * @param {string} id
   * @param {string} userId
   * @returns {{id: string, removed: boolean}}
   */
  function remove(id, userId) {
    const meta = get(id);
    if (meta.uploadedBy !== userId) {
      // 只有上传者可删；管理员判断由路由层做
      throw forbidden('只能删除自己上传的文件', { uploadedBy: meta.uploadedBy });
    }
    fs.rmSync(safeJoin(meta.storedName), { force: true });
    const all = loadMeta();
    delete all[id];
    saveMeta(all);
    return { id, removed: true };
  }

  /**
   * 格式化文件大小为人类可读。
   * @param {number} bytes
   * @returns {string}
   */
  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  return { store, get, read, list, remove, formatSize, MAX_FILE_SIZE };
}
