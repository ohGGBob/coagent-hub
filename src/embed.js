/**
 * Ollama 嵌入客户端 —— Phase 3 语义检索的向量来源（Phase 3）。
 *
 * 设计约束：
 *  - 零 npm 依赖：用 Node 内置 fetch 调本机 Ollama HTTP 接口（/api/embed 批量端点）。
 *  - 永不阻塞主流程：任何失败（未安装 / 宕机 / 超时 / 响应异常）一律静默降级，
 *    调用方拿到 null 后自动退回 BM25 关键词检索，行为与未启用时完全一致。
 *  - 隐私优先：文本只发往本机 / 局域网内的 Ollama，不出网。
 *
 * 配置（环境变量）：
 *  - COAGENT_EMBED=0        强制关闭（默认自动探测）
 *  - COAGENT_EMBED_URL      Ollama 地址，默认 http://127.0.0.1:11434
 *  - COAGENT_EMBED_MODEL    嵌入模型，默认 bge-m3（ollama pull bge-m3）
 *
 * @module embed
 */

/**
 * Ollama 基地址。来源是运维环境变量 COAGENT_EMBED_URL（主机管理员配置），
 * 任何 HTTP 请求输入都到不了这里——不存在「按用户提供的 URL 发起请求」的路径。
 * 环回/私网地址（默认 127.0.0.1:11434）是本功能的预期目标：隐私优先的本机 Ollama，
 * 因此刻意不做「阻断私网」；唯一的入口校验是协议白名单（仅 http/https），
 * 防止误配 file:/ftp: 等协议被 fetch 底层意外处理。
 */
const BASE_URL = (() => {
  const raw = (process.env.COAGENT_EMBED_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      console.warn(`[embed] COAGENT_EMBED_URL 协议必须是 http/https（got: ${u.protocol}），语义检索已禁用`);
      return null;
    }
    return raw;
  } catch {
    console.warn('[embed] COAGENT_EMBED_URL 不是合法 URL，语义检索已禁用');
    return null;
  }
})();
/** 是否启用（COAGENT_EMBED=0 显式关闭，或 URL 配置非法时自动禁用） */
const ENABLED = process.env.COAGENT_EMBED !== '0' && BASE_URL !== null;
/** 嵌入模型 */
const MODEL = process.env.COAGENT_EMBED_MODEL ?? 'bge-m3';
/** 单次请求超时 */
const TIMEOUT_MS = 5_000;
/** 不可用时的重探间隔 */
const RETRY_MS = 60_000;

let available = false;
let dim = 0;
let probing = false;
let lastError = null;

/** @returns {{enabled: boolean, baseUrl: string, model: string}} */
export function embedConfig() {
  return { enabled: ENABLED, baseUrl: BASE_URL, model: MODEL };
}

/** @returns {{available: boolean, provider: string, model: string, dim: number, lastError: string|null}} */
export function embedStatus() {
  return {
    available: ENABLED && available,
    provider: 'ollama',
    model: MODEL,
    dim,
    lastError,
  };
}

/** @param {string} path */
function post(path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  return fetch(BASE_URL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: ctrl.signal,
  }).finally(() => clearTimeout(timer));
}

/**
 * 批量嵌入。成功则刷新可用状态；任何失败返回 null 并记录原因（供 /embed/status 展示）。
 * @param {string[]} texts
 * @returns {Promise<number[][]|null>}
 */
export async function embed(texts) {
  if (!ENABLED || !texts?.length) return null;
  try {
    const res = await post('/api/embed', { model: MODEL, input: texts });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = await res.json();
    const arr = data?.embeddings;
    if (!Array.isArray(arr) || arr.length !== texts.length || !Array.isArray(arr[0])) {
      throw new Error('响应缺少 embeddings（确认模型已 pull：ollama pull ' + MODEL + '）');
    }
    available = true;
    dim = arr[0].length || dim;
    lastError = null;
    return arr;
  } catch (err) {
    available = false;
    lastError = String(err?.cause?.code ?? err?.message ?? err);
    return null;
  }
}

/**
 * 嵌入单条文本。
 * @param {string} text
 * @returns {Promise<number[]|null>}
 */
export async function embedOne(text) {
  const vecs = await embed([text]);
  return vecs ? vecs[0] : null;
}

/**
 * 启动探测：试嵌入一条探针文本。不可用时安排 60s 后重探（unref，不阻止进程退出）。
 * 探测失败不抛错——语义检索是渐进增强，不是启动前提。
 */
export async function probeEmbedder() {
  if (!ENABLED || probing) return embedStatus();
  probing = true;
  try {
    await embedOne('coagent probe');
  } finally {
    probing = false;
  }
  if (!available) setTimeout(() => { probeEmbedder().catch(() => {}); }, RETRY_MS).unref();
  return embedStatus();
}
