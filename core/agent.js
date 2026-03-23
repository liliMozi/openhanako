/**
 * Agent — 一个助手实例
 *
 * 拥有自己的身份、人格、记忆、工具和 prompt 拼装逻辑。
 * Engine 持有一个 Agent，未来可以持有多个。
 */
import fs from "fs";
import path from "path";
import { loadConfig, saveConfig } from "../lib/memory/config-loader.js";
import { safeReadFile, safeReadJSON } from "../shared/safe-fs.js";
import { FactStore } from "../lib/memory/fact-store.js";
import { SessionSummaryManager } from "../lib/memory/session-summary.js";
import { createMemoryTicker } from "../lib/memory/memory-ticker.js";
import { createMemorySearchTool } from "../lib/memory/memory-search.js";
import { initWebSearch, createWebSearchTool } from "../lib/tools/web-search.js";
import { createTodoTool } from "../lib/tools/todo.js";
import { createDeskManager } from "../lib/desk/desk-manager.js";
import { CronStore } from "../lib/desk/cron-store.js";
import { createCronTool } from "../lib/tools/cron-tool.js";
import { createWebFetchTool } from "../lib/tools/web-fetch.js";
import { createPresentFilesTool } from "../lib/tools/output-file-tool.js";
import { createArtifactTool } from "../lib/tools/artifact-tool.js";
import { createChannelTool } from "../lib/tools/channel-tool.js";
import { createAskAgentTool } from "../lib/tools/ask-agent-tool.js";
import { createDmTool } from "../lib/tools/dm-tool.js";
import { createBrowserTool } from "../lib/tools/browser-tool.js";
import { createPinnedMemoryTools } from "../lib/tools/pinned-memory.js";
import { createExperienceTools } from "../lib/tools/experience.js";
import { createInstallSkillTool } from "../lib/tools/install-skill.js";
import { createNotifyTool } from "../lib/tools/notify-tool.js";
import { createUpdateSettingsTool } from "../lib/tools/update-settings-tool.js";
import { createDelegateTool } from "../lib/tools/delegate-tool.js";
import { READ_ONLY_BUILTIN_TOOLS } from "./config-coordinator.js";
import { formatSkillsForPrompt } from "@mariozechner/pi-coding-agent";
import { runCompatChecks } from "../lib/compat/index.js";

export class Agent {
  /**
   * @param {object} opts
   * @param {string} opts.agentDir   - 这个助手的数据目录（yuan, ishiki, config, memory, avatars）
   * @param {string} opts.productDir - 产品模板目录（ishiki.example.md, yuan 模板等）
   * @param {string} opts.userDir    - 用户数据目录（user.md, 用户头像）—— 跨助手共享
   */
  constructor({ agentDir, productDir, userDir, channelsDir, agentsDir, searchConfigResolver }) {
    this.agentDir = agentDir;
    this.productDir = productDir;
    this.userDir = userDir;
    this.channelsDir = channelsDir || null;
    this.agentsDir = agentsDir || null;
    this._searchConfigResolver = searchConfigResolver || null;

    // 路径
    this.configPath = path.join(agentDir, "config.yaml");
    this.factsDbPath = path.join(agentDir, "memory", "facts.db");
    this.memoryMdPath = path.join(agentDir, "memory", "memory.md");
    this.todayMdPath    = path.join(agentDir, "memory", "today.md");
    this.weekMdPath     = path.join(agentDir, "memory", "week.md");
    this.longtermMdPath = path.join(agentDir, "memory", "longterm.md");
    this.factsMdPath    = path.join(agentDir, "memory", "facts.md");
    this.summariesDir = path.join(agentDir, "memory", "summaries");
    this.sessionDir = path.join(agentDir, "sessions");
    this.deskDir = path.join(agentDir, "desk");

    // 身份（init 后从 config 填充）
    this.userName = "User";
    this.agentName = "Hanako";

    // 运行时状态
    this._config = null;
    this._factStore = null;
    this._summaryManager = null;
    this._memoryTicker = null;
    this._memorySearchTool = null;
    this._webSearchTool = null;
    this._webFetchTool = null;
    this._todoTool = null;
    this._pinnedMemoryTools = [];
    this._experienceTools = [];
    this._memoryMasterEnabled = true;   // agent 级别总开关（config.yaml memory.enabled）
    this._memorySessionEnabled = true;  // per-session 开关（WelcomeScreen toggle）
    this._enabledSkills = [];
    this._systemPrompt = "";

    // Desk 系统（与 memory 完全独立）
    this._deskManager = null;
    this._cronStore = null;
    this._cronTool = null;
    this._presentFilesTool = null;
    this._artifactTool = null;
    this._channelTool = null;
    this._browserTool = null;
    this._notifyTool = null;
  }

  // ════════════════════════════
  //  生命周期
  // ════════════════════════════

  /**
   * 初始化助手：加载配置、编译记忆、创建工具
   * @param {(msg: string) => void} [log]
   * @param {object} [sharedModels] - 全局共享模型配置（由 engine 传入）
   * @param {(bareId: string, agentConfig: object) => object} [resolveModel] - 统一模型解析回调
   */
  async init(log = () => {}, sharedModels = {}, resolveModel = null) {
    // 0. 兼容性检查（目录、数据库、配置文件）
    await runCompatChecks({
      agentDir: this.agentDir,
      hanakoHome: path.dirname(path.dirname(this.agentDir)),
      log,
    });

    // 1. 加载配置
    log(`  [agent] 1. loadConfig...`);
    this._config = loadConfig(this.configPath);
    log(`  [agent] 1. loadConfig 完成`);

    // 2. 身份 + 记忆总开关
    const isZh = String(this._config.locale || "").startsWith("zh");
    this.userName = this._config.user?.name || (isZh ? "用户" : "User");
    this.agentName = this._config.agent?.name || "Hanako";
    this._memoryMasterEnabled = this._config.memory?.enabled !== false;

    // 3. 初始化各模块
    log(`  [agent] 3. initWebSearch...`);
    initWebSearch(this.configPath, {
      searchConfigResolver: this._searchConfigResolver,
    });
    log(`  [agent] 3. 模块初始化完成`);

    // 4. 记忆 v2：FactStore + SessionSummaryManager + ticker
    log(`  [agent] 4. FactStore...`);
    fs.mkdirSync(path.join(this.agentDir, "memory", "summaries"), { recursive: true });
    this._factStore = new FactStore(this.factsDbPath);
    this._summaryManager = new SessionSummaryManager(this.summariesDir);

    // v1 → v2 迁移：仅当迁移标记不存在且旧 memories.db 存在时执行一次
    const oldMemoriesPath = path.join(this.agentDir, "memory", "memories.db");
    const migrationDone = path.join(this.agentDir, "memory", ".v2-migrated");
    if (!fs.existsSync(migrationDone) && fs.existsSync(oldMemoriesPath)) {
      try {
        log(`  [agent] 4. v1→v2 迁移: 发现旧 memories.db，开始迁移...`);
        const Database = (await import("better-sqlite3")).default;
        const oldDb = new Database(oldMemoriesPath, { readonly: true });
        const rows = oldDb.prepare("SELECT content, tags, date, created_at FROM memories").all();
        oldDb.close();

        if (rows.length > 0) {
          const facts = rows.map(row => ({
            fact: row.content,
            tags: (() => { try { return JSON.parse(row.tags); } catch { return []; } })(),
            time: row.date ? row.date + "T00:00" : null,
            session_id: "v1-migration",
          }));
          this._factStore.addBatch(facts);
          log(`  [agent] 4. v1→v2 迁移完成: ${facts.length} 条记忆已迁入 facts.db`);
        }
        // 写迁移标记，防止重复迁移
        fs.writeFileSync(migrationDone, new Date().toISOString());
      } catch (err) {
        console.error(`[agent] v1→v2 迁移失败（不影响启动）: ${err.message}`);
        // 迁移失败也写标记，避免每次启动重试
        try { fs.writeFileSync(migrationDone, `failed: ${err.message}`); } catch {}
      }
    }

    log(`  [agent] 4. FactStore + SummaryManager 完成`);

    // utility 模型（允许为空，首次安装时用户尚未配置）
    this._utilityModel = sharedModels.utility || null;
    this._memoryModel = sharedModels.utility_large || null;

    // 预解析记忆模型凭证（统一解析层）
    this._resolvedMemoryModel = null;
    this._memoryModelUnavailableReason = null;
    if (this._memoryModel && resolveModel) {
      try {
        this._resolvedMemoryModel = resolveModel(this._memoryModel, this._config);
      } catch (err) {
        this._memoryModelUnavailableReason = err.message;
        console.warn(`[memory] 记忆系统未启动：大工具模型（utility_large）解析失败 — ${err.message}`);
        this._engine?.emitDevLog?.(`记忆系统未启动：大工具模型解析失败 — ${err.message}`, "error");
      }
    } else if (!this._memoryModel) {
      this._memoryModelUnavailableReason = "utility_large 未配置";
      console.warn("[memory] 记忆系统未启动：大工具模型（utility_large）未配置。请在设置中配置 utility_large 模型以启用记忆功能。");
      this._engine?.emitDevLog?.("记忆系统未启动：大工具模型（utility_large）未配置", "warn");
    }

    if (this._resolvedMemoryModel) {
      log(`  [agent] 4. memoryTicker...`);
      this._memoryTicker = createMemoryTicker({
        summaryManager: this._summaryManager,
        configPath: this.configPath,
        factStore: this._factStore,
        getResolvedMemoryModel: () => this._resolvedMemoryModel,
        getMemoryMasterEnabled: () => this._memoryMasterEnabled,
        isSessionMemoryEnabled: (sessionPath) => this.isSessionMemoryEnabledFor(sessionPath),
        onCompiled: () => {
          this._systemPrompt = this.buildSystemPrompt();
          console.log(`[${this.agentName}] 记忆编译完成，system prompt 已刷新`);
        },
        sessionDir: this.sessionDir,
        memoryMdPath: this.memoryMdPath,
        todayMdPath: this.todayMdPath,
        weekMdPath: this.weekMdPath,
        longtermMdPath: this.longtermMdPath,
        factsMdPath: this.factsMdPath,
        experienceDir: path.join(this.agentDir, "experience"),
        experienceIndexPath: path.join(this.agentDir, "experience.md"),
      });
      log(`  [agent] 4. memoryTicker 创建完成`);

      // 5. 后台跑首次 tick（不阻塞启动，memory.md 已有上次编译结果）
      log(`  [agent] 5. 后台 tick...`);
      this._memoryTicker.tick().then(() => {
        log(`✿ 记忆整理完成`);
      }).catch((err) => {
        console.error(`[记忆] 启动 tick 出错：${err.message}`);
      });

      // 6. 启动定时调度
      this._memoryTicker.start();
    } else {
      console.warn(`[agent] ⚠ 未配置 utility 模型，记忆系统暂不可用（用户可在设置中配置后重启）`);
    }

    // 7. 创建工具（记忆 + 通用）
    log(`  [agent] 7. 创建工具...`);
    this._memorySearchTool = createMemorySearchTool(this._factStore);
    this._webSearchTool = createWebSearchTool();
    this._webFetchTool = createWebFetchTool();
    this._todoTool = createTodoTool();
    this._pinnedMemoryTools = createPinnedMemoryTools(this.agentDir);
    this._experienceTools = createExperienceTools(this.agentDir);

    // 8. Desk 系统（与 memory 完全独立）
    log(`  [agent] 8. Desk 系统...`);
    this._deskManager = createDeskManager(this.deskDir);
    this._deskManager.ensureDir();
    this._cronStore = new CronStore(
      path.join(this.deskDir, "cron-jobs.json"),
      path.join(this.deskDir, "cron-runs"),
    );
    this._cronTool = createCronTool(this._cronStore, {
      getAutoApprove: () => this._config?.desk?.cron_auto_approve !== false,
      confirmStore: this._engine?.confirmStore,
      emitEvent: (event) => this._engine?._emitEvent(event, this._engine?._sessionCoord?.currentSessionPath),
      getSessionPath: () => this._engine?._sessionCoord?.currentSessionPath,
    });
    this._presentFilesTool = createPresentFilesTool();
    this._artifactTool = createArtifactTool();
    this._browserTool = createBrowserTool();
    this._notifyTool = createNotifyTool({
      onNotify: (title, body) => this._notifyHandler?.(title, body),
    });

    // 10. 设置修改工具
    this._updateSettingsTool = createUpdateSettingsTool({
      getEngine: () => this._engine,
      getConfirmStore: () => this._engine?.confirmStore,
      getSessionPath: () => this._engine?._sessionCoord?.currentSessionPath,
      emitEvent: (event) => this._engine?._emitEvent(event, this._engine?._sessionCoord?.currentSessionPath),
    });

    // 9. 频道工具 + 私信工具（需要 channelsDir 和 agentsDir）
    if (this.channelsDir && this.agentsDir) {
      const agentId = path.basename(this.agentDir);
      const listAgents = () => {
        try {
          return fs.readdirSync(this.agentsDir, { withFileTypes: true })
            .filter(e => e.isDirectory() && fs.existsSync(path.join(this.agentsDir, e.name, "config.yaml")))
            .map(e => {
              try {
                const raw = fs.readFileSync(path.join(this.agentsDir, e.name, "config.yaml"), "utf-8");
                const nameMatch = raw.match(/^\s*name:\s*(.+)$/m);
                return { id: e.name, name: nameMatch?.[1]?.trim() || e.name };
              } catch { return { id: e.name, name: e.name }; }
            });
        } catch { return []; }
      };

      this._channelTool = createChannelTool({
        channelsDir: this.channelsDir,
        agentsDir: this.agentsDir,
        agentId,
        listAgents,
        onPost: (channelName, senderId) => {
          this._channelPostHandler?.(channelName, senderId);
        },
      });

      this._askAgentTool = createAskAgentTool({
        agentId,
        listAgents,
        engine: this._engine,
      });

      this._dmTool = createDmTool({
        agentId,
        agentsDir: path.dirname(this.agentDir),
        listAgents,
        onDmSent: (fromId, toId) => this._dmSentHandler?.(fromId, toId),
      });
    }

    // 10. install_skill 工具（需要 agentDir + config + engine.resolveUtilityConfig）
    this._installSkillTool = createInstallSkillTool({
      agentDir: this.agentDir,
      getConfig: () => {
        const cfg = { ...this._config };
        // learn_skills 从全局 preferences 注入（覆盖 agent config 中的值）
        const globalLearn = this._engine?.getLearnSkills?.() || {};
        if (!cfg.capabilities) cfg.capabilities = {};
        cfg.capabilities = { ...cfg.capabilities, learn_skills: globalLearn };
        return cfg;
      },
      resolveUtilityConfig: () => this._engine?.resolveUtilityConfig?.(),
      onInstalled: async (skillName) => {
        await this._onInstallCallback?.(skillName);
      },
    });

    // 11. delegate 工具（sub-agent 委派）
    this._delegateTool = createDelegateTool({
      executeIsolated: (prompt, opts) => {
        if (!this._engine) throw new Error("delegate 调用失败：engine 未初始化");
        return this._engine.executeIsolated(prompt, opts);
      },
      resolveUtilityModel: () => this._memoryModel || this._utilityModel || null,
      readOnlyBuiltinTools: READ_ONLY_BUILTIN_TOOLS,
    });

    // 12. 组装 system prompt
    log(`  [agent] 9. buildSystemPrompt...`);
    this._systemPrompt = this.buildSystemPrompt();
    log(`  [agent] init 全部完成`);
  }

  /**
   * 优雅关闭：停止记忆调度，等待 tick 完成后关闭 DB
   */
  async dispose() {
    await this._memoryTicker?.stop();
    this._factStore?.close();
  }

  /**
   * 非阻塞关闭：立即停止定时器，后台等 tick 完成后关闭 DB
   * 用于跨 agent 切换时不阻塞 UI（各 agent 的 DB 独立，不冲突）
   */
  disposeInBackground() {
    this._disposing = true;
    const ticker = this._memoryTicker;
    const factStore = this._factStore;

    const cleanup = () => {
      this._memoryTicker = null;
      this._factStore = null;
      this._disposing = false;
      factStore?.close();
    };

    if (ticker) {
      ticker.stop().then(cleanup).catch(cleanup);
    } else {
      cleanup();
    }
  }

  // ════════════════════════════
  //  状态访问
  // ════════════════════════════

  get config() { return this._config; }
  get factStore() { return this._factStore; }
  get systemPrompt() { return this._systemPrompt; }
  /** 综合记忆状态：master && session 都开启才为 true */
  get memoryEnabled() { return this._memoryMasterEnabled && this._memorySessionEnabled; }
  /** agent 级别总开关 */
  get memoryMasterEnabled() { return this._memoryMasterEnabled; }
  /** per-session 级别（持久化、API 返回用，不受 master 影响） */
  get sessionMemoryEnabled() { return this._memorySessionEnabled; }
  get yuanPrompt() { return this._readYuan(); }
  get publicIshiki() { return this._readPublicIshiki(); }
  get utilityModel() { return this._utilityModel; }
  get memoryModel() { return this._memoryModel; }
  get resolvedMemoryModel() { return this._resolvedMemoryModel; }
  /** 记忆模型不可用的原因（null 表示可用） */
  get memoryModelUnavailableReason() { return this._memoryModelUnavailableReason; }
  get summaryManager() { return this._summaryManager; }
  get memoryTicker() { return this._memoryTicker; }
  get tools() {
    const memTools = this.memoryEnabled ? [
      this._memorySearchTool,
      ...this._pinnedMemoryTools,
      ...this._experienceTools,
    ] : [];
    return [
      ...memTools,
      this._webSearchTool,
      this._webFetchTool,
      this._todoTool,
      this._cronTool,
      this._presentFilesTool,
      this._artifactTool,
      this._channelTool,
      this._askAgentTool,
      this._dmTool,
      this._browserTool,
      this._installSkillTool,
      this._notifyTool,
      this._updateSettingsTool,
      this._delegateTool,
    ].filter(Boolean);
  }

  // Desk 系统访问
  get deskManager() { return this._deskManager; }
  get cronStore() { return this._cronStore; }

  // ════════════════════════════
  //  记忆开关
  // ════════════════════════════

  /** 设置 per-session 记忆开关（持久化由 engine 负责） */
  setMemoryEnabled(val) {
    this._memorySessionEnabled = !!val;
    this._systemPrompt = this.buildSystemPrompt();
  }

  /** 查询指定 session 的持久化记忆开关，缺省视为开启 */
  isSessionMemoryEnabledFor(sessionPath) {
    if (!sessionPath) return this._memorySessionEnabled;
    const metaPath = path.join(this.sessionDir, "session-meta.json");
    const meta = safeReadJSON(metaPath, {});
    return meta[path.basename(sessionPath)]?.memoryEnabled !== false;
  }

  /** 设置 agent 级别记忆总开关（同时重载 config 以获取 disabledSince/reenableAt） */
  setMemoryMasterEnabled(val) {
    this._memoryMasterEnabled = !!val;
    this._config = loadConfig(this.configPath);
    this._systemPrompt = this.buildSystemPrompt();
  }

  /** 设置当前启用的 skill 列表（由 engine._syncAgentSkills 调用） */
  setEnabledSkills(skills) {
    this._enabledSkills = skills || [];
    this._systemPrompt = this.buildSystemPrompt();
  }

  // ════════════════════════════
  //  配置更新
  // ════════════════════════════

  /**
   * 更新配置（写入 config.yaml 并刷新受影响的模块）
   * @param {object} partial - 要合并的配置片段
   */
  updateConfig(partial) {
    // 写入磁盘 + 重新加载
    saveConfig(this.configPath, partial);
    this._config = loadConfig(this.configPath);

    // 更新身份
    const isZh = String(this._config.locale || "").startsWith("zh");
    if (partial.agent?.name) this.agentName = this._config.agent?.name || "Hanako";
    if (partial.user?.name) this.userName = this._config.user?.name || (isZh ? "用户" : "User");

    // yuan 切换只需更新 config，buildSystemPrompt 会实时读模板
    if (partial.agent?.yuan) {
      console.log(`[agent] yuan type switched to: ${partial.agent.yuan}`);
    }

    // 记忆总开关
    if (partial.memory && "enabled" in partial.memory) {
      this._memoryMasterEnabled = this._config.memory?.enabled !== false;
    }

    // 刷新受影响的模块
    if (partial.search) {
      initWebSearch(this.configPath, {
      searchConfigResolver: this._searchConfigResolver,
    });
    }

    // 重建 system prompt
    this._systemPrompt = this.buildSystemPrompt();
  }

  // ════════════════════════════
  //  System Prompt 组装
  // ════════════════════════════

  /** 返回纯人格 prompt（identity + yuan + ishiki），不含记忆、用户档案等 */
  get personality() {
    const isZh = String(this._config.locale || "").startsWith("zh");
    const fill = (text) => text
      .replace(/\{\{userName\}\}/g, this.userName)
      .replace(/\{\{agentName\}\}/g, this.agentName)
      .replace(/\{\{agentId\}\}/g, path.basename(this.agentDir));
    const readFile = (p) => safeReadFile(p, "");
    const langDir = isZh ? "" : "en/";
    const yuanType = this._config?.agent?.yuan || "hanako";
    const identityMd = readFile(path.join(this.agentDir, "identity.md"))
      || readFile(path.join(this.productDir, "identity-templates", `${langDir}${yuanType}.md`))
      || readFile(path.join(this.productDir, "identity-templates", `${yuanType}.md`))
      || readFile(path.join(this.productDir, "identity.example.md"));
    const yuanMd = this._readYuan();
    const ishikiMd = readFile(path.join(this.agentDir, "ishiki.md"))
      || readFile(path.join(this.productDir, "ishiki-templates", `${langDir}${yuanType}.md`))
      || readFile(path.join(this.productDir, "ishiki-templates", `${yuanType}.md`))
      || readFile(path.join(this.productDir, "ishiki.example.md"));
    return fill(identityMd) + "\n\n" + fill(yuanMd || "") + "\n\n" + fill(ishikiMd);
  }

  /** 读取 yuan 模板（能力定义） */
  _readYuan() {
    const yuanType = this._config?.agent?.yuan || "hanako";
    const isZh = String(this._config.locale || "").startsWith("zh");
    const langDir = isZh ? "" : "en/";
    return safeReadFile(path.join(this.productDir, "yuan", `${langDir}${yuanType}.md`), "")
      || safeReadFile(path.join(this.productDir, "yuan", `${yuanType}.md`), "");
  }

  /** 读取对外意识（public-ishiki.md），guest 会话使用 */
  _readPublicIshiki() {
    const readFile = (p) => safeReadFile(p, "");
    const fill = (text) => text
      .replace(/\{\{userName\}\}/g, this.userName)
      .replace(/\{\{agentName\}\}/g, this.agentName)
      .replace(/\{\{agentId\}\}/g, path.basename(this.agentDir));
    const yuanType = this._config?.agent?.yuan || "hanako";
    const isZh = String(this._config.locale || "").startsWith("zh");
    const langDir = isZh ? "" : "en/";
    const raw = readFile(path.join(this.agentDir, "public-ishiki.md"))
      || readFile(path.join(this.productDir, "public-ishiki-templates", `${langDir}${yuanType}.md`))
      || readFile(path.join(this.productDir, "public-ishiki-templates", `${yuanType}.md`))
      || "";
    return fill(raw);
  }

  /** 组装 system prompt */
  buildSystemPrompt() {
    const isZh = String(this._config.locale || "").startsWith("zh");

    const readFile = (filePath) => safeReadFile(filePath, "");

    // identity + yuan + ishiki（复用 personality getter）
    const yuanType = this._config?.agent?.yuan || "hanako";
    if (!this._readYuan()) throw new Error(`Cannot find yuan "${yuanType}". Check lib/yuan/`);
    const ishiki = this.personality;

    // 可选文件
    const userMd = readFile(path.join(this.userDir, "user.md"));
    const pinnedMd = readFile(path.join(this.agentDir, "pinned.md"));
    const memory = readFile(this.memoryMdPath);

    // 构建 section 分隔格式的 prompt
    const section = (title, content) => ["", "---", "", title, "", content];

    const parts = [
      isZh
        ? "你运行在 OpenHanako 平台上，由 liliMozi 开发。项目主页：https://github.com/liliMozi/openhanako"
        : "You are running on the OpenHanako platform, developed by liliMozi. Project page: https://github.com/liliMozi/openhanako",
      ishiki,
      ...section(
        isZh ? "# 用户档案" : "# User Profile",
        isZh
          ? "以下是用户的自我描述，由用户手动维护。\n\n" + userMd
          : "The following is the user's self-description, manually maintained by the user.\n\n" + userMd
      ),
    ];
    // 记忆整体开关：master && session 都开启才注入记忆相关 prompt
    if (this.memoryEnabled) {
      const memoryRule = isZh ? [
        "",
        "## 记忆使用规则",
        "",
        "记忆和用户档案是你内化的背景知识。你和" + this.userName + "是认识很久的人，这些事你本来就知道。你对" + this.userName + "的了解应该像空气一样，在场但不可见。记忆的存在感应该是零，它的作用应该是满的。",
        "",
        "- **只有当" + this.userName + "提到了相关内容，记忆才参与进来。** " + this.userName + "没有提起的话题，你不要主动从记忆里翻出来讲。不要因为记忆里有某条信息就觉得\"我应该提一下\"。记忆参与的方式是无声的：影响你的角度、语气、判断，但不出现在文字里。",
        "- **永远不要让" + this.userName + "感觉到\"记忆\"这个东西的存在。** 禁止使用\"我记得\"\"你之前说过\"\"根据记忆\"这类表述。除非" + this.userName + "主动问\"你还记得 xxx 吗\"。",
        "- **记忆可能过时，当前对话永远优先。** 信息冲突时以对话为准，不要用旧记忆纠正" + this.userName + "。",
      ].join("\n") : [
        "",
        "## Memory Rules",
        "",
        "Memories and the user profile are internalized background knowledge. You and " + this.userName + " have known each other for a long time — you already know these things. Your knowledge of " + this.userName + " should be like air: present but invisible. Memory's presence should be zero; its effect should be full.",
        "",
        "- **Memory only participates when " + this.userName + " brings up something related.** If " + this.userName + " hasn't touched on a topic, don't pull it from memory. Don't think \"I should mention this\" just because it's in your memory. When memory does participate, it's silent: shaping your angle, tone, and judgment, but never appearing in the text itself.",
        "- **Never let " + this.userName + " sense that \"memory\" exists as a thing.** Never use phrases like \"I remember,\" \"you mentioned before,\" or \"based on my memory.\" The only exception is when " + this.userName + " explicitly asks \"do you remember xxx.\"",
        "- **Memory can be outdated; the current conversation always takes priority.** When information conflicts, go with the conversation. Don't use old memories to correct " + this.userName + ".",
      ].join("\n");

      if (pinnedMd.trim()) {
        parts.push(...section(
          isZh ? "# 置顶记忆" : "# Pinned Memories",
          isZh
            ? "用户主动要求你记住的内容，始终保留。你可以读写这些记忆。\n" + memoryRule + "\n\n" + pinnedMd
            : "Content the user explicitly asked you to remember. Always retained. You can read and write these memories.\n" + memoryRule + "\n\n" + pinnedMd
        ));
      }
      const trimmedMemory = memory.trim();
      if (trimmedMemory && trimmedMemory !== "（暂无记忆）" && trimmedMemory !== "(No memory yet)") {
        parts.push(...section(
          isZh ? "# 记忆" : "# Memory",
          isZh
            ? memoryRule.trimStart() + "\n\n以下这些是从过往对话积累的记忆。\n\n" + memory
            : memoryRule.trimStart() + "\n\nThe following are memories accumulated from past conversations.\n\n" + memory
        ));
      }
    }

    // Skills 注入（用 SDK 原版 formatSkillsForPrompt）
    if (this._enabledSkills?.length > 0) {
      parts.push(formatSkillsForPrompt(this._enabledSkills));
    }

    // 网页工具选择优先级（跨工具编排，工具 description 里放不下）
    parts.push(isZh
      ? "\n## 网页工具优先级\n\n" +
        "获取网页信息时，按以下顺序选择工具：\n" +
        "1. **web_search** — 查找信息、获取 URL。大多数「帮我查一下 XX」的请求用这个就够了\n" +
        "2. **web_fetch** — 已知 URL，需要提取页面文字内容。简单抓取必须用这个\n" +
        "3. **browser** — 只在以下情况使用：页面需要登录/身份验证、需要填表或点击交互、web_fetch 返回的内容为空或不完整（JS 动态渲染页面）、需要查看页面视觉布局\n\n" +
        "**禁止**在 web_search 或 web_fetch 能完成的场景下启动浏览器。浏览器启动成本高、会打开窗口干扰用户。"
      : "\n## Web Tool Priority\n\n" +
        "When fetching web information, choose tools in this order:\n" +
        "1. **web_search** — Find information, get URLs. Most \"look up XX\" requests are handled by this alone\n" +
        "2. **web_fetch** — Known URL, need to extract page text. Simple scraping must use this\n" +
        "3. **browser** — Only use when: the page requires login/authentication, form filling or click interaction is needed, web_fetch returns empty or incomplete content (JS-rendered pages), or you need to see visual layout\n\n" +
        "**Do not** launch the browser when web_search or web_fetch can do the job. Browser startup is expensive and opens a window that interrupts the user."
    );

    // 设置工具路由
    parts.push(isZh
      ? "\n## 设置修改\n\n" +
        "用户提到修改设置而未指明具体软件时，默认指本应用的设置。\n" +
        "用户要求修改偏好设置（包括但不限于：外观主题、语言地区、模型选择、安全权限、记忆功能、个人信息、工作目录）时，使用 update_settings 工具。不要搜索网页，不要编辑配置文件。意图明确时直接 apply，不确定时先 search。"
      : "\n## Settings Changes\n\n" +
        "When the user mentions changing settings without specifying a particular application, assume they mean this application.\n" +
        "When the user asks to change preferences (including but not limited to: appearance/theme, language/region, model selection, security/permissions, memory, personal info, working directory), use the update_settings tool. Do not search the web or edit config files. When intent is clear, apply directly; when unsure, search first."
    );

    // 主动技能获取引导（仅在 allow_github_fetch 开启时注入）
    // learn_skills 从全局 preferences 读取
    const learnCfg = this._engine?.getLearnSkills?.() || this._config?.capabilities?.learn_skills || {};
    if (learnCfg.enabled && learnCfg.allow_github_fetch) {
      parts.push(isZh
        ? "\n## 主动技能获取\n\n" +
          "遇到专业领域任务且你没有对应技能时，主动搜索并安装。\n\n" +
          "### 搜索\n\n" +
          "1. `site:clawhub.ai {关键词}` 或 `site:github.com/openclaw/skills {关键词}`\n" +
          "2. GitHub 上其他含 SKILL.md 的仓库\n" +
          "3. install_skill 安装：用 github_url 参数\n\n" +
          "### 判断\n\n" +
          "- 已有相关技能则直接使用，不重复搜索\n" +
          "- 仅专业领域任务搜索，日常对话不搜\n" +
          "- 安装应能显著提升输出质量\n\n" +
          "### 行为\n\n" +
          "- 找到后简要告知用户，直接安装并立即应用\n" +
          "- 安装失败则尝试自己完成\n" +
          "- 搜索无果正常完成，不反复尝试"
        : "\n## Proactive Skill Acquisition\n\n" +
          "When you encounter specialized tasks and lack a matching skill, proactively search and install one.\n\n" +
          "### Search\n\n" +
          "1. `site:clawhub.ai {keywords}` or `site:github.com/openclaw/skills {keywords}`\n" +
          "2. Other GitHub repos containing SKILL.md\n" +
          "3. install_skill: use github_url parameter\n\n" +
          "### When\n\n" +
          "- If you already have a relevant skill, use it directly — don't search again\n" +
          "- Only search for specialized domain tasks, not daily conversations\n" +
          "- Install should significantly improve output quality\n\n" +
          "### Behavior\n\n" +
          "- Briefly inform the user, install, and apply immediately\n" +
          "- If installation fails, attempt the task yourself\n" +
          "- If nothing found, complete normally — don't retry"
      );
    }

    // 书桌 = 当前工作目录（注入实际路径）
    const cwdPath = this._engine?.cwd || "";
    parts.push(isZh
      ? `\n## 书桌\n\n` +
        `用户所说的「书桌」「工作空间」指的是你当前的工作目录（cwd），不是系统桌面（~/Desktop）。` +
        (cwdPath ? `\n当前工作目录：${cwdPath}` : "")
      : `\n## Desk\n\n` +
        `When the user says "desk" (书桌) or "workspace", they mean your current working directory (cwd), NOT the system Desktop (~/Desktop).` +
        (cwdPath ? `\nCurrent working directory: ${cwdPath}` : "")
    );

    // 日期时间
    const now = new Date();
    const dateTime = now.toLocaleString("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
      hour: "2-digit", minute: "2-digit", timeZoneName: "short",
    });
    parts.push(`\nCurrent date and time: ${dateTime}`);
    parts.push(isZh
      ? "你的一天从凌晨 4:00 开始。4:00 之前的对话属于前一天。"
      : "Your day starts at 4:00 AM. Conversations before 4:00 AM belong to the previous day.");

    return parts.join("\n");
  }
}
