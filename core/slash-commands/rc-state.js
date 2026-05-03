/**
 * rc-state.js — /rc & /exitrc 的内存态管理
 *
 * 持有两种跨消息的临时状态，按 bridge sessionKey 为键：
 *   1. pending-selection —— 等待用户输入（当前只用于数字选 session，未来可扩展到 yes/no 等）
 *   2. attachment —— 当前 bridge session 已接管某桌面 session
 *
 * attachment 额外维护 desktopSessionPath -> bridge sessionKey 的反向索引，
 * 以保证同一个桌面 session 同时最多只会被一个 bridge session 接管。
 *
 * 两态同 sessionKey 时刻只持有一个（选择进行中不可能同时已接管；接管中收到新 /rc 会先 reset 再列）。
 *
 * 持久化策略：内存 only，重启即清空。用户已明确"接管态不持久化"。
 *
 * 过期机制：懒惰过期（lazy expiration）——不开后台扫描，每次 getPending 时检查 expiresAt。
 *   过期条目在下次访问时清除。无访问亦无害，重启时连 Map 一起消失。
 */

const PENDING_DEFAULT_TTL_MS = 5 * 60 * 1000;  // 5 分钟

/**
 * @typedef {object} PendingSpec
 * @property {'rc-select'} type  当前仅 rc-select；预留扩展：'yes-no' / 'free-text'
 * @property {string} promptText  提示原文（用于重发或排障）
 * @property {Array<{path: string, title: string|null}>} options  1-based 序号对应的桌面 session 列表
 * @property {number} expiresAt  绝对时间戳（Date.now() + ttl）
 */

/**
 * @typedef {object} Attachment
 * @property {string} desktopSessionPath  被接管的桌面 session 绝对路径
 * @property {number} attachedAt  毫秒时间戳，用于排障
 * @property {string|null} [platform]  来源 bridge 平台
 * @property {string|null} [chatId]  回发目标 chatId
 * @property {string|null} [agentId]  所属 agent
 * @property {string|number|null} [messageThreadId]  平台 thread 标识
 */

export class RcStateStore {
  /**
   * @param {{ ttlMs?: number }} [opts]
   */
  constructor({ ttlMs = PENDING_DEFAULT_TTL_MS } = {}) {
    /** @type {Map<string, PendingSpec>} */
    this._pending = new Map();
    /** @type {Map<string, Attachment>} */
    this._attachment = new Map();
    /** @type {Map<string, string>} */
    this._attachedDesktopToBridge = new Map();
    this._ttlMs = ttlMs;
  }

  // ── pending-selection ──────────────────────────────────────

  /**
   * @param {string} sessionKey
   * @param {Omit<PendingSpec, 'expiresAt'>} spec
   */
  setPending(sessionKey, spec) {
    const expiresAt = Date.now() + this._ttlMs;
    this._pending.set(sessionKey, { ...spec, expiresAt });
  }

  /**
   * @param {string} sessionKey
   * @returns {PendingSpec | null}
   */
  getPending(sessionKey) {
    const p = this._pending.get(sessionKey);
    if (!p) return null;
    if (Date.now() >= p.expiresAt) {
      // 懒惰过期：一读到就清
      this._pending.delete(sessionKey);
      return null;
    }
    return p;
  }

  clearPending(sessionKey) {
    this._pending.delete(sessionKey);
  }

  /** @returns {boolean} */
  isPending(sessionKey) {
    return this.getPending(sessionKey) !== null;
  }

  // ── attachment ─────────────────────────────────────────────

  /**
   * @param {string} sessionKey
   * @param {string} desktopSessionPath  桌面 session 的 jsonl 绝对路径
   */
  attach(sessionKey, desktopSessionPath, meta = {}) {
    const current = this._attachment.get(sessionKey) ?? null;
    const holderSessionKey = this._attachedDesktopToBridge.get(desktopSessionPath) ?? null;
    if (holderSessionKey && holderSessionKey !== sessionKey) {
      throw new Error("目标会话已被另一个 bridge 会话接管，接管取消。请重新 /rc");
    }

    if (current?.desktopSessionPath && current.desktopSessionPath !== desktopSessionPath) {
      this._attachedDesktopToBridge.delete(current.desktopSessionPath);
    }

    const next = {
      desktopSessionPath,
      attachedAt: Date.now(),
      platform: meta.platform || null,
      chatId: meta.chatId || null,
      agentId: meta.agentId || null,
      messageThreadId: meta.messageThreadId || null,
    };
    this._attachment.set(sessionKey, next);
    this._attachedDesktopToBridge.set(desktopSessionPath, sessionKey);
    return next;
  }

  /**
   * @param {string} sessionKey
   * @returns {Attachment | null}
   */
  getAttachment(sessionKey) {
    return this._attachment.get(sessionKey) ?? null;
  }

  /**
   * @param {string} desktopSessionPath
   * @returns {string | null}
   */
  getAttachedBridgeSessionKey(desktopSessionPath) {
    return this._attachedDesktopToBridge.get(desktopSessionPath) ?? null;
  }

  /**
   * @param {string} desktopSessionPath
   * @returns {boolean}
   */
  isDesktopSessionAttached(desktopSessionPath) {
    return this._attachedDesktopToBridge.has(desktopSessionPath);
  }

  detach(sessionKey) {
    const current = this._attachment.get(sessionKey) ?? null;
    if (current?.desktopSessionPath) {
      const holderSessionKey = this._attachedDesktopToBridge.get(current.desktopSessionPath) ?? null;
      if (holderSessionKey === sessionKey) {
        this._attachedDesktopToBridge.delete(current.desktopSessionPath);
      }
    }
    this._attachment.delete(sessionKey);
    return current;
  }

  /** @returns {boolean} */
  isAttached(sessionKey) {
    return this._attachment.has(sessionKey);
  }

  /**
   * 当桌面 session 被 archive/delete 后，清掉所有引用它的临时 rc 状态。
   * pending 直接整条作废，避免菜单编号在后台漂移。
   *
   * @param {string} desktopSessionPath
   * @returns {{ detachedAttachments: Array<Attachment & { sessionKey: string }>, clearedPendingSessionKeys: string[] }}
   */
  invalidateDesktopSession(desktopSessionPath) {
    const detachedAttachments = [];
    const holderSessionKey = this._attachedDesktopToBridge.get(desktopSessionPath) ?? null;
    if (holderSessionKey) {
      const detached = this.detach(holderSessionKey);
      if (detached) {
        detachedAttachments.push({
          sessionKey: holderSessionKey,
          ...detached,
        });
      }
    }

    const clearedPendingSessionKeys = [];
    const now = Date.now();
    for (const [sessionKey, pending] of Array.from(this._pending.entries())) {
      if (now >= pending.expiresAt) {
        this._pending.delete(sessionKey);
        continue;
      }
      if (pending.options?.some(option => option.path === desktopSessionPath)) {
        this._pending.delete(sessionKey);
        clearedPendingSessionKeys.push(sessionKey);
      }
    }

    return { detachedAttachments, clearedPendingSessionKeys };
  }

  /**
   * releaseDesktopSession 是 invalidateDesktopSession 的语义别名：
   * 调用方表达的是"该桌面 session 生命周期已结束"，不是"某个缓存失效"。
   *
   * @param {string} desktopSessionPath
   * @returns {{ detachedAttachments: Array<Attachment & { sessionKey: string }>, clearedPendingSessionKeys: string[] }}
   */
  releaseDesktopSession(desktopSessionPath) {
    return this.invalidateDesktopSession(desktopSessionPath);
  }

  // ── utility ────────────────────────────────────────────────

  /** 同时清 pending + attachment；/exitrc 和 session 重置场景用 */
  reset(sessionKey) {
    this._pending.delete(sessionKey);
    this.detach(sessionKey);
  }

  /**
   * 测试 / 排障用：返回所有接管态快照。生产代码不应依赖。
   * @returns {Array<Attachment & { sessionKey: string }>}
   */
  listAttachments() {
    return Array.from(this._attachment.entries()).map(([sessionKey, att]) => ({
      sessionKey,
      ...att,
    }));
  }
}
