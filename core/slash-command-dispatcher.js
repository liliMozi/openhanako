const CMD_RE = /^\s*\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*?))?\s*$/;
const RANK = { anyone: 0, owner: 1, admin: 2 };
const DEFAULT_TIMEOUT_MS = 30_000;
// 哪些 source 拥有 admin 权限——抽成常量便于审计"谁是 admin"
const ADMIN_SOURCES = new Set(["desktop"]);

export class SlashCommandDispatcher {
  constructor({ registry, engine, hub, sessionOps, timeoutMs } = {}) {
    this._registry = registry;
    this._engine = engine || null;
    this._hub = hub || null;
    this._sessionOps = sessionOps || null;
    // 纪律 #5：handler 执行超时，防止插件 handler 卡死 dispatcher
    // 必须 > 0；timeoutMs: 0 会让每次调用立即超时（Number.isFinite(0) 是 true）
    this._timeoutMs = (Number.isFinite(timeoutMs) && timeoutMs > 0) ? timeoutMs : DEFAULT_TIMEOUT_MS;
  }

  /** 外部注入 hub 的 setter（engine.setHubCallbacks 里调），避免访问私有字段 */
  setHub(hub) { this._hub = hub; }

  parse(text) {
    if (!text) return null;
    const m = CMD_RE.exec(text);
    if (!m) return null;
    return { commandName: m[1], args: m[2] || "" };
  }

  async tryDispatch(text, ctx) {
    const parsed = this.parse(text);
    if (!parsed) return { handled: false };
    const def = this._registry?.lookup(parsed.commandName);
    if (!def) return { handled: false };

    const role = this._resolveRole(ctx);
    if (RANK[role] < RANK[def.permission]) {
      try { console.debug(`[slash] rejected: /${parsed.commandName} from ${role}`); } catch {}
      return { handled: true };
    }

    // I4 guard：hub 未注入时 tryDispatch 不该被调——快速失败、显式错误，优于 handler 深处访问 null
    if (!this._hub) {
      throw new Error("[SlashCommandDispatcher] hub not injected yet — call setHub() before tryDispatch()");
    }

    // 纪律 #4：ctx 冻结，防 handler 篡改回传对象或经由 prototype 注入
    // 注意：仅浅冻结，nested objects（engine/hub/sessionRef）仍可被 handler 修改；Phase 1 接受此限制
    const fullCtx = Object.freeze({
      ...ctx,
      rawText: text,
      commandName: parsed.commandName,
      args: parsed.args,
      senderRole: role,
      hub: this._hub,
      engine: this._engine,
      sessionOps: this._sessionOps,
    });

    // 纪律 #5：Promise.race 超时保护，即使 handler 永远 pending 也能恢复
    let timer;
    const timeoutPromise = new Promise((_, rej) => {
      timer = setTimeout(
        () => rej(new Error(`命令超时（>${this._timeoutMs}ms）`)),
        this._timeoutMs,
      );
    });
    const handlerPromise = Promise.resolve().then(() => def.handler(fullCtx));
    // C1 fix：handler 输掉 race 后其 Promise 仍会 settle；attach no-op catch 防 UnhandledPromiseRejection 进程崩溃（Node ≥15）
    handlerPromise.catch(() => {});

    try {
      const result = await Promise.race([handlerPromise, timeoutPromise]);
      if (result && typeof result === "object") {
        if (result.silent) return { handled: true };
        if (result.error) {
          // I3 fix：result.error 有独立 try/catch，避免 reply 失败被外层 catch 误当作 handler exception 处理
          try { await ctx.reply(`[命令错误] ${result.error}`); } catch {}
        } else if (result.reply) {
          try { await ctx.reply(result.reply); } catch {}
        }
      }
    } catch (err) {
      const base = `[命令错误] ${err?.message || String(err)}`;
      const full = def.usage ? `${base}\n用法：${def.usage}` : base;
      try { await ctx.reply(full); } catch {}
    } finally {
      clearTimeout(timer);
    }
    return { handled: true };
  }

  _resolveRole(ctx) {
    // I2 fix：从 ADMIN_SOURCES 常量判定而非硬编码字符串，便于未来审计
    if (ADMIN_SOURCES.has(ctx.source)) return "admin";
    if (ctx.sessionRef?.kind === "bridge") return ctx.isOwner ? "owner" : "anyone";
    return "anyone";
  }
}
