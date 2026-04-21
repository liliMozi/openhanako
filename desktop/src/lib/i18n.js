/**
 * i18n — 轻量国际化模块
 *
 * 用法：
 *   await i18n.load("zh");           // 加载语言包
 *   t("sidebar.title")               // → "对话"
 *   t("tool.bash.running", { name }) // → "💻 Hana 正在小心翼翼地用你的电脑"
 *
 * 占位符：{key} 格式，在第二个参数对象中查找替换
 *
 * Per-agent override：
 *   i18n.setAgentOverrides({ thinking: { phrases: ["计算中..."] } })
 *   → t("thinking.phrases") 优先返回 agent 覆盖值，找不到才走全局语言包
 */

const i18n = {
  /** 全局语言包数据 */
  _data: {},

  /** Per-agent 局部覆盖（同 locale JSON 结构的子集） */
  _agentOverrides: {},

  /** 当前 locale（"zh" / "zh-TW" / "ja" / "ko" / "en"） */
  locale: "zh",

  /** 默认 agent 名（占位符 {name} 的 fallback） */
  defaultName: "Hanako",

  /**
   * 加载语言包
   * @param {string} locale  "zh-CN" / "zh-TW" / "ja" / "ko" / "en" 等
   */
  async load(locale) {
    const key = this._resolveKey(locale);
    this.locale = key;
    try {
      const res = await fetch(`./locales/${key}.json`);
      if (!res.ok) throw new Error(res.statusText);
      this._data = await res.json();
    } catch (err) {
      console.error(`[i18n] Failed to load locale "${key}":`, err);
      if (key !== "en") {
        try {
          const fb = await fetch("./locales/en.json");
          this._data = await fb.json();
        } catch { this._data = {}; }
      } else {
        this._data = {};
      }
    }
  },

  /** locale 字符串 → JSON 文件名 key */
  _resolveKey(locale) {
    if (!locale) return "zh";
    if (locale === "zh-TW" || locale === "zh-Hant") return "zh-TW";
    if (locale.startsWith("zh")) return "zh";
    if (locale.startsWith("ja")) return "ja";
    if (locale.startsWith("ko")) return "ko";
    return "en";
  },

  /**
   * 设置当前 agent 的 locale 覆盖
   * @param {object|null} overrides  部分 locale 对象（同 zh.json 结构的子集），null 清空
   */
  setAgentOverrides(overrides) {
    this._agentOverrides = overrides || {};
  },

  /**
   * 按 dot path 取值（agent override > 全局语言包）
   * @param {string} path  如 "sidebar.title" 或 "tool.bash.running"
   * @returns {*}
   */
  _get(path) {
    const keys = path.split(".");
    const override = keys.reduce((obj, k) => obj?.[k], this._agentOverrides);
    if (override !== undefined && override !== null) return override;
    return keys.reduce((obj, k) => obj?.[k], this._data);
  },

  /**
   * 翻译
   * @param {string} path   如 "sidebar.title"
   * @param {object} [vars] 占位符变量，如 { name: "Hana", n: 3 }
   * @returns {string}
   */
  t(path, vars) {
    let val = this._get(path);
    if (val === undefined || val === null) return path; // fallback: 返回 key 本身
    if (typeof val !== "string") return val;

    // 替换占位符
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        val = val.replaceAll(`{${k}}`, v);
      }
    }
    // 未提供 name 时用 defaultName
    val = val.replaceAll("{name}", this.defaultName);

    return val;
  },
};

/**
 * 快捷函数
 * @param {string} path
 * @param {object} [vars]
 * @returns {string}
 */
function t(path, vars) {
  return i18n.t(path, vars);
}

// React module 通过 window.i18n / window.t 访问
window.i18n = i18n;
window.t = t;
