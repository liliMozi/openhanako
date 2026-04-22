/**
 * @typedef {'anyone'|'owner'|'admin'} Permission
 * @typedef {'session'|'agent'|'global'} Scope
 * @typedef {'core'|'plugin'|'skill'} Source
 *
 * @typedef {object} CommandDef
 * @property {string} name
 * @property {string[]} [aliases]
 * @property {string} [description]
 * @property {Scope} [scope]
 * @property {Permission} permission
 * @property {Source} [source]
 * @property {string} [sourceId]
 * @property {(ctx: object) => Promise<object|void>} handler
 * @property {string} [usage]
 */

const MAX_COMMAND_NAME_LENGTH = 32;

function normalize(raw) {
  const s = String(raw ?? "").trim().toLowerCase()
    .replace(/-/g, "_")
    .replace(/[^a-z0-9_]/g, "_")
    .slice(0, MAX_COMMAND_NAME_LENGTH);
  // strip 前后下划线、合并重复下划线，让纯符号名（如 "---"）归一化为 ""，触发上游 throw
  return s.replace(/^_+|_+$/g, "").replace(/_+/g, "_");
}

export class SlashCommandRegistry {
  // 纪律 #3：内核保留名，plugin/skill 来源禁止注册同名（防内核命令被覆盖）
  static CORE_RESERVED_NAMES = new Set(["stop", "new", "reset", "compact", "help", "status"]);

  constructor() {
    this._byName = new Map();   // normalized name → def
    this._bySource = new Map(); // "source:sourceId" → Set<name>
  }

  /**
   * @returns {{name:string,sourceKey:string}|null} null 表示被闸门拒绝
   */
  registerCommand(def, meta = {}) {
    const base = normalize(def.name);
    if (!base) throw new Error("Command name required");
    // 闸门判定只看 meta.source（loader 层传入的权威标记），def.source 不参与判定
    // 否则 plugin 可通过 `export const source = "core"` 绕开纪律 #3
    const gateSource = meta.source ?? "core";
    const sourceId = meta.sourceId ?? def.sourceId ?? null;
    if (gateSource !== "core" && SlashCommandRegistry.CORE_RESERVED_NAMES.has(base)) {
      console.warn(`[slash] rejected register: "${base}" is core-reserved (source=${gateSource}${sourceId ? `, sourceId=${sourceId}` : ""})`);
      return null;
    }
    // 存储时 meta.source 优先，其次 def.source，最后默认 "core"
    const source = meta.source ?? def.source ?? "core";
    let finalName = base;
    let i = 2;
    while (this._byName.has(finalName)) finalName = `${base}_${i++}`;
    const stored = { ...def, name: finalName, source, sourceId };
    this._byName.set(finalName, stored);
    for (const a of (def.aliases || [])) {
      const an = normalize(a);
      if (!an) continue;
      if (this._byName.has(an)) {
        console.warn(`[slash] alias "${an}" for command "${finalName}" skipped (name already taken)`);
        continue;
      }
      this._byName.set(an, stored);
    }
    const sKey = `${source}:${sourceId || ""}`;
    if (!this._bySource.has(sKey)) this._bySource.set(sKey, new Set());
    this._bySource.get(sKey).add(finalName);
    return { name: finalName, sourceKey: sKey };
  }

  unregisterCommand(handle) {
    const def = this._byName.get(handle.name);
    if (!def) return false;
    this._byName.delete(handle.name);
    for (const a of (def.aliases || [])) {
      const an = normalize(a);
      if (this._byName.get(an) === def) this._byName.delete(an);
    }
    // 从存储的 def 推算 sourceKey，不信任 caller 传入的 handle.sourceKey
    // 否则 stale handle 会让 _byName 删掉但 _bySource 悬挂
    const sKey = `${def.source}:${def.sourceId || ""}`;
    this._bySource.get(sKey)?.delete(handle.name);
    return true;
  }

  unregisterBySource(source, sourceId) {
    const sKey = `${source}:${sourceId || ""}`;
    const names = this._bySource.get(sKey);
    if (!names) return 0;
    let n = 0;
    for (const name of Array.from(names)) {
      if (this.unregisterCommand({ name, sourceKey: sKey })) n++;
    }
    this._bySource.delete(sKey); // 清空跟踪条目（即使 n===0 也删，保持 map 整洁）
    return n;
  }

  lookup(rawName) {
    return this._byName.get(normalize(rawName)) || null;
  }

  list() {
    // 浅克隆，防 caller 篡改 registry 内部存储
    return Array.from(new Set(this._byName.values())).map(d => ({ ...d }));
  }
}
