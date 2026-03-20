/**
 * update-settings-tool.js — 设置修改工具
 *
 * 让 Agent 提议修改设置，通过阻塞式确认卡片等待用户批准。
 * 不自己实现 apply 逻辑，复用 engine/preferences 上已有的 setter。
 */

import { Type } from "@sinclair/typebox";
import { t } from "../../server/i18n.js";

/**
 * 设置注册表
 * 每个 key 对应一个可修改的设置项：
 *   type: 'toggle' | 'list' | 'text'
 *   label: 显示名称
 *   options?: list 类型的可选值（静态）
 *   optionsFrom?: 动态选项来源
 *   get: (engine) => currentValue
 *   apply: (engine, value) => void
 *   frontend?: true 表示前端专属设置（theme 等）
 */
// label/description 用 getter 惰性求值，避免在语言包加载前被冻结
const SETTINGS_REGISTRY = {
  sandbox: {
    type: "toggle",
    get label() { return t("toolDef.updateSettings.sandbox"); },
    get description() { return t("toolDef.updateSettings.sandboxDesc"); },
    get: (engine) => String(engine.preferences.getSandbox() !== false),
    apply: (engine) => engine.setSandbox,
  },
  locale: {
    type: "list",
    get label() { return t("toolDef.updateSettings.locale"); },
    options: ["zh-CN", "zh-TW", "ja", "ko", "en"],
    get: (engine) => engine.preferences.getLocale() || "zh-CN",
    apply: (engine) => engine.setLocale,
  },
  timezone: {
    type: "text",
    get label() { return t("toolDef.updateSettings.timezone"); },
    get description() { return t("toolDef.updateSettings.timezoneDesc"); },
    get: (engine) => engine.preferences.getTimezone() || Intl.DateTimeFormat().resolvedOptions().timeZone,
    apply: (engine) => engine.setTimezone,
  },
  thinking_level: {
    type: "list",
    get label() { return t("toolDef.updateSettings.thinkingBudget"); },
    options: ["auto", "off", "low", "medium", "high"],
    get: (engine) => engine.preferences.getThinkingLevel() || "auto",
    apply: (engine) => engine.setThinkingLevel,
  },
  "memory.enabled": {
    type: "toggle",
    get label() { return t("toolDef.updateSettings.memory"); },
    get description() { return t("toolDef.updateSettings.memoryDesc"); },
    scope: "agent",
    get: (engine) => String(engine.agent?.memoryMasterEnabled !== false),
    apply: (engine) => (v) => engine.agent?.updateConfig({ memory: { enabled: v === "true" } }),
  },
  "agent.name": {
    type: "text",
    get label() { return t("toolDef.updateSettings.agentName"); },
    scope: "agent",
    get: (engine) => engine.agent?.agentName || "Hanako",
    apply: (engine) => (v) => engine.agent?.updateConfig({ agent: { name: v } }),
  },
  "user.name": {
    type: "text",
    get label() { return t("toolDef.updateSettings.userName"); },
    scope: "agent",
    get: (engine) => engine.agent?.userName || "User",
    apply: (engine) => (v) => engine.agent?.updateConfig({ user: { name: v } }),
  },
  home_folder: {
    type: "text",
    get label() { return t("toolDef.updateSettings.workingDir"); },
    get description() { return t("toolDef.updateSettings.workingDirDesc"); },
    get: (engine) => engine.getHomeFolder() || "",
    apply: (engine) => engine.setHomeFolder,
  },
  theme: {
    type: "list",
    get label() { return t("toolDef.updateSettings.theme"); },
    options: ["warm-paper", "midnight", "high-contrast", "grass-aroma", "contemplation", "absolutely", "delve", "deep-think", "auto"],
    frontend: true,
    get: () => "auto",
    apply: null,
  },
  "models.chat": {
    type: "list",
    get label() { return t("toolDef.updateSettings.chatModel"); },
    scope: "agent",
    optionsFrom: "availableModels",
    get: (engine) => engine.agent?.config?.models?.chat || "",
    apply: (engine) => (v) => engine.agent?.updateConfig({ models: { chat: v } }),
  },
};

/**
 * 创建 update_settings 工具
 */
export function createUpdateSettingsTool(deps = {}) {
  const {
    getEngine,        // () => engine
    getConfirmStore,  // () => ConfirmStore
    getSessionPath,   // () => string|null
    emitEvent,        // (event) => void
  } = deps;

  const settingKeys = Object.keys(SETTINGS_REGISTRY);
  const settingsDesc = settingKeys.map(k => {
    const s = SETTINGS_REGISTRY[k];
    const opts = s.options ? ` (${s.options.join(" / ")})` : "";
    return `- ${k}: ${s.label}${opts}`;
  }).join("\n");
  const description = t("toolDef.updateSettings.description", { settings: settingsDesc });

  return {
    name: "update_settings",
    userFacingName: t("toolDef.updateSettings.label"),
    description,
    parameters: {
      type: "object",
      properties: {
        key: Type.String({ description: t("toolDef.updateSettings.keyDesc", { keys: settingKeys.join(" / ") }) }),
        value: Type.String({ description: t("toolDef.updateSettings.valueDesc") }),
      },
      required: ["key", "value"],
    },
    isUserFacing: true,
    execute: async (_toolCallId, params) => {
      const { key, value } = params;
      const reg = SETTINGS_REGISTRY[key];
      if (!reg) {
        return { content: [{ type: "text", text: t("error.settingsUnknownKey", { key, keys: settingKeys.join(", ") }) }] };
      }

      const engine = getEngine?.();
      const confirmStore = getConfirmStore?.();
      const sessionPath = getSessionPath?.();

      if (!engine || !confirmStore) {
        return { content: [{ type: "text", text: t("error.settingsNotReady") }] };
      }

      // 读取当前值
      const currentValue = reg.get(engine);

      // 动态选项
      let options = reg.options;
      if (reg.optionsFrom === "availableModels") {
        options = (engine.availableModels || []).map(m => m.id);
      }

      // 创建阻塞确认
      const { confirmId, promise } = confirmStore.create(
        "settings",
        { key, label: reg.label, description: reg.description, type: reg.type, currentValue, proposedValue: value, options, frontend: reg.frontend },
        sessionPath,
      );

      // 广播确认事件（在 await 之前，因为 _emitEvent 是同步的）
      emitEvent?.({
        type: "settings_confirmation",
        confirmId,
        settingKey: key,
        cardType: reg.type,
        currentValue,
        proposedValue: value,
        options: options || null,
        label: reg.label,
        description: reg.description || null,
        frontend: !!reg.frontend,
      });

      // 阻塞等待用户确认
      const result = await promise;

      if (result.action === "confirmed") {
        const finalValue = result.value !== undefined ? String(result.value) : value;
        try {
          if (reg.frontend) {
            // 前端专属设置，广播 apply 事件
            emitEvent?.({ type: "apply_frontend_setting", key, value: finalValue });
          } else {
            // reg.apply 是 (engine) => setter 形式，先拿到 setter 再调用
            const setter = reg.apply(engine);
            if (typeof setter === "function") {
              setter(finalValue);
            }
          }
          return { content: [{ type: "text", text: t("error.settingsApplied", { label: reg.label, value: finalValue }) }] };
        } catch (err) {
          return { content: [{ type: "text", text: t("error.settingsApplyFailed", { msg: err.message }) }] };
        }
      } else if (result.action === "rejected") {
        return { content: [{ type: "text", text: t("error.settingsCancelled", { label: reg.label }) }] };
      } else {
        return { content: [{ type: "text", text: t("error.settingsTimeout", { label: reg.label }) }] };
      }
    },
  };
}
