/**
 * SkillManager — Skill 加载、过滤、per-agent 隔离
 *
 * 管理全量 skill 列表、learned skills 扫描、per-agent 隔离过滤。
 * 从 Engine 提取，Engine 通过 manager 访问 skill 状态。
 */
import fs from "fs";
import path from "path";

export class SkillManager {
  /**
   * @param {object} opts
   * @param {string} opts.skillsDir - 全局 skills 目录
   */
  constructor({ skillsDir }) {
    this.skillsDir = skillsDir;
    this._allSkills = [];
    this._hiddenSkills = new Set();
    this._watcher = null;
    this._reloadTimer = null;
    this._reloadDeps = null; // { resourceLoader, agents, onReloaded }
  }

  /** 全量 skill 列表 */
  get allSkills() { return this._allSkills; }

  /**
   * 首次加载：从 resourceLoader 获取内置 skills + 合并所有 agent 的 learned skills
   * @param {object} resourceLoader - Pi SDK DefaultResourceLoader 实例
   * @param {Map} agents - agent Map
   * @param {Set<string>} hiddenSkills - 需要隐藏的 skill name 集合
   */
  init(resourceLoader, agents, hiddenSkills) {
    this._hiddenSkills = hiddenSkills;
    this._allSkills = resourceLoader.getSkills().skills;
    for (const s of this._allSkills) {
      s._hidden = hiddenSkills.has(s.name);
    }
    for (const [, ag] of agents) {
      this._allSkills.push(...this.scanLearnedSkills(ag.agentDir));
    }
  }

  /** 将 agent 启用的 skill 同步到 agent 的 system prompt */
  syncAgentSkills(agent) {
    const enabled = agent?.config?.skills?.enabled || [];
    const skills = this._allSkills.filter(s => enabled.includes(s.name));
    agent.setEnabledSkills(skills);
  }

  /** 返回全量 skill 列表（供 API 使用），附带指定 agent 的 enabled 状态 */
  getAllSkills(agent) {
    const enabled = agent?.config?.skills?.enabled || [];
    return this._allSkills.map(s => ({
      name: s.name,
      description: s.description,
      filePath: s.filePath,
      baseDir: s.baseDir,
      source: s.source,
      hidden: !!s._hidden,
      enabled: enabled.includes(s.name),
    }));
  }

  /** 按 agent 过滤可用 skills（learned skills 有 per-agent 隔离） */
  getSkillsForAgent(targetAgent) {
    const enabled = targetAgent?.config?.skills?.enabled;
    if (!enabled || enabled.length === 0) {
      return { skills: [], diagnostics: [] };
    }
    const agentId = targetAgent ? path.basename(targetAgent.agentDir) : null;
    return {
      skills: this._allSkills.filter(s =>
        enabled.includes(s.name)
        && (!s._agentId || s._agentId === agentId)
      ),
      diagnostics: [],
    };
  }

  /**
   * 重新加载 skills（安装/删除后调用）
   * @param {object} resourceLoader
   * @param {Map} agents
   */
  async reload(resourceLoader, agents) {
    // 暂时恢复原始 getSkills 以便 reload() 正确扫描
    delete resourceLoader.getSkills;
    await resourceLoader.reload();

    this._allSkills = resourceLoader.getSkills().skills;
    for (const s of this._allSkills) {
      s._hidden = this._hiddenSkills.has(s.name);
    }
    for (const [, ag] of agents) {
      this._allSkills.push(...this.scanLearnedSkills(ag.agentDir));
    }
  }

  /**
   * 监听 skillsDir 变化，自动 reload（debounce 1s）
   * @param {object} resourceLoader
   * @param {Map} agents
   * @param {() => void} onReloaded - reload 完成后的回调（用于 syncAllAgentSkills 等）
   */
  watch(resourceLoader, agents, onReloaded) {
    this._reloadDeps = { resourceLoader, agents, onReloaded };
    if (this._watcher) return;
    try {
      this._watcher = fs.watch(this.skillsDir, { recursive: true }, (_event, filename) => {
        if (filename && (/^\./.test(filename) || /[~#]$/.test(filename))) return;
        if (this._reloadTimer) clearTimeout(this._reloadTimer);
        this._reloadTimer = setTimeout(() => this._autoReload(), 1000);
      });
      this._watcher.on("error", (err) => {
        console.error("[skill-manager] watcher error:", err.message);
      });
    } catch {}
  }

  async _autoReload() {
    const deps = this._reloadDeps;
    if (!deps) return;
    try {
      await this.reload(deps.resourceLoader, deps.agents);
      deps.onReloaded?.();
    } catch (err) {
      console.warn("[skill-manager] auto-reload failed:", err.message);
    }
  }

  /** 停止文件监听 */
  unwatch() {
    if (this._watcher) { this._watcher.close(); this._watcher = null; }
    if (this._reloadTimer) { clearTimeout(this._reloadTimer); this._reloadTimer = null; }
    this._reloadDeps = null;
  }

  /**
   * 扫描 agentDir/learned-skills/ 下的自学 skills
   * @param {string} agentDir
   */
  scanLearnedSkills(agentDir) {
    const agentId = path.basename(agentDir);
    const learnedDir = path.join(agentDir, "learned-skills");
    if (!fs.existsSync(learnedDir)) return [];
    const results = [];
    for (const entry of fs.readdirSync(learnedDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(learnedDir, entry.name, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;
      try {
        const content = fs.readFileSync(skillFile, "utf-8");
        const descMatch = content.match(/^description:\s*(.+?)\s*$/m);
        const description = descMatch ? descMatch[1].replace(/["']/g, "") : "";
        results.push({
          name: entry.name,
          description,
          filePath: skillFile,
          baseDir: path.join(learnedDir, entry.name),
          source: "learned",
          _agentId: agentId,
          _hidden: false,
        });
      } catch {}
    }
    return results;
  }
}
