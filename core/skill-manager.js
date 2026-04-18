/**
 * SkillManager — Skill 加载、过滤、per-agent 隔离
 *
 * 管理全量 skill 列表、learned skills 扫描、外部兼容技能扫描、per-agent 隔离过滤。
 * 从 Engine 提取，Engine 通过 manager 访问 skill 状态。
 */
import fs from "fs";
import path from "path";
import chokidar from "chokidar";
import { parseSkillMetadata } from "../lib/skills/skill-metadata.js";

export class SkillManager {
  /**
   * @param {object} opts
   * @param {string} opts.skillsDir - 全局 skills 目录
   * @param {Array<{ dirPath: string, label: string }>} [opts.externalPaths] - 外部兼容技能目录
   */
  constructor({ skillsDir, externalPaths = [] }) {
    this.skillsDir = skillsDir;
    this._allSkills = [];
    this._hiddenSkills = new Set();
    this._watcher = null;
    this._reloadTimer = null;
    this._reloadDeps = null; // { resourceLoader, agents, onReloaded }
    this._externalPaths = externalPaths;
    this._externalWatchers = new Map();
  }

  /** 全量 skill 列表 */
  get allSkills() { return this._allSkills; }

  /**
   * 首次加载：从 resourceLoader 获取内置 skills + 合并所有 agent 的 learned skills + 外部技能
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
    this._appendExternalSkills();
  }

  /** 将 agent 启用的 skill 同步到 agent 的 system prompt */
  syncAgentSkills(agent) {
    const enabled = new Set(agent?.config?.skills?.enabled || []);
    const skills = this._allSkills.filter(s => this._isRuntimeEnabledForAgent(s, enabled));
    agent.setEnabledSkills(skills);
  }

  /** 返回全量 skill 列表（供 API 使用），附带指定 agent 的 enabled 状态。Plugin skill 不返回（UI 不显示） */
  getAllSkills(agent) {
    const enabled = new Set(agent?.config?.skills?.enabled || []);
    return this._allSkills.filter(s => !s._pluginSkill && !s._workspaceSkill).map(s => ({
      name: s.name,
      description: s.description,
      filePath: s.filePath,
      baseDir: s.baseDir,
      source: s.source,
      hidden: !!s._hidden,
      enabled: enabled.has(s.name),
      externalLabel: s._externalLabel || null,
      externalPath: s._externalPath || null,
      readonly: !!s._readonly,
    }));
  }

  /** 返回运行时 skill 列表（含 workspace skill），供 desk / slash 等 session 视图使用 */
  getRuntimeSkillInfos(agent) {
    const enabled = new Set(agent?.config?.skills?.enabled || []);
    return this._allSkills.filter(s => !s._pluginSkill).map(s => ({
      name: s.name,
      description: s.description,
      filePath: s.filePath,
      baseDir: s.baseDir,
      source: s._workspaceSkill ? "workspace" : s.source,
      hidden: !!s._hidden,
      enabled: this._isRuntimeEnabledForAgent(s, enabled),
      externalLabel: s._externalLabel || null,
      externalPath: s._externalPath || null,
      readonly: !!s._readonly,
      managedBy: s._managedBy || null,
    }));
  }

  /** 按 agent 过滤可用 skills（learned skills 有 per-agent 隔离） */
  getSkillsForAgent(targetAgent) {
    const enabled = new Set(targetAgent?.config?.skills?.enabled || []);
    const agentId = targetAgent ? path.basename(targetAgent.agentDir) : null;
    return {
      skills: this._allSkills.filter(s =>
        this._isRuntimeEnabledForAgent(s, enabled)
        && (!s._agentId || s._agentId === agentId)
      ),
      diagnostics: [],
    };
  }

  /**
   * 计算新建 agent 的默认 enabled skill 集合:
   * 所有 source 不是 learned 不是 external 的 skill 的 name。
   * plugin/workspace 通过 _isRuntimeEnabledForAgent 的 bypass 自动启用,
   * 不需要写入 enabled 数组。
   */
  computeDefaultEnabledForNewAgent() {
    return this._allSkills
      .filter(s => s.source !== "learned" && s.source !== "external")
      .map(s => s.name);
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
    this._appendExternalSkills();
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
      this._watcher = chokidar.watch(this.skillsDir, {
        ignoreInitial: true,
        ignored: [/(^|[/\\])\./, /[~#]$/],
        persistent: true,
      });
      this._watcher.on("all", () => {
        if (this._reloadTimer) clearTimeout(this._reloadTimer);
        this._reloadTimer = setTimeout(() => this._autoReload(), 1000);
      });
      this._watcher.on("error", (err) => {
        console.error("[skill-manager] watcher error:", err.message);
      });
    } catch (err) {
      console.error("[skill-manager] failed to create watcher:", err.message);
    }
    this._watchExternalPaths();
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
    this._closeExternalWatchers();
  }

  /**
   * 更新外部路径，重新扫描外部 skill，重建 watcher
   * @param {Array<{ dirPath: string, label: string, scope?: string }>} paths
   */
  setExternalPaths(paths) {
    this._externalPaths = paths;
    this._appendExternalSkills();
    this._closeExternalWatchers();
    if (this._reloadDeps) {
      this._watchExternalPaths();
    }
  }

  // ── 外部技能扫描 ──

  /**
   * 扫描所有外部路径下的技能
   * @returns {Array} 外部技能列表
   */
  scanExternalSkills() {
    const results = [];
    for (const { dirPath, label, scope } of this._externalPaths) {
      if (!fs.existsSync(dirPath)) continue;
      try {
        for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const skillFile = path.join(dirPath, entry.name, "SKILL.md");
          if (!fs.existsSync(skillFile)) continue;
          try {
            const content = fs.readFileSync(skillFile, "utf-8");
            const meta = parseSkillMetadata(content, entry.name);
            results.push({
              name: meta.name,
              description: meta.description,
              filePath: skillFile,
              baseDir: path.join(dirPath, entry.name),
              source: "external",
              disableModelInvocation: meta.disableModelInvocation,
              _agentId: null,
              _hidden: false,
              _externalLabel: label,
              _externalPath: dirPath,
              _readonly: true,
              _pluginSkill: label.startsWith("plugin:"),
              _workspaceSkill: scope === "workspace",
              _managedBy: scope === "workspace" ? "workspace" : null,
            });
          } catch {}
        }
      } catch {}
    }
    return results;
  }

  /** 将外部技能追加到 _allSkills（去重：内部优先，先清理旧 external 再重扫） */
  _appendExternalSkills() {
    this._allSkills = this._allSkills.filter(s => s.source !== "external");
    const existingNames = new Set(this._allSkills.map(s => s.name));
    for (const ext of this.scanExternalSkills()) {
      if (!existingNames.has(ext.name)) {
        this._allSkills.push(ext);
        existingNames.add(ext.name);
      }
    }
  }

  // ── 外部路径 watcher ──

  _watchExternalPaths() {
    for (const { dirPath, scope } of this._externalPaths) {
      if (!fs.existsSync(dirPath)) continue;
      if (this._externalWatchers.has(dirPath)) continue;
      try {
        // workspace 下的 skill 目录本身就在 .agents/.claude 等隐藏目录里，
        // 不能用全局 dot ignore，否则 dirPath 内的所有文件都会被 chokidar 吞掉。
        // 改为相对 dirPath 的 ignore 判断，允许 dirPath 自身及其直接子目录，
        // 只屏蔽子目录内部的隐藏文件（如 .DS_Store）和编辑器临时文件。
        const ignored = scope === "workspace"
          ? (absPath) => {
              const rel = path.relative(dirPath, absPath);
              if (!rel || rel === "") return false;
              return /(^|[/\\])\./.test(rel) || /[~#]$/.test(rel);
            }
          : [/(^|[/\\])\./, /[~#]$/];
        const w = chokidar.watch(dirPath, {
          ignoreInitial: true,
          ignored,
          persistent: true,
        });
        w.on("all", () => {
          if (this._reloadTimer) clearTimeout(this._reloadTimer);
          this._reloadTimer = setTimeout(() => this._autoReload(), 1000);
        });
        w.on("error", (err) => {
          console.error(`[skill-manager] external watcher error (${dirPath}):`, err.message);
        });
        this._externalWatchers.set(dirPath, w);
      } catch (err) {
        console.error(`[skill-manager] failed to watch external path (${dirPath}):`, err.message);
      }
    }
  }

  _closeExternalWatchers() {
    for (const [, w] of this._externalWatchers) {
      try { w.close(); } catch {}
    }
    this._externalWatchers.clear();
  }

  _isRuntimeEnabledForAgent(skill, enabledSet) {
    return !!(
      skill?._pluginSkill
      || skill?._workspaceSkill
      || enabledSet?.has(skill.name)
    );
  }

  // ── 自学技能扫描 ──

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
        const meta = parseSkillMetadata(content, entry.name);
        results.push({
          name: meta.name,
          description: meta.description,
          filePath: skillFile,
          baseDir: path.join(learnedDir, entry.name),
          source: "learned",
          disableModelInvocation: meta.disableModelInvocation,
          _agentId: agentId,
          _hidden: false,
        });
      } catch {}
    }
    return results;
  }
}
