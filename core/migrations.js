/**
 * 数据迁移 runner
 *
 * 所有用户数据格式变更集中在此文件。
 * preferences.json._dataVersion 记录已执行到的版本号（整数），
 * 启动时只跑 > _dataVersion 的条目。
 *
 * 添加新迁移：在 migrations 对象末尾加一条，key 为递增整数。
 */
import fs from "fs";
import path from "path";
import YAML from "js-yaml";
import { safeReadYAMLSync } from "../shared/safe-fs.js";
import { saveConfig } from "../lib/memory/config-loader.js";
import {
  getSubagentSessionMetaPath,
  mergeExecutorMetadata,
  normalizeExecutorMetadata,
  readSubagentSessionMetaSync,
} from "../lib/subagent-executor-metadata.js";
import { SessionFileRegistry } from "../lib/session-files/session-file-registry.js";
import { persistBrowserScreenshotFileSync } from "../lib/session-files/browser-screenshot-file.js";

// ── 迁移表 ──────────────────────────────────────────────────────────────────

const migrations = {
  // #356: 清理悬空 provider 引用（agent config + preferences）
  1: cleanDanglingProviderRefs,
  // bridge 配置从全局 preferences 迁移到各 agent 的 config.yaml
  2: migrateBridgeToPerAgent,
  // workspace (home_folder) 从全局 preferences 迁移到主 agent config.yaml
  3: migrateWorkspaceToPerAgent,
  // subagent executor metadata 显式化，避免历史回放依赖目录推断
  4: migrateSubagentExecutorMetadata,
  // models.* 字段全量迁移到 {id, provider} 复合键对象；
  // 裸 id / "provider/id" 字符串统一归一化
  5: migrateModelRefsToCompositeKey,
  // channels.enabled 从 agent scope 错位位置迁到 global preferences；
  // 尊重老用户显式意图：任一 agent 显式 true → 保留开，否则默认关
  6: migrateChannelsToGlobalDefaultOff,
  // 模型能力字段 vision → image 全量重命名（added-models.yaml + agent config.yaml）
  // 配合 core/model-sync.js 和 core/provider-registry.js 的读时兼容形成双保险
  7: migrateVisionToImage,
  // 修复 migration #5 之后仍有入口把 models.* 写回旧字符串格式的问题
  8: repairPostMigrationModelRefs,
  // bridge.readOnly 从 agent scope 收敛回全局 preferences
  9: migrateBridgeReadOnlyToGlobal,
  // summarizer / compiler 角色从未接通业务，删除 preferences 与 agent config 里的残留字段
  10: cleanupSummarizerCompilerRemnants,
  // cron job 的 model 字段补齐为 {id, provider}，修复旧任务只保存裸 id 的问题
  11: repairCronJobModelRefs,
  // 老 session 的文件引用补齐到 session file sidecar；作为最后一步，不重写历史 JSONL
  12: backfillLegacySessionFiles,
};

// ── Runner ──────────────────────────────────────────────────────────────────

/**
 * @param {object} ctx
 * @param {string}   ctx.hanakoHome
 * @param {string}   ctx.agentsDir
 * @param {import('./preferences-manager.js').PreferencesManager} ctx.prefs
 * @param {import('./provider-registry.js').ProviderRegistry}     ctx.providerRegistry
 * @param {Function} ctx.log
 */
export function runMigrations(ctx) {
  const { prefs, log } = ctx;
  const preferences = prefs.getPreferences();
  const currentVersion = preferences._dataVersion || 0;

  const pending = Object.keys(migrations)
    .map(Number)
    .filter(v => v > currentVersion)
    .sort((a, b) => a - b);

  if (!pending.length) return;

  log(`[migrations] _dataVersion=${currentVersion}，待执行 ${pending.length} 条迁移`);

  for (const v of pending) {
    try {
      migrations[v](ctx);
      log(`[migrations] #${v} 完成`);
    } catch (err) {
      console.error(`[migrations] #${v} 失败: ${err.message}`);
      // 失败则停在当前版本，不继续后续迁移
      break;
    }
    // 每跑完一条就持久化版本号，防止中途崩溃导致重跑已成功的迁移
    const fresh = prefs.getPreferences();
    fresh._dataVersion = v;
    prefs.savePreferences(fresh);
  }
}

// ── 迁移实现 ─────────────────────────────────────────────────────────────────

/**
 * #1 — 清理悬空 provider 引用
 *
 * 用户删除 provider 后，agent config.yaml 和 preferences.json 中
 * 可能残留指向已不存在 provider 的引用，导致启动时模型解析失败。
 * 本迁移扫描所有引用位置，将悬空引用清空。
 */
function cleanDanglingProviderRefs(ctx) {
  const { agentsDir, prefs, providerRegistry, log } = ctx;

  const providerExists = (id) => !!providerRegistry.get(id);

  // ── 1. Agent config.yaml ──

  let agentDirs;
  try {
    agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter(d => d.isDirectory());
  } catch { return; }

  for (const dir of agentDirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    const config = safeReadYAMLSync(cfgPath, null, YAML);
    if (!config) continue;

    let changed = false;

    // api.provider / embedding_api.provider / utility_api.provider
    for (const block of ["api", "embedding_api", "utility_api"]) {
      const provider = config[block]?.provider;
      if (provider && !providerExists(provider)) {
        config[block].provider = "";
        changed = true;
        log(`[migrations] ${dir.name}: ${block}.provider "${provider}" 不存在，已清空`);
      }
    }

    // models.* — 字符串 "provider/model" 或 { id, provider } 对象
    if (config.models) {
      for (const role of ["chat", "utility", "utility_large", "embedding"]) {
        const ref = config.models[role];
        if (!ref) continue;

        if (typeof ref === "object" && ref.provider && !providerExists(ref.provider)) {
          config.models[role] = "";
          changed = true;
          log(`[migrations] ${dir.name}: models.${role}.provider "${ref.provider}" 不存在，已清空`);
        } else if (typeof ref === "string" && ref.includes("/")) {
          const provider = ref.slice(0, ref.indexOf("/"));
          if (!providerExists(provider)) {
            config.models[role] = "";
            changed = true;
            log(`[migrations] ${dir.name}: models.${role} "${ref}" provider 不存在，已清空`);
          }
        }
      }
    }

    if (changed) {
      const tmp = cfgPath + ".tmp";
      fs.writeFileSync(tmp, YAML.dump(config, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: '"' }), "utf-8");
      fs.renameSync(tmp, cfgPath);
    }
  }

  // ── 2. Preferences ──

  const preferences = prefs.getPreferences();
  let prefsChanged = false;

  // 共享模型字段：utility_model, utility_large_model
  for (const key of ["utility_model", "utility_large_model"]) {
    const val = preferences[key];
    if (!val) continue;

    if (typeof val === "object" && val.provider && !providerExists(val.provider)) {
      preferences[key] = null;
      prefsChanged = true;
      log(`[migrations] preferences.${key}.provider "${val.provider}" 不存在，已清空`);
    } else if (typeof val === "string" && val.includes("/")) {
      const provider = val.slice(0, val.indexOf("/"));
      if (!providerExists(provider)) {
        preferences[key] = null;
        prefsChanged = true;
        log(`[migrations] preferences.${key} "${val}" provider 不存在，已清空`);
      }
    }
  }

  // utility_api_provider
  if (preferences.utility_api_provider && !providerExists(preferences.utility_api_provider)) {
    log(`[migrations] preferences.utility_api_provider "${preferences.utility_api_provider}" 不存在，已清空`);
    preferences.utility_api_provider = null;
    prefsChanged = true;
  }

  if (prefsChanged) {
    prefs.savePreferences(preferences);
  }
}

/**
 * #2 — bridge 配置从全局 preferences 迁移到 per-agent config.yaml
 *
 * preferences.json 中的 bridge.telegram / feishu / qq / wechat / whatsapp
 * 各自可能带 agentId 字段指定归属 agent。迁移后每个 platform config
 * 写入对应 agent 的 config.yaml，owner 信息一并合入。
 * bridge.readOnly / receiptEnabled 保留为全局偏好。
 */
function migrateBridgeToPerAgent(ctx) {
  const { agentsDir, prefs, log } = ctx;
  const preferences = prefs.getPreferences();
  const bridge = preferences.bridge;
  if (!bridge) return; // nothing to migrate

  const primaryAgentId = preferences.primaryAgent || null;
  const ownerDict = bridge.owner || {};
  const readOnly = bridge.readOnly === true;
  const receiptEnabled = bridge.receiptEnabled === false ? false : undefined;

  const PLATFORMS = ["telegram", "feishu", "qq", "wechat", "whatsapp"];
  const agentConfigs = new Map(); // agentId → { platform: config }

  // Find fallback agent: primary if it exists, otherwise first available
  let fallbackAgentId = null;
  if (primaryAgentId) {
    const primaryDir = path.join(agentsDir, primaryAgentId);
    if (fs.existsSync(path.join(primaryDir, "config.yaml"))) {
      fallbackAgentId = primaryAgentId;
    } else {
      log(`[migrations] primaryAgent "${primaryAgentId}" dir/config.yaml not found, scanning for fallback`);
    }
  }
  if (!fallbackAgentId) {
    try {
      const dirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter(d => d.isDirectory());
      for (const d of dirs) {
        if (fs.existsSync(path.join(agentsDir, d.name, "config.yaml"))) {
          fallbackAgentId = d.name;
          break;
        }
      }
    } catch {}
  }

  for (const platform of PLATFORMS) {
    const cfg = bridge[platform];
    if (!cfg) continue;

    // Determine target agent
    let targetAgentId = cfg.agentId || null;
    if (targetAgentId) {
      const agentCfg = path.join(agentsDir, targetAgentId, "config.yaml");
      if (!fs.existsSync(agentCfg)) {
        log(`[migrations] bridge.${platform}.agentId "${targetAgentId}" not found, using fallback`);
        targetAgentId = null;
      }
    }
    if (!targetAgentId) targetAgentId = fallbackAgentId;
    if (!targetAgentId) {
      log(`[migrations] no agent available for bridge.${platform}, skipping`);
      continue;
    }

    if (!agentConfigs.has(targetAgentId)) agentConfigs.set(targetAgentId, {});
    const ac = agentConfigs.get(targetAgentId);

    // Clean config: strip agentId field (now implicit by location)
    const cleanCfg = { ...cfg };
    delete cleanCfg.agentId;

    // Resolve owner: composite key "platform:agentId" > legacy "platform"
    const compositeKey = `${platform}:${targetAgentId}`;
    const owner = ownerDict[compositeKey] || ownerDict[platform] || null;
    if (owner) cleanCfg.owner = owner;

    ac[platform] = cleanCfg;
  }

  // Write to each agent's config.yaml
  for (const [agentId, bridgeConfig] of agentConfigs) {
    const cfgPath = path.join(agentsDir, agentId, "config.yaml");
    if (!fs.existsSync(cfgPath)) {
      log(`[migrations] agent ${agentId} config.yaml not found, skipping`);
      continue;
    }
    saveConfig(cfgPath, { bridge: { ...bridgeConfig } });
    log(`[migrations] migrated bridge config → agent ${agentId} (${Object.keys(bridgeConfig).join(", ")})`);
  }

  // 清理旧的 platform / owner 键，只保留新的全局偏好键
  const nextBridgePrefs = {};
  if (readOnly) nextBridgePrefs.readOnly = true;
  if (receiptEnabled === false) nextBridgePrefs.receiptEnabled = false;
  if (Object.keys(nextBridgePrefs).length > 0) preferences.bridge = nextBridgePrefs;
  else delete preferences.bridge;
  prefs.savePreferences(preferences);
  log(`[migrations] migrated prefs.bridge platform config to agents`);
}

function migrateSubagentExecutorMetadata(ctx) {
  const { agentsDir, hanakoHome, log } = ctx;
  const agentSnapshots = new Map();
  const childSessionCandidates = new Map();

  const agentDirs = (() => {
    try {
      return fs.readdirSync(agentsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && fs.existsSync(path.join(agentsDir, d.name, "config.yaml")));
    } catch {
      return [];
    }
  })();

  for (const dir of agentDirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    const cfg = safeReadYAMLSync(cfgPath, {}, YAML);
    agentSnapshots.set(dir.name, cfg?.agent?.name || dir.name);
  }

  function ownerIdentityFor(agentId) {
    if (!agentId) return null;
    return normalizeExecutorMetadata({
      agentId,
      agentName: agentSnapshots.get(agentId) || agentId,
    });
  }

  function rememberChildSessionIdentity(sessionPath, identity, priority) {
    if (!sessionPath || !identity) return;
    const current = childSessionCandidates.get(sessionPath);
    if (!current || priority > current.priority) {
      childSessionCandidates.set(sessionPath, { identity, priority });
    }
  }

  function inferOwnerAgentId(sessionPath) {
    const rel = path.relative(agentsDir, sessionPath);
    if (rel.startsWith("..")) return null;
    return rel.split(path.sep)[0] || null;
  }

  for (const dir of agentDirs) {
    const agentId = dir.name;
    const sessionDir = path.join(agentsDir, agentId, "sessions");
    let sessionFiles = [];
    try {
      sessionFiles = fs.readdirSync(sessionDir)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => path.join(sessionDir, name));
    } catch {
      sessionFiles = [];
    }

    for (const sessionFile of sessionFiles) {
      let changed = false;
      const outputLines = [];
      let raw = "";
      try {
        raw = fs.readFileSync(sessionFile, "utf-8");
      } catch {
        continue;
      }

      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;

        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          outputLines.push(line);
          continue;
        }

        const msg = entry?.message;
        if (entry?.type !== "message" || msg?.role !== "toolResult" || msg?.toolName !== "subagent" || !msg?.details) {
          outputLines.push(JSON.stringify(entry));
          continue;
        }

        const details = msg.details;
        const explicitIdentity = normalizeExecutorMetadata(details);
        const childSessionPath = details.sessionPath || null;
        const ownerIdentity = ownerIdentityFor(agentId);
        const inferredOwnerIdentity = childSessionPath
          ? ownerIdentityFor(inferOwnerAgentId(childSessionPath))
          : null;
        const identity = explicitIdentity || ownerIdentity || inferredOwnerIdentity;

        if (identity) {
          const before = JSON.stringify(details);
          mergeExecutorMetadata(details, identity);
          if (JSON.stringify(details) !== before) changed = true;
          if (childSessionPath) {
            rememberChildSessionIdentity(childSessionPath, identity, explicitIdentity ? 2 : 1);
          }
        }

        outputLines.push(JSON.stringify(entry));
      }

      if (changed) {
        fs.writeFileSync(sessionFile, outputLines.join("\n") + "\n", "utf-8");
        log(`[migrations] subagent executor metadata patched: ${sessionFile}`);
      }
    }
  }

  for (const dir of agentDirs) {
    const agentId = dir.name;
    const subagentDir = path.join(agentsDir, agentId, "subagent-sessions");
    let childFiles = [];
    try {
      childFiles = fs.readdirSync(subagentDir)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => path.join(subagentDir, name));
    } catch {
      childFiles = [];
    }

    for (const childFile of childFiles) {
      if (!childSessionCandidates.has(childFile)) {
        const sessionMeta = readSubagentSessionMetaSync(childFile);
        const identity = sessionMeta || ownerIdentityFor(agentId);
        rememberChildSessionIdentity(childFile, identity, sessionMeta ? 3 : 0);
      }
    }
  }

  const sidecarWrites = new Map();
  for (const [childSessionPath, { identity }] of childSessionCandidates) {
    if (!identity) continue;
    const metaPath = getSubagentSessionMetaPath(childSessionPath);
    if (!metaPath) continue;
    let meta = sidecarWrites.get(metaPath);
    if (!meta) {
      try {
        meta = fs.existsSync(metaPath)
          ? JSON.parse(fs.readFileSync(metaPath, "utf-8"))
          : {};
      } catch {
        meta = {};
      }
      sidecarWrites.set(metaPath, meta);
    }

    const sessKey = path.basename(childSessionPath);
    meta[sessKey] = {
      ...meta[sessKey],
      ...identity,
    };
  }

  for (const [metaPath, meta] of sidecarWrites) {
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf-8");
    log(`[migrations] subagent session sidecar patched: ${metaPath}`);
  }

  const deferredTasksPath = path.join(hanakoHome, ".ephemeral", "deferred-tasks.json");
  try {
    if (!fs.existsSync(deferredTasksPath)) return;
    const deferredTasks = JSON.parse(fs.readFileSync(deferredTasksPath, "utf-8"));
    let changed = false;
    for (const task of Object.values(deferredTasks)) {
      if (task?.meta?.type !== "subagent") continue;
      const sessionPath = task.meta.sessionPath || null;
      const candidate =
        normalizeExecutorMetadata(task.meta)
        || (sessionPath ? childSessionCandidates.get(sessionPath)?.identity || readSubagentSessionMetaSync(sessionPath) : null)
        || (sessionPath ? ownerIdentityFor(inferOwnerAgentId(sessionPath)) : null);
      if (!candidate) continue;
      const before = JSON.stringify(task.meta);
      mergeExecutorMetadata(task.meta, candidate);
      if (JSON.stringify(task.meta) !== before) changed = true;
    }
    if (changed) {
      fs.mkdirSync(path.dirname(deferredTasksPath), { recursive: true });
      fs.writeFileSync(deferredTasksPath, JSON.stringify(deferredTasks, null, 2) + "\n", "utf-8");
      log(`[migrations] subagent deferred metadata patched: ${deferredTasksPath}`);
    }
  } catch (err) {
    log(`[migrations] deferred task patch skipped: ${err.message}`);
  }
}

/**
 * #5 — models.* 字段全量迁移到 {id, provider} 复合键对象
 *
 * 目标：运行时（非 UI 层）模型引用只有一种合法形态——{id, provider} 对象。
 * 之前历史数据里混存了三种：
 *   1. 裸 id 字符串 "glm-5.1"                 → 通过 added-models.yaml 推断 provider
 *   2. "provider/id" 字符串 "zhipu/glm-5.1"   → 拆成 {id, provider}
 *   3. {id, provider: ""} 半成品对象          → 视作裸 id 推断
 *
 * 作用范围：
 *   - 每个 agent 目录下 config.yaml 里的 models.{chat,utility,utility_large}
 *     （embedding 角色不在复合键范围内——走 embedding_api 独立配置）
 *   - preferences.json 的 {utility,utility_large}_model
 *
 * 推断规则：
 *   - "provider/id" → {provider, id}（直接拆）
 *   - 裸 id 或半成品对象：遍历 added-models.yaml 里每个 provider 的 models，
 *     取首个命中。多 provider 同 id 时取 added-models.yaml 第一个（已有行为不变）。
 *     找不到保留原值（避免热删有效配置，/providers 设置页重启会自愈）。
 */
function normalizeCompositeModelRefs(ctx, { migrationId }) {
  const { agentsDir, prefs, providerRegistry, log } = ctx;

  // ── 构建 id → provider 查找表（多 provider 同 id 取首个） ──
  const idToProvider = new Map();
  const rawProviders = providerRegistry.getAllProvidersRaw?.() || {};
  for (const [providerId, p] of Object.entries(rawProviders || {})) {
    for (const m of p.models || []) {
      const id = typeof m === "object" ? m.id : m;
      if (id && !idToProvider.has(id)) idToProvider.set(id, providerId);
    }
  }

  function normalize(ref) {
    // 返回 { value, changed }；value 为迁移后的值（可能是原值）
    if (!ref) return { value: ref, changed: false };

    // {id, provider} 对象
    if (typeof ref === "object") {
      if (ref.id && ref.provider) return { value: ref, changed: false };
      if (ref.id && !ref.provider) {
        const guess = idToProvider.get(ref.id);
        if (guess) return { value: { id: ref.id, provider: guess }, changed: true };
        return { value: ref, changed: false };
      }
      return { value: ref, changed: false };
    }

    if (typeof ref !== "string") return { value: ref, changed: false };

    // "provider/id"
    const slashIdx = ref.indexOf("/");
    if (slashIdx > 0 && slashIdx < ref.length - 1) {
      return { value: { provider: ref.slice(0, slashIdx), id: ref.slice(slashIdx + 1) }, changed: true };
    }

    // 裸 id
    const guess = idToProvider.get(ref);
    if (guess) return { value: { id: ref, provider: guess }, changed: true };
    return { value: ref, changed: false };
  }

  const ROLES = ["chat", "utility", "utility_large"];

  // ── agent config.yaml ──
  let agentDirs;
  try {
    agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter(d => d.isDirectory());
  } catch {
    agentDirs = [];
  }

  for (const dir of agentDirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    const config = safeReadYAMLSync(cfgPath, null, YAML);
    if (!config?.models) continue;

    let changed = false;
    const next = { ...config.models };
    for (const role of ROLES) {
      const { value, changed: ch } = normalize(config.models[role]);
      if (ch) {
        next[role] = value;
        changed = true;
        log(`[migrations] #${migrationId} ${dir.name}: models.${role} → ${value.provider}/${value.id}`);
      }
    }

    if (changed) {
      saveConfig(cfgPath, { models: next });
    }
  }

  // ── preferences.json (shared models) ──
  const preferences = prefs.getPreferences();
  let prefsChanged = false;
  const prefKeys = ["utility_model", "utility_large_model"];
  for (const key of prefKeys) {
    const { value, changed } = normalize(preferences[key]);
    if (changed) {
      preferences[key] = value;
      prefsChanged = true;
      log(`[migrations] #${migrationId} preferences.${key} → ${value.provider}/${value.id}`);
    }
  }
  if (prefsChanged) prefs.savePreferences(preferences);
}

function migrateModelRefsToCompositeKey(ctx) {
  normalizeCompositeModelRefs(ctx, { migrationId: 5 });
}

function repairPostMigrationModelRefs(ctx) {
  normalizeCompositeModelRefs(ctx, { migrationId: 8 });
}

/**
 * #6 — channels.enabled 统一迁移到 global preferences，尊重老用户意图
 *
 * 背景：旧版本 /channels/toggle 把 `channels.enabled` 通过 updateConfig 写入了
 * 每个被 toggle 过的 agent 的 config.yaml（因为 schema 当时没登记这是 global 字段）。
 * 现在把真相源收敛到 preferences.channels_enabled。
 *
 * 合并策略（因为老数据没时间戳，无法按"最后一次"取值）：
 *   - 任一 agent config 显式 `channels.enabled === true` → 最终保留 true（说明用户想用）
 *   - 所有显式值都是 false，或根本没人设过 → 最终 false（产品默认）
 *
 * 这样既尊重显式开过的老用户、不让他们升级后发现功能被强关，
 * 又让从没用过频道的大多数用户默认关闭（产品判断：bug 修之前 ticker 无条件跑，
 * 所以老行为里"config 显示开"并不代表用户真的想开，只有"显式设过 true"才能说明意图）。
 */
function migrateChannelsToGlobalDefaultOff(ctx) {
  const { agentsDir, prefs, log } = ctx;

  let agentDirs;
  try {
    agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter(d => d.isDirectory());
  } catch {
    agentDirs = [];
  }

  // ── 1. 扫描：收集老用户的显式意图 ──
  let anyEnabledTrue = false;
  let anyExplicit = false;

  for (const dir of agentDirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    const config = safeReadYAMLSync(cfgPath, null, YAML);
    if (!config?.channels || typeof config.channels !== "object") continue;
    if (!("enabled" in config.channels)) continue;
    anyExplicit = true;
    if (config.channels.enabled === true) anyEnabledTrue = true;
  }

  // ── 2. 清理所有 agent config.yaml 中错位的 channels.enabled ──
  for (const dir of agentDirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    const config = safeReadYAMLSync(cfgPath, null, YAML);
    if (!config?.channels || typeof config.channels !== "object") continue;

    let changed = false;
    if ("enabled" in config.channels) {
      delete config.channels.enabled;
      log(`[migrations] #6 ${dir.name}: 移除 agent-level channels.enabled`);
      changed = true;
    }
    if (Object.keys(config.channels).length === 0) {
      delete config.channels;
      changed = true;
    }

    if (changed) {
      const tmp = cfgPath + ".tmp";
      fs.writeFileSync(tmp, YAML.dump(config, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: '"' }), "utf-8");
      fs.renameSync(tmp, cfgPath);
    }
  }

  // ── 3. 写入 global preferences ──
  const finalValue = anyEnabledTrue;
  const preferences = prefs.getPreferences();
  preferences.channels_enabled = finalValue;
  prefs.savePreferences(preferences);

  if (anyEnabledTrue) {
    log(`[migrations] #6: preferences.channels_enabled = true（保留：检测到至少一个 agent 显式开启过）`);
  } else if (anyExplicit) {
    log(`[migrations] #6: preferences.channels_enabled = false（所有显式设置都是关闭）`);
  } else {
    log(`[migrations] #6: preferences.channels_enabled = false（无显式历史设置，按产品默认关闭）`);
  }
}

/**
 * #9 — bridge.readOnly 从 per-agent 收敛到 global preferences
 *
 * 历史上 readOnly 被放在 agent.config.bridge.readOnly，但页面语义后来演进为
 * 总开关。这里收敛到 preferences.bridge.readOnly，并清理所有 agent-level
 * 残留字段。
 *
 * 冲突策略：任一 agent 显式 true → 全局 true，保证更保守的权限边界。
 * 若 preferences 已有 bridge.readOnly，则以 preferences 为准，只做清理。
 */
function migrateBridgeReadOnlyToGlobal(ctx) {
  const { agentsDir, prefs, log } = ctx;

  let agentDirs;
  try {
    agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter(d => d.isDirectory());
  } catch {
    agentDirs = [];
  }

  let anyReadOnlyTrue = false;
  let anyExplicit = false;

  for (const dir of agentDirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    const config = safeReadYAMLSync(cfgPath, null, YAML);
    if (!config?.bridge || typeof config.bridge !== "object") continue;
    if (!("readOnly" in config.bridge)) continue;
    anyExplicit = true;
    if (config.bridge.readOnly === true) anyReadOnlyTrue = true;
  }

  for (const dir of agentDirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    const config = safeReadYAMLSync(cfgPath, null, YAML);
    if (!config?.bridge || typeof config.bridge !== "object") continue;
    if (!("readOnly" in config.bridge)) continue;

    delete config.bridge.readOnly;
    if (Object.keys(config.bridge).length === 0) delete config.bridge;

    const tmp = cfgPath + ".tmp";
    fs.writeFileSync(tmp, YAML.dump(config, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: '"' }), "utf-8");
    fs.renameSync(tmp, cfgPath);
    log(`[migrations] #9 ${dir.name}: 移除 agent-level bridge.readOnly`);
  }

  const preferences = prefs.getPreferences();
  const hadPrefsValue = typeof preferences.bridge?.readOnly === "boolean";
  const finalValue = hadPrefsValue
    ? preferences.bridge.readOnly
    : anyReadOnlyTrue;
  const bridgePrefs = { ...(preferences.bridge || {}) };
  if (finalValue) bridgePrefs.readOnly = true;
  else delete bridgePrefs.readOnly;
  if (Object.keys(bridgePrefs).length === 0) delete preferences.bridge;
  else preferences.bridge = bridgePrefs;
  prefs.savePreferences(preferences);

  if (hadPrefsValue && !anyExplicit) {
    log(`[migrations] #9: preferences.bridge.readOnly 保持现值 ${finalValue}`);
  } else if (anyReadOnlyTrue) {
    log(`[migrations] #9: preferences.bridge.readOnly = true（检测到至少一个 agent 显式开启）`);
  } else if (anyExplicit) {
    log(`[migrations] #9: preferences.bridge.readOnly = false（所有显式设置都是关闭）`);
  } else {
    log(`[migrations] #9: preferences.bridge.readOnly = false（无显式历史设置，按产品默认关闭）`);
  }
}

/**
 * #3 — workspace 迁移 + 非主 agent 巡检默认关闭
 *
 * 两件事：
 * 1. home_folder 从全局 preferences 迁移到主 agent 的 config.yaml
 * 2. 非主 agent 的 heartbeat_enabled 设为 false（老用户预期只有主 agent 巡检）
 */
function migrateWorkspaceToPerAgent(ctx) {
  const { agentsDir, prefs, log } = ctx;
  const preferences = prefs.getPreferences();
  const homeFolder = preferences.home_folder;
  const primaryAgentId = preferences.primaryAgent || null;

  // ── 1. 找到主 agent ──

  let targetAgentId = null;

  if (primaryAgentId) {
    const cfgPath = path.join(agentsDir, primaryAgentId, "config.yaml");
    if (fs.existsSync(cfgPath)) {
      targetAgentId = primaryAgentId;
    } else {
      log(`[migrations] #3: primaryAgent "${primaryAgentId}" config.yaml not found, scanning`);
    }
  }

  if (!targetAgentId) {
    try {
      const dirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter(d => d.isDirectory());
      for (const d of dirs) {
        if (fs.existsSync(path.join(agentsDir, d.name, "config.yaml"))) {
          targetAgentId = d.name;
          break;
        }
      }
    } catch {}
  }

  // ── 2. 迁移 home_folder ──

  if (homeFolder) {
    if (!targetAgentId) {
      throw new Error("no agent with config.yaml found, home_folder preserved in preferences");
    }

    const cfgPath = path.join(agentsDir, targetAgentId, "config.yaml");
    saveConfig(cfgPath, { desk: { home_folder: homeFolder } });

    // Verify write
    const verify = safeReadYAMLSync(cfgPath, null, YAML);
    if (verify?.desk?.home_folder !== homeFolder) {
      throw new Error(`write verification failed for agent ${targetAgentId}, home_folder preserved in preferences`);
    }

    delete preferences.home_folder;
    prefs.savePreferences(preferences);
    log(`[migrations] #3: migrated home_folder "${homeFolder}" → agent ${targetAgentId}`);
  }

  // ── 3. 非主 agent 的巡检默认关闭 ──

  try {
    const dirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const d of dirs) {
      if (d.name === targetAgentId) continue; // 主 agent 保持原状
      const cfgPath = path.join(agentsDir, d.name, "config.yaml");
      if (!fs.existsSync(cfgPath)) continue;

      const config = safeReadYAMLSync(cfgPath, null, YAML);
      if (!config) continue;
      // 只在未显式设置过时关闭（如果用户已经手动设了，尊重他的选择）
      if (config.desk?.heartbeat_enabled !== undefined) continue;

      saveConfig(cfgPath, { desk: { heartbeat_enabled: false } });
      log(`[migrations] #3: disabled heartbeat for non-primary agent "${d.name}"`);
    }
  } catch (err) {
    log(`[migrations] #3: warning — failed to disable non-primary heartbeats: ${err.message}`);
  }
}

/**
 * #7 — 模型能力字段 vision → image 全量重命名
 *
 * 历史包袱：项目早期在 Pi SDK Model 对象上挂了一份自定义的 vision:boolean 字段，
 * 与 Pi SDK 标准字段 input:("text"|"image")[] 重复。本次统一到 Pi SDK 标准，
 * 把用户意图层（added-models.yaml + agent config.yaml）的 vision 重命名为 image，
 * 运行时层只保留 input 数组。
 *
 * 覆盖位置：
 *   1. ~/.hanako/added-models.yaml 的 providers.*.models[] 数组（用户主战场）
 *   2. ~/.hanako/agents/*\/config.yaml 的 models.overrides（历史残留兜底）
 *
 * 幂等：只在发现 vision 字段时改写；image 已存在时保留不覆盖。
 * 配合读时兼容（model-sync.js、provider-registry.js）形成双保险。
 */
function migrateVisionToImage(ctx) {
  const { hanakoHome, agentsDir, log } = ctx;
  let ymlCount = 0;
  let overrideCount = 0;

  // ── 1. added-models.yaml ──
  const ymlPath = path.join(hanakoHome, "added-models.yaml");
  const raw = safeReadYAMLSync(ymlPath, null, YAML);
  if (raw?.providers && typeof raw.providers === "object") {
    let changed = false;
    for (const prov of Object.values(raw.providers)) {
      if (!prov || !Array.isArray(prov.models)) continue;
      for (const m of prov.models) {
        if (!m || typeof m !== "object") continue;
        if (!Object.prototype.hasOwnProperty.call(m, "vision")) continue;
        if (m.image === undefined) m.image = m.vision;
        delete m.vision;
        changed = true;
        ymlCount++;
      }
    }
    if (changed) {
      const header =
        "# Hanako 供应商配置（全局，跨 agent 共享）\n" +
        "# 由设置页面管理\n\n";
      const yamlStr = header + YAML.dump(raw, {
        indent: 2,
        lineWidth: -1,
        sortKeys: false,
        quotingType: "\"",
        forceQuotes: false,
      });
      const tmp = ymlPath + ".tmp";
      fs.writeFileSync(tmp, yamlStr, "utf-8");
      fs.renameSync(tmp, ymlPath);
    }
  }

  // ── 2. agent/*/config.yaml 的 models.overrides（兜底残留）──
  let agentDirs;
  try {
    agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter(d => d.isDirectory());
  } catch {
    agentDirs = [];
  }

  for (const dir of agentDirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    const cfg = safeReadYAMLSync(cfgPath, null, YAML);
    if (!cfg?.models?.overrides || typeof cfg.models.overrides !== "object") continue;

    let changed = false;
    for (const ov of Object.values(cfg.models.overrides)) {
      if (!ov || typeof ov !== "object") continue;
      if (!Object.prototype.hasOwnProperty.call(ov, "vision")) continue;
      if (ov.image === undefined) ov.image = ov.vision;
      delete ov.vision;
      changed = true;
      overrideCount++;
    }
    if (changed) {
      const tmp = cfgPath + ".tmp";
      fs.writeFileSync(
        tmp,
        YAML.dump(cfg, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: "\"" }),
        "utf-8"
      );
      fs.renameSync(tmp, cfgPath);
    }
  }

  log(`[migrations] #7: vision→image renamed (added-models.yaml=${ymlCount}, agent overrides=${overrideCount})`);
}

function buildModelProviderIndex(providerRegistry) {
  const idToProvider = new Map();
  const providerModelIds = new Map();
  const rawProviders = providerRegistry.getAllProvidersRaw?.() || {};

  for (const [providerId, provider] of Object.entries(rawProviders || {})) {
    const ids = new Set();
    for (const m of provider?.models || []) {
      const id = typeof m === "object" ? m.id : m;
      if (!id) continue;
      ids.add(id);
      if (!idToProvider.has(id)) idToProvider.set(id, providerId);
    }
    providerModelIds.set(providerId, ids);
  }

  return { idToProvider, providerModelIds };
}

function normalizeCronModelRefForMigration(ref, index) {
  if (!ref) return { value: "", changed: ref !== "" };

  if (typeof ref === "object") {
    if (!ref.id) return { value: ref, changed: false };
    if (ref.provider) return { value: ref, changed: false };
    const provider = index.idToProvider.get(ref.id);
    if (provider) return { value: { id: ref.id, provider }, changed: true };
    return { value: ref, changed: false };
  }

  if (typeof ref !== "string") return { value: ref, changed: false };

  const s = ref.trim();
  if (!s) return { value: "", changed: ref !== "" };

  // 先按完整 id 查，避免把 openrouter 这类包含 "/" 的裸模型 id 误拆成 provider/id。
  const exactProvider = index.idToProvider.get(s);
  if (exactProvider) return { value: { id: s, provider: exactProvider }, changed: true };

  const slashIdx = s.indexOf("/");
  if (slashIdx > 0 && slashIdx < s.length - 1) {
    const provider = s.slice(0, slashIdx);
    const id = s.slice(slashIdx + 1);
    const knownIds = index.providerModelIds.get(provider);
    if (knownIds?.has(id) || index.providerModelIds.has(provider)) {
      return { value: { id, provider }, changed: true };
    }
  }

  return { value: ref, changed: false };
}

/**
 * #11 — cron job 的 model 字段迁移为复合键对象
 *
 * v0.11x 的模型复合键重构要求运行期模型引用必须带 provider，但 cron 任务
 * 仍把 UI 选择的模型保存为裸 id，导致后台执行时偶发 "找不到模型"。
 */
function repairCronJobModelRefs(ctx) {
  const { agentsDir, providerRegistry, log } = ctx;
  const index = buildModelProviderIndex(providerRegistry);

  let agentDirs;
  try {
    agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter(d => d.isDirectory());
  } catch {
    return;
  }

  let patched = 0;
  for (const dir of agentDirs) {
    const jobsPath = path.join(agentsDir, dir.name, "desk", "cron-jobs.json");
    if (!fs.existsSync(jobsPath)) continue;

    let data;
    try {
      data = JSON.parse(fs.readFileSync(jobsPath, "utf-8"));
    } catch (err) {
      log(`[migrations] #11 ${dir.name}: skipped invalid cron-jobs.json (${err.message})`);
      continue;
    }
    if (!Array.isArray(data.jobs)) continue;

    let changed = false;
    for (const job of data.jobs) {
      const { value, changed: modelChanged } = normalizeCronModelRefForMigration(job.model, index);
      if (!modelChanged) continue;
      job.model = value;
      changed = true;
      patched++;
    }

    if (changed) {
      const tmp = jobsPath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
      fs.renameSync(tmp, jobsPath);
      log(`[migrations] #11 ${dir.name}: repaired cron model refs`);
    }
  }

  log(`[migrations] #11: cron model refs repaired (${patched})`);
}

/**
 * #10 — 清除 summarizer / compiler 残留字段
 *
 * 这两个角色在 v0.55 架构重构时被列入 schema，但业务路径从未接通过任何调用，
 * 此次连同 ROLE_TO_PREF_KEY / SHARED_MODEL_KEYS / config.example.yaml 一起清理。
 * 用户机器上可能有以下残留，全部 delete key（不是写 null）：
 *   - preferences.json 的 summarizer_model / compiler_model
 *   - 每个 agent config.yaml 的 models.summarizer / models.compiler
 *
 * 幂等：缺失字段直接跳过；不抛错，避免拦住启动。
 */
function cleanupSummarizerCompilerRemnants(ctx) {
  const { agentsDir, prefs, log } = ctx;

  // ── preferences ──
  const preferences = prefs.getPreferences();
  let prefsChanged = false;
  for (const key of ["summarizer_model", "compiler_model"]) {
    if (Object.prototype.hasOwnProperty.call(preferences, key)) {
      delete preferences[key];
      prefsChanged = true;
      log(`[migrations] #10: removed preferences.${key}`);
    }
  }
  if (prefsChanged) prefs.savePreferences(preferences);

  // ── agent config.yaml ──
  let agentDirs;
  try {
    agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter(d => d.isDirectory());
  } catch {
    agentDirs = [];
  }

  for (const dir of agentDirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    const config = safeReadYAMLSync(cfgPath, null, YAML);
    if (!config?.models || typeof config.models !== "object") continue;

    let changed = false;
    for (const role of ["summarizer", "compiler"]) {
      if (Object.prototype.hasOwnProperty.call(config.models, role)) {
        delete config.models[role];
        changed = true;
        log(`[migrations] #10 ${dir.name}: removed models.${role}`);
      }
    }

    if (changed) {
      const tmp = cfgPath + ".tmp";
      fs.writeFileSync(
        tmp,
        YAML.dump(config, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: "\"" }),
        "utf-8"
      );
      fs.renameSync(tmp, cfgPath);
    }
  }
}

/**
 * #12 — 老 session 文件引用补齐到 sidecar
 *
 * 这次 StageFile 收口后，历史消息恢复需要能从 sidecar 查询文件生命周期。
 * 老 JSONL 里可能只有 toolResult.details.files / artifactFile / inline screenshot，
 * 因此迁移只做两件事：
 *   1. 扫描历史消息里的本地文件路径，注册到对应 session 的 .files.json；
 *   2. 把旧 browser inline screenshot 物化成 session-files 缓存图片并注册。
 *
 * 迁移不重写 JSONL。恢复时由 sessions route 按 fileId / filePath / deterministic screenshot
 * path 回填 block 的生命周期字段。
 */
function backfillLegacySessionFiles(ctx) {
  const { hanakoHome, agentsDir, log } = ctx;
  if (!hanakoHome || !agentsDir) return;

  const registry = new SessionFileRegistry({
    managedCacheRoot: path.join(hanakoHome, "session-files"),
  });
  const sessionPaths = collectLegacySessionJsonlPaths(agentsDir);
  let registered = 0;
  let materialized = 0;
  let skipped = 0;

  for (const sessionPath of sessionPaths) {
    let lines;
    try {
      lines = fs.readFileSync(sessionPath, "utf-8").split("\n").filter(Boolean);
    } catch (err) {
      skipped++;
      log(`[migrations] #12: skipped unreadable session ${sessionPath} (${err.message})`);
      continue;
    }

    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        skipped++;
        continue;
      }
      const msg = entry?.message;
      if (entry?.type !== "message" || msg?.role !== "toolResult") continue;

      for (const ref of legacySessionFileRefs(msg)) {
        const ok = registerLegacySessionFile({ registry, sessionPath, ref, hanakoHome, log });
        if (ok) registered++;
        else skipped++;
      }

      const screenshot = legacyBrowserScreenshot(msg);
      if (screenshot?.base64) {
        try {
          persistBrowserScreenshotFileSync({
            hanakoHome,
            sessionPath,
            base64: screenshot.base64,
            mimeType: screenshot.mimeType || "image/png",
            registerSessionFile: (record) => registry.registerFile(record),
          });
          materialized++;
        } catch (err) {
          skipped++;
          log(`[migrations] #12: skipped browser screenshot in ${sessionPath} (${err.message})`);
        }
      }
    }
  }

  log(`[migrations] #12: session file sidecars backfilled (files=${registered}, screenshots=${materialized}, skipped=${skipped})`);
}

function collectLegacySessionJsonlPaths(agentsDir) {
  let agents = [];
  try {
    agents = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out = [];
  for (const agent of agents) {
    if (!agent.isDirectory()) continue;
    const agentDir = path.join(agentsDir, agent.name);
    collectJsonlRecursive(path.join(agentDir, "sessions"), out);
    collectJsonlRecursive(path.join(agentDir, "subagent-sessions"), out);
  }
  return out;
}

function collectJsonlRecursive(dir, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsonlRecursive(fullPath, out);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(fullPath);
    }
  }
}

function legacySessionFileRefs(msg) {
  const details = msg?.details;
  if (!details || typeof details !== "object") return [];

  const refs = [];
  const toolName = msg.toolName;

  if (toolName === "stage_files" || toolName === "present_files") {
    if (Array.isArray(details.files)) {
      for (const file of details.files) {
        pushLegacyFileRef(refs, file, {
          origin: file?.origin || "stage_files",
          storageKind: file?.storageKind || "external",
        });
      }
    }
    pushLegacyFileRef(refs, details, {
      origin: details.origin || "stage_files",
      storageKind: details.storageKind || "external",
    });
  }

  if (toolName === "create_artifact") {
    const artifactFile = details.artifactFile || details.sessionFile || details.file;
    pushLegacyFileRef(refs, artifactFile, {
      origin: artifactFile?.origin || "agent_artifact",
      storageKind: artifactFile?.storageKind || "external",
      label: details.title,
    });
  }

  if (toolName === "install_skill") {
    pushLegacyFileRef(refs, details.installedFile || details.sourceFile || details, {
      origin: "skill_install_source",
      storageKind: "install_source",
      label: details.skillName,
    });
  }

  if (toolName === "install_plugin" || toolName === "plugin_install") {
    pushLegacyFileRef(refs, details.installedFile || details.sourceFile || details, {
      origin: "plugin_install_source",
      storageKind: "install_source",
      label: details.pluginName || details.name,
    });
  }

  if (details.card?.file || details.card?.sessionFile || details.card?.sourceFile) {
    pushLegacyFileRef(refs, details.card.file || details.card.sessionFile || details.card.sourceFile, {
      origin: "plugin_output",
      storageKind: "plugin_data",
      label: details.card.title,
    });
  }

  if (Array.isArray(details.media?.items)) {
    for (const item of details.media.items) {
      pushLegacyFileRef(refs, item, {
        origin: item.origin || "agent_output",
        storageKind: item.storageKind || "external",
      });
    }
  }

  return refs;
}

function pushLegacyFileRef(refs, candidate, defaults = {}) {
  if (!candidate || typeof candidate !== "object") return;
  const filePath = candidate.filePath || candidate.path || candidate.realPath || candidate.localPath;
  if (!filePath) return;
  refs.push({
    filePath,
    label: candidate.label || candidate.displayName || candidate.filename || candidate.name || defaults.label,
    origin: candidate.origin || defaults.origin || "unknown",
    storageKind: candidate.storageKind || defaults.storageKind || "external",
  });
}

function registerLegacySessionFile({ registry, sessionPath, ref, hanakoHome, log }) {
  if (!ref?.filePath || !path.isAbsolute(ref.filePath)) return false;
  if (!fs.existsSync(ref.filePath)) return false;

  try {
    registry.registerFile({
      sessionPath,
      filePath: ref.filePath,
      label: ref.label || path.basename(ref.filePath),
      origin: ref.origin || "unknown",
      storageKind: normalizeLegacyStorageKind(ref, hanakoHome),
    });
    return true;
  } catch (err) {
    log(`[migrations] #12: skipped file ${ref.filePath} in ${sessionPath} (${err.message})`);
    return false;
  }
}

function normalizeLegacyStorageKind(ref, hanakoHome) {
  const storageKind = ref.storageKind || "external";
  if (storageKind !== "managed_cache") return storageKind;

  const managedRoot = path.join(hanakoHome, "session-files");
  const resolved = normalizeExistingOrResolvedPathForMigration(ref.filePath);
  const root = normalizeExistingOrResolvedPathForMigration(managedRoot);
  const rel = path.relative(root, resolved);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel))
    ? "managed_cache"
    : "external";
}

function normalizeExistingOrResolvedPathForMigration(filePath) {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function legacyBrowserScreenshot(msg) {
  if (msg?.toolName !== "browser" || msg?.details?.action !== "screenshot") return null;
  if (msg.details?.screenshotFile || msg.details?.fileId || msg.details?.id) return null;

  const image = Array.isArray(msg.content)
    ? msg.content.find((block) => block?.type === "image" && block?.data)
    : null;
  const base64 = image?.data || msg.details?.thumbnail || msg.details?.base64;
  if (!base64) return null;
  return {
    base64,
    mimeType: image?.mimeType || msg.details?.mimeType || "image/png",
  };
}
