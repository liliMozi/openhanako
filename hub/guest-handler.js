/**
 * GuestHandler — Guest 留言机处理
 *
 * 所有非主人的消息都经过这里。
 * A: 消息前缀标注发送者身份
 * B: system prompt 注入对话上下文（不暴露任何主人隐私）
 */

export class GuestHandler {
  /**
   * @param {object} opts
   * @param {import('./index.js').Hub} opts.hub
   */
  constructor({ hub }) {
    this._hub = hub;
  }

  /**
   * 处理 guest 消息
   * @param {string} text
   * @param {string} sessionKey
   * @param {object} [meta]  { name, avatarUrl, userId }
   * @param {object} [opts]  { isGroup }
   * @returns {Promise<string|null>}
   */
  async handle(text, sessionKey, meta, opts = {}) {
    const senderName = meta?.name || "访客";
    const isGroup = opts.isGroup || false;

    // A: 消息前缀
    const prefixed = `[来自 ${senderName}] ${text}`;

    // B: 上下文标签（注入到 system prompt 末尾）
    const contextTag = isGroup
      ? "当前对话来自群聊。"
      : `当前对话来自外部访客。`;

    return this._hub.engine.executeExternalMessage(prefixed, sessionKey, meta, {
      guest: true,
      agentId: opts.agentId,
      contextTag,
      onDelta: opts.onDelta,
    });
  }
}
