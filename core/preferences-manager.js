/**
 * PreferencesManager — 全局 preferences.json 读写
 *
 * 统一管理用户级全局配置（favorites、bridge、agent 排序等），
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
  }

  /** 读取全局 preferences */
  getPreferences() {
    try {
      return JSON.parse(fs.readFileSync(this._path, "utf-8"));
    } catch { return {}; }
  }

  /** 写入全局 preferences */
  savePreferences(prefs) {
    fs.mkdirSync(this._userDir, { recursive: true });
    fs.writeFileSync(this._path, JSON.stringify(prefs, null, 2) + "\n", "utf-8");
  }

  /** 读取沙盒模式偏好 */
  getSandbox() {
    return this.getPreferences().sandbox !== false;
  }

  /** 保存沙盒模式偏好 */
  setSandbox(enabled) {
    const prefs = this.getPreferences();
    prefs.sandbox = enabled;
    this.savePreferences(prefs);
  }

  /** 读取自学技能配置（全局，跨 agent） */
  getLearnSkills() {
    return this.getPreferences().learn_skills || {};
  }

  /** 合并写入自学技能配置 */
  setLearnSkills(partial) {
    const prefs = this.getPreferences();
    prefs.learn_skills = { ...(prefs.learn_skills || {}), ...partial };
    this.savePreferences(prefs);
  }

  /** 读取语言偏好（全局） */
  getLocale() {
    return this.getPreferences().locale || "";
  }

  /** 保存语言偏好 */
  setLocale(locale) {
    const prefs = this.getPreferences();
    prefs.locale = locale || "";
    this.savePreferences(prefs);
  }

  /** 读取时区偏好（全局） */
  getTimezone() {
    return this.getPreferences().timezone || "";
  }

  /** 保存时区偏好 */
  setTimezone(tz) {
    const prefs = this.getPreferences();
    prefs.timezone = tz || "";
    this.savePreferences(prefs);
  }

  /** 读取 thinking level 偏好（用户全局，跨 agent / session） */
  getThinkingLevel() {
    return this.getPreferences().thinking_level || "auto";
  }

  /** 保存 thinking level 偏好 */
  setThinkingLevel(level) {
    const prefs = this.getPreferences();
    prefs.thinking_level = level;
    this.savePreferences(prefs);
  }

  /** 读取 primary agent ID */
  getPrimaryAgent() {
    return this.getPreferences().primaryAgent || null;
  }

  /** 保存 primary agent ID */
  savePrimaryAgent(agentId) {
    const prefs = this.getPreferences();
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
