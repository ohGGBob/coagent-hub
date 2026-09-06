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
export function createFileStore({ dir = PATHS.files, metaFile = PATHS.fileMeta } = {}) {
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
    const filePath = path.join(dir, storedName);
    fs.writeFileSync(filePath, buffer);

    /** @type {FileMeta} */
    const meta = {
      id,
      filename: String(filename || 'file').slice(0, 255),
      storedName,
      size: buffer.length,
      mimeType: mimeType || 'application/octet-stream',
      uploadedBy,
      createdAt: new Date().toISOString(),
    };
    const all = loadMeta();
    all[id] = meta;
    saveMeta(all);
    return meta;
  }

  /**
   * 获取文件元数据。
   * @param {string} id
   * @returns {FileMeta}
   */
  function get(id) {
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
    const data = fs.readFileSync(path.join(dir, meta.storedName));
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
    fs.rmSync(path.join(dir, meta.storedName), { force: true });
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
