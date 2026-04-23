/**
 * update-settings-tool.js — 设置修改工具（渐进式披露）
 *
 * 两阶段调用：search 查找设置项 → apply 修改设置项。
 * description 不列举设置，由 search 按需返回匹配结果。
 */

import { Type } from "@sinclair/typebox";
import { StringEnum } from "../pi-sdk/index.js";
import { t } from "../../server/i18n.js";
import { getToolSessionPath } from "./tool-session.js";
import themeRegistry from "../../desktop/src/shared/theme-registry.cjs";
import { parseModelRef } from "../../shared/model-ref.js";

/**
 * i18n key → 本地化标签 批量转换
 */
function i18nLabels(keyMap) {
  return Object.fromEntries(Object.entries(keyMap).map(([k, v]) => [k, t(v)]));
}

const THEME_I18N = Object.fromEntries(
  Object.entries(themeRegistry.THEMES).map(([id, theme]) => [id, theme.i18nName])
);
// 'auto' 不在 THEMES 表里，显式补上
THEME_I18N[themeRegistry.AUTO_OPTION.id] = themeRegistry.AUTO_OPTION.i18nName;

const THINKING_I18N = {
  "auto": "settings.agent.thinkingLevels.auto",
  "off": "settings.agent.thinkingLevels.off",
  "low": "settings.agent.thinkingLevels.low",
  "medium": "settings.agent.thinkingLevels.medium",
  "high": "settings.agent.thinkingLevels.high",
};

const LOCALE_LABELS = {
  "zh-CN": "简体中文", "zh-TW": "繁體中文", "ja": "日本語", "ko": "한국어", "en": "English",
};

function requireAgentId(agent, key) {
  const agentId = agent?.id || null;
  if (!agentId) throw new Error(`${key} requires target agent`);
  return agentId;
}

/**
 * 设置注册表
 */
const SETTINGS_REGISTRY = {
  sandbox: {
    type: "toggle",
    get label() { return t("toolDef.updateSettings.sandbox"); },
    get description() { return t("toolDef.updateSettings.sandboxDesc"); },
    searchTerms: ["security", "安全", "权限", "セキュリティ", "보안"],
    get: (engine, _agent) => String(engine.preferences.getSandbox()),
    apply: (engine, _agent, v) => engine.setSandbox(v),
  },
  file_backup: {
    type: "toggle",
    get label() { return t("toolDef.updateSettings.fileBackup"); },
    get description() { return t("toolDef.updateSettings.fileBackupDesc"); },
    searchTerms: ["backup", "备份", "バックアップ", "백업", "checkpoint"],
    get: (engine, _agent) => String(engine.preferences.getFileBackup().enabled),
    apply: (engine, _agent, v) => {
      const enabled = typeof v === "string" ? v === "true" : !!v;
      engine.setFileBackup({ enabled });
    },
  },
  locale: {
    type: "list",
    get label() { return t("toolDef.updateSettings.locale"); },
    options: ["zh-CN", "zh-TW", "ja", "ko", "en"],
    optionLabels: LOCALE_LABELS,
    searchTerms: ["language", "国际化", "言語", "언어"],
    get: (engine, _agent) => engine.preferences.getLocale() || "zh-CN",
    apply: (engine, _agent, v) => engine.setLocale(v),
  },
  timezone: {
    type: "text",
    get label() { return t("toolDef.updateSettings.timezone"); },
    get description() { return t("toolDef.updateSettings.timezoneDesc"); },
    get: (engine, _agent) => engine.preferences.getTimezone() || Intl.DateTimeFormat().resolvedOptions().timeZone,
    apply: (engine, _agent, v) => engine.setTimezone(v),
  },
  thinking_level: {
    type: "list",
    get label() { return t("toolDef.updateSettings.thinkingBudget"); },
    options: ["auto", "off", "low", "medium", "high"],
    get optionLabels() { return i18nLabels(THINKING_I18N); },
    searchTerms: ["reasoning", "推理", "思考", "推論"],
    get: (engine, _agent) => engine.preferences.getThinkingLevel() || "auto",
    apply: (engine, _agent, v) => engine.setThinkingLevel(v),
  },
  "memory.enabled": {
    type: "toggle",
    get label() { return t("toolDef.updateSettings.memory"); },
    get description() { return t("toolDef.updateSettings.memoryDesc"); },
    scope: "agent",
    get: (engine, agent) => agent ? String(agent.memoryMasterEnabled !== false) : null,
    apply: (engine, agent, v) => {
      if (!agent) throw new Error("no active agent");
      agent.updateConfig({ memory: { enabled: v === true || v === "true" } });
    },
  },
  "agent.name": {
    type: "text",
    get label() { return t("toolDef.updateSettings.agentName"); },
    scope: "agent",
    get: (engine, agent) => agent?.agentName || null,
    apply: (engine, agent, v) => {
      if (!agent) throw new Error("no active agent");
      agent.updateConfig({ agent: { name: v } });
    },
  },
  "user.name": {
    type: "text",
    get label() { return t("toolDef.updateSettings.userName"); },
    scope: "agent",
    get: (engine, agent) => agent?.userName || null,
    apply: (engine, agent, v) => {
      if (!agent) throw new Error("no active agent");
      agent.updateConfig({ user: { name: v } });
    },
  },
  home_folder: {
    type: "text",
    get label() { return t("toolDef.updateSettings.workingDir"); },
    get description() { return t("toolDef.updateSettings.workingDirDesc"); },
    scope: "agent",
    get: (engine, agent) => engine.getHomeFolder(requireAgentId(agent, "home_folder")) || "",
    apply: (engine, agent, v) => engine.setHomeFolder(requireAgentId(agent, "home_folder"), v),
  },
  theme: {
    type: "list",
    get label() { return t("toolDef.updateSettings.theme"); },
    options: [...themeRegistry.getThemeIds(), themeRegistry.AUTO_OPTION.id],
    get optionLabels() { return i18nLabels(THEME_I18N); },
    searchTerms: ["dark", "light", "暗色", "亮色", "外观", "appearance", "夜间", "ダーク", "다크"],
    frontend: true,
    get: (_engine, _agent) => "auto",
    apply: null,
  },
  "models.chat": {
    type: "list",
    get label() { return t("toolDef.updateSettings.chatModel"); },
    scope: "agent",
    optionsFrom: "availableModels",
    searchTerms: ["model", "模型", "モデル", "모델"],
    get: (_engine, agent) => {
      const ref = parseModelRef(agent?.config?.models?.chat);
      if (!ref?.id) return null;
      return ref.provider ? `${ref.provider}/${ref.id}` : ref.id;
    },
    apply: async (engine, agent, v) => {
      if (!agent) throw new Error("no active agent");
      const ref = parseModelRef(v);
      if (!ref?.id || !ref?.provider) {
        throw new Error(`models.chat requires provider/id (got ${JSON.stringify(v)})`);
      }
      await engine.setDefaultModel(ref.id, ref.provider, { agentId: agent.id });
    },
  },
};

// ── 搜索 ──

function resolveOptions(reg, engine) {
  if (reg.optionsFrom === "availableModels") {
    return (engine.availableModels || []).map(m => `${m.provider}/${m.id}`);
  }
  return reg.options || null;
}

function resolveOptionLabels(reg, engine) {
  if (reg.optionsFrom === "availableModels") {
    return Object.fromEntries(
      (engine.availableModels || []).map(m => [`${m.provider}/${m.id}`, m.name || m.id]),
    );
  }
  return reg.optionLabels || null;
}

function resolveTargetAgent(engine, fallbackAgent) {
  const agentId = fallbackAgent?.id || null;
  if (!agentId) return { agentId: null, agent: fallbackAgent || null };
  const agent = typeof engine?.getAgent === "function"
    ? (engine.getAgent(agentId) || fallbackAgent)
    : fallbackAgent;
  return { agentId, agent };
}

function searchSettings(query, engine, agent) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results = [];
  for (const [key, reg] of Object.entries(SETTINGS_REGISTRY)) {
    const options = resolveOptions(reg, engine);
    const optionLabels = resolveOptionLabels(reg, engine);
    const haystack = [
      key, reg.label, reg.description || "",
      ...(reg.searchTerms || []),
      ...(options || []),
      ...Object.keys(optionLabels || {}),
      ...Object.values(optionLabels || {}),
    ].join(" ").toLowerCase();
    if (haystack.includes(q)) {
      results.push({ key, reg, options });
    }
  }
  return results;
}

// ── 格式化 ──

function formatOptionList(options, labels, maxShow = 10) {
  if (!options?.length) return "";
  const shown = options.slice(0, maxShow);
  const rest = options.length - shown.length;
  const parts = shown.map(o => labels?.[o] ? `${o}(${labels[o]})` : o);
  if (rest > 0) parts.push(`...+${rest}`);
  return parts.join(" / ");
}

function formatSearchResults(results, engine, agent) {
  return results.map((r, i) => {
    const { key, reg, options } = r;
    const ol = resolveOptionLabels(reg, engine);
    const lines = [`[${i + 1}] ${key} — ${reg.label} (${reg.type})`];

    // 当前值：frontend 设置标注不可读
    if (reg.frontend) {
      lines.push(`    ${t("toolDef.updateSettings.frontendOnly")}`);
    } else {
      const cv = reg.get(engine, agent);
      if (cv === null) {
        lines.push(`    → (N/A)`);
      } else {
        const cvLabel = ol?.[cv] ? `${cv} (${ol[cv]})` : cv;
        lines.push(`    → ${cvLabel}`);
      }
    }

    // 选项列表
    if (options?.length) {
      lines.push(`    ${formatOptionList(options, ol)}`);
    }
    if (reg.description) {
      lines.push(`    ${reg.description}`);
    }
    return lines.join("\n");
  }).join("\n\n");
}

// ── 工具 ──

export function createUpdateSettingsTool(deps = {}) {
  const {
    getEngine,
    getAgent,
    getConfirmStore,
    getSessionPath,
    emitEvent,
  } = deps;

  return {
    name: "update_settings",
    userFacingName: t("toolDef.updateSettings.label"),
    description: t("toolDef.updateSettings.description"),
    parameters: Type.Object({
      action: StringEnum(
        ["search", "apply"],
        { description: t("toolDef.updateSettings.actionDesc") },
      ),
      query: Type.Optional(Type.String({ description: t("toolDef.updateSettings.queryDesc") })),
      key: Type.Optional(Type.String({ description: t("toolDef.updateSettings.keyDesc") })),
      value: Type.Optional(Type.String({ description: t("toolDef.updateSettings.valueDesc") })),
    }),
    isUserFacing: true,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const engine = getEngine?.();
      const initialAgent = getAgent?.() || engine?.agent;
      const { agentId: targetAgentId, agent: targetAgent } = resolveTargetAgent(engine, initialAgent);

      switch (params.action) {
        // ── search ──
        case "search": {
          const query = params.query?.trim();
          if (!query) {
            return { content: [{ type: "text", text: t("toolDef.updateSettings.searchMissingQuery") }] };
          }
          if (!engine) {
            return { content: [{ type: "text", text: t("error.settingsNotReady") }] };
          }
          const results = searchSettings(query, engine, targetAgent);
          if (results.length === 0) {
            return { content: [{ type: "text", text: t("toolDef.updateSettings.searchNoResults", { query }) }] };
          }
          const body = formatSearchResults(results, engine, targetAgent);
          return { content: [{ type: "text", text: t("toolDef.updateSettings.searchResult", { count: String(results.length), results: body }) }] };
        }

        // ── apply ──
        case "apply": {
          const { key, value } = params;
          if (!key || !value) {
            return { content: [{ type: "text", text: t("toolDef.updateSettings.applyMissingParams") }] };
          }
          const reg = SETTINGS_REGISTRY[key];
          if (!reg) {
            return { content: [{ type: "text", text: t("error.settingsUnknownKey", { key }) }] };
          }

          const confirmStore = getConfirmStore?.();
          const sessionPath = getToolSessionPath(ctx);
          if (!engine || !confirmStore) {
            return { content: [{ type: "text", text: t("error.settingsNotReady") }] };
          }

          // scope: "agent" 的设置在无 agent 时拒绝操作
          if (reg.scope === "agent" && !targetAgent) {
            return { content: [{ type: "text", text: t("error.settingsNoAgent") }] };
          }

          // 读取当前值
          const currentValue = reg.get(engine, targetAgent);

          // 动态选项
          const options = resolveOptions(reg, engine);

          // toggle 校验
          if (reg.type === "toggle" && value !== "true" && value !== "false") {
            return { content: [{ type: "text", text: t("error.settingsInvalidToggle") }] };
          }

          // list 校验
          if (reg.type === "list" && options?.length && !options.includes(value)) {
            const ol = reg.optionLabels;
            const optList = formatOptionList(options, ol);
            return { content: [{ type: "text", text: t("error.settingsInvalidValue", { value, options: optList }) }] };
          }

          // 选项本地化标签
          const optionLabels = resolveOptionLabels(reg, engine);

          // 供所有返回路径携带的 block 描述
          const blockDetails = {
            settingKey: key,
            cardType: reg.type,
            currentValue: String(currentValue ?? ""),
            proposedValue: String(value),
            label: reg.label || key,
          };

          // 创建阻塞确认
          const { confirmId, promise } = confirmStore.create(
            "settings",
            { key, label: reg.label, description: reg.description, type: reg.type, currentValue, proposedValue: value, options, optionLabels, frontend: reg.frontend },
            sessionPath,
          );

          // 广播确认事件
          emitEvent?.({
            type: "settings_confirmation",
            confirmId,
            settingKey: key,
            cardType: reg.type,
            currentValue,
            proposedValue: value,
            options: options || null,
            optionLabels,
            label: reg.label,
            description: reg.description || null,
            frontend: !!reg.frontend,
            agentId: targetAgentId,
          }, sessionPath);

          // 阻塞等待用户确认
          const result = await promise;

          if (result.action === "confirmed") {
            const finalValue = result.value !== undefined ? String(result.value) : value;
            try {
              if (reg.frontend) {
                emitEvent?.({ type: "apply_frontend_setting", key, value: finalValue }, sessionPath);
              } else {
                if (typeof reg.apply === "function") {
                  const parsed = reg.type === "toggle" ? (finalValue === "true") : finalValue;
                  const { agent: applyAgent } = resolveTargetAgent(engine, targetAgent);
                  await reg.apply(engine, applyAgent, parsed);
                }
              }
              return { content: [{ type: "text", text: t("error.settingsApplied", { label: reg.label, value: finalValue }) }], details: { ...blockDetails, confirmed: true } };
            } catch (err) {
              return { content: [{ type: "text", text: t("error.settingsApplyFailed", { msg: err.message }) }] };
            }
          } else if (result.action === "rejected") {
            return { content: [{ type: "text", text: t("error.settingsCancelled", { label: reg.label }) }], details: { ...blockDetails, confirmed: false } };
          } else {
            // timeout — 用 'timeout' 字符串与 rejected(false) 区分，让 extractor 正确映射状态
            return { content: [{ type: "text", text: t("error.settingsTimeout", { label: reg.label }) }], details: { ...blockDetails, confirmed: "timeout" } };
          }
        }

        default:
          return { content: [{ type: "text", text: `Unknown action: ${params.action}` }] };
      }
    },
  };
}
