/**
 * PreferencesManager — 全局 preferences.json 读写
 *
 * 统一管理用户级全局配置（bridge、agent 排序等），
 * 以及 primaryAgent 偏好。从 Engine 提取，避免 route 穿透私有字段。
 */
import fs from "fs";
import path from "path";

export class PreferencesManager {
  /**
   * @param {object} opts
   * @param {string} opts.userDir  - 用户数据目录（preferences.json 所在）
   * @param {string} opts.agentsDir - agents 根目录（findFirstAgent 用）
   */
  constructor({ userDir, agentsDir }) {
    this._userDir = userDir;
    this._agentsDir = agentsDir;
    this._path = path.join(userDir, "preferences.json");
    this._cache = this._readFromDisk();
  }

  /** 读取全局 preferences（从内存缓存） */
  getPreferences() {
    return structuredClone(this._cache);
  }

  /** 写入全局 preferences（更新缓存 + 原子写磁盘） */
  savePreferences(prefs) {
    this._cache = structuredClone(prefs);
    fs.mkdirSync(this._userDir, { recursive: true });
    const tmp = this._path + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(prefs, null, 2) + "\n", "utf-8");
    fs.renameSync(tmp, this._path);
  }

  /** @private 从磁盘读取（仅构造时调用一次） */
  _readFromDisk() {
    try {
      return JSON.parse(fs.readFileSync(this._path, "utf-8"));
    } catch (err) {
      if (err.code === "ENOENT") return {};
      console.warn(`[preferences] failed to read ${this._path}: ${err.message}`);
      return {};
    }
  }

  // ── 内部 getter 直接读 _cache，避免 structuredClone 开销 ──
  // 写操作使用 _mutableCopy() 获取浅拷贝，修改后 savePreferences

  /** @private 获取可修改的浅拷贝（setter 专用） */
  _mutableCopy() {
    return { ...this._cache };
  }

  /** 读取沙盒模式偏好 */
  getSandbox() {
    return this._cache.sandbox !== false;
  }

  /** 保存沙盒模式偏好 */
  setSandbox(enabled) {
    const prefs = this._mutableCopy();
    prefs.sandbox = typeof enabled === "string" ? enabled === "true" : !!enabled;
    this.savePreferences(prefs);
  }

  /** 读取文件备份配置 */
  getFileBackup() {
    const cfg = this._cache.file_backup;
    if (!cfg) return { enabled: false, retention_days: 1, max_file_size_kb: 1024 };
    return {
      enabled: !!cfg.enabled,
      retention_days: cfg.retention_days || 1,
      max_file_size_kb: cfg.max_file_size_kb || 1024,
    };
  }

  /** 合并写入文件备份配置 */
  setFileBackup(partial) {
    const prefs = this._mutableCopy();
    prefs.file_backup = { ...(prefs.file_backup || {}), ...partial };
    this.savePreferences(prefs);
  }

  /** 读取自学技能配置（全局，跨 agent） */
  getLearnSkills() {
    const cfg = this._cache.learn_skills;
    if (!cfg) return { enabled: true, safety_review: true };
    return cfg;
  }

  /** 合并写入自学技能配置 */
  setLearnSkills(partial) {
    const prefs = this._mutableCopy();
    prefs.learn_skills = { ...(prefs.learn_skills || {}), ...partial };
    this.savePreferences(prefs);
  }

  /** 读取语言偏好（全局） */
  getLocale() {
    return this._cache.locale || "";
  }

  /** 保存语言偏好 */
  setLocale(locale) {
    const prefs = this._mutableCopy();
    prefs.locale = locale || "";
    this.savePreferences(prefs);
  }

  /** 读取时区偏好（全局） */
  getTimezone() {
    return this._cache.timezone || "";
  }

  /** 保存时区偏好 */
  setTimezone(tz) {
    const prefs = this._mutableCopy();
    prefs.timezone = tz || "";
    this.savePreferences(prefs);
  }

  /** 读取 thinking level 偏好（用户全局，跨 agent / session） */
  getThinkingLevel() {
    return this._cache.thinking_level || "auto";
  }

  /** 保存 thinking level 偏好 */
  setThinkingLevel(level) {
    const prefs = this._mutableCopy();
    prefs.thinking_level = level;
    this.savePreferences(prefs);
  }

  /** 读取外部技能扫描路径 */
  getExternalSkillPaths() {
    return this._cache.external_skill_paths || [];
  }

  /** 保存外部技能扫描路径 */
  setExternalSkillPaths(paths) {
    const prefs = this._mutableCopy();
    prefs.external_skill_paths = paths;
    this.savePreferences(prefs);
  }

  /** 读取 OAuth 自定义模型 { provider: ["model-id", ...] }
   *  返回浅拷贝：调用方（如 auth.js）会 push() 到子数组再保存，
   *  必须隔离以免脏写 _cache */
  getOAuthCustomModels() {
    const src = this._cache.oauth_custom_models;
    if (!src) return {};
    const copy = {};
    for (const [k, v] of Object.entries(src)) {
      copy[k] = Array.isArray(v) ? [...v] : v;
    }
    return copy;
  }

  /** 设置某个 OAuth provider 的自定义模型列表 */
  setOAuthCustomModels(provider, modelIds) {
    const prefs = this._mutableCopy();
    if (!prefs.oauth_custom_models) prefs.oauth_custom_models = {};
    if (modelIds.length === 0) {
      delete prefs.oauth_custom_models[provider];
    } else {
      prefs.oauth_custom_models[provider] = modelIds;
    }
    this.savePreferences(prefs);
  }

  /** 读取是否允许 full-access 社区插件运行 */
  getAllowFullAccessPlugins() {
    return this._cache.allow_full_access_plugins || false;
  }

  /** 保存是否允许 full-access 社区插件运行 */
  setAllowFullAccessPlugins(value) {
    const prefs = this._mutableCopy();
    prefs.allow_full_access_plugins = !!value;
    this.savePreferences(prefs);
  }

  /** 读取用户手动禁用的插件 ID 列表 */
  getDisabledPlugins() {
    return this._cache.disabled_plugins || [];
  }

  /** 保存用户手动禁用的插件 ID 列表 */
  setDisabledPlugins(list) {
    const prefs = this._mutableCopy();
    prefs.disabled_plugins = Array.isArray(list) ? list : [];
    this.savePreferences(prefs);
  }

  /** 读取更新通道偏好："stable" | "beta" */
  getUpdateChannel() {
    return this._cache.update_channel || "stable";
  }

  /** 保存更新通道偏好 */
  setUpdateChannel(channel) {
    const prefs = this._mutableCopy();
    prefs.update_channel = channel === "beta" ? "beta" : "stable";
    this.savePreferences(prefs);
  }

  /** 读取"自动检查更新"开关：默认 true */
  getAutoCheckUpdates() {
    return this._cache.auto_check_updates !== false;
  }

  /** 保存"自动检查更新"开关 */
  setAutoCheckUpdates(value) {
    const prefs = this._mutableCopy();
    prefs.auto_check_updates = value !== false;
    this.savePreferences(prefs);
  }

  /** 读取 primary agent ID */
  getPrimaryAgent() {
    return this._cache.primaryAgent || null;
  }

  /** 保存 primary agent ID */
  savePrimaryAgent(agentId) {
    const prefs = this._mutableCopy();
    prefs.primaryAgent = agentId;
    this.savePreferences(prefs);
  }

  /**
   * 找到 agents/ 目录下第一个合法的 agent
   * @returns {string|null}
   */
  findFirstAgent() {
    try {
      const entries = fs.readdirSync(this._agentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (fs.existsSync(path.join(this._agentsDir, entry.name, "config.yaml"))) {
          return entry.name;
        }
      }
    } catch {}
    return null;
  }
}
