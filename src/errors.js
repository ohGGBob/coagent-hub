/**
 * 统一错误类型。HTTP 层据此映射状态码与错误码。
 *
 * @module errors
 */

/**
 * @typedef {object} HubErrorBody
 * @property {string} code
 * @property {string} message
 * @property {*} [detail]
 */

export class HubError extends Error {
  /**
   * @param {number} status HTTP 状态码
   * @param {string} code   稳定错误码，供 agent 程序化判断
   * @param {string} message
   * @param {*} [detail]
   */
  constructor(status, code, message, detail) {
    super(message);
    this.name = 'HubError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }

  /** @returns {HubErrorBody} */
  toJSON() {
    const body = { code: this.code, message: this.message };
    if (this.detail !== undefined) body.detail = this.detail;
    return body;
  }
}

export const badRequest = (m, d) => new HubError(400, 'BAD_REQUEST', m, d);
export const unauthorized = (m = '缺失或无效的 token', d) => new HubError(401, 'UNAUTHORIZED', m, d);
export const forbidden = (m, d) => new HubError(403, 'FORBIDDEN', m, d);
export const notFound = (m, d) => new HubError(404, 'NOT_FOUND', m, d);
export const conflict = (m, d) => new HubError(409, 'CONFLICT', m, d);
export const notImplemented = (m, d) => new HubError(501, 'NOT_IMPLEMENTED', m, d);
