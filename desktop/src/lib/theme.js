/**
 * theme.js — 共享主题系统
 *
 * 被 onboarding.js 等所有窗口共用。
 * 通过 localStorage 跨窗口同步主题选择。
 */

const _themeSheet = document.getElementById("themeSheet");
const _THEME_FILES = {
  "warm-paper": "themes/warm-paper.css",
  "midnight": "themes/midnight.css",
  "high-contrast": "themes/high-contrast.css",
  "grass-aroma": "themes/grass-aroma.css",
  "contemplation": "themes/contemplation.css",
  "absolutely": "themes/absolutely.css",
  "delve": "themes/delve.css",
  "deep-think": "themes/deep-think.css",
};

function systemPreferredTheme() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "midnight" : "warm-paper";
}

function applyConcreteTheme(concrete) {
  if (!_THEME_FILES[concrete]) return;
  document.documentElement.setAttribute("data-theme", concrete);
  if (_themeSheet) _themeSheet.href = _THEME_FILES[concrete];
}

let _systemThemeListener = null;

function setTheme(name) {
  if (_systemThemeListener) {
    window.matchMedia("(prefers-color-scheme: dark)").removeEventListener("change", _systemThemeListener);
    _systemThemeListener = null;
  }
  if (name === "auto") {
    applyConcreteTheme(systemPreferredTheme());
    _systemThemeListener = () => applyConcreteTheme(systemPreferredTheme());
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", _systemThemeListener);
  } else {
    applyConcreteTheme(name);
  }
  localStorage.setItem("hana-theme", name);
}

function loadSavedTheme() {
  const saved = localStorage.getItem("hana-theme") || "auto";
  setTheme(saved);
}

/* ── 衬线体 / 无衬线体切换 ── */

function setSerifFont(enabled) {
  document.body.classList.toggle("font-sans", !enabled);
  localStorage.setItem("hana-font-serif", enabled ? "1" : "0");
}

function loadSavedFont() {
  const saved = localStorage.getItem("hana-font-serif");
  // 默认开启衬线体（saved === null → 首次使用）
  const enabled = saved !== "0";
  document.body.classList.toggle("font-sans", !enabled);
}
