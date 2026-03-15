/**
 * utils.js — 纯工具函数
 *
 * 不依赖 state / DOM 引用的通用工具。
 * 部分函数依赖全局 t() (i18n)，但无其他副作用。
 * 通过 window.HanaModules.utils 暴露。
 */
(function () {

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/** 简易 CSV 解析（支持引号包裹的字段） */
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ""; }
      else if (ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) {
        row.push(field); field = "";
        if (row.some(c => c !== "")) rows.push(row);
        row = [];
        if (ch === '\r') i++;
      } else field += ch;
    }
  }
  row.push(field);
  if (row.some(c => c !== "")) rows.push(row);
  return rows;
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico"]);

function isImageFile(name) {
  const ext = (name || "").toLowerCase().replace(/^.*(\.\w+)$/, "$1");
  return IMAGE_EXTS.has(ext);
}

/** 给 md-content 里的代码块注入复制按钮 */
function injectCopyButtons(container) {
  const pres = container.querySelectorAll("pre");
  for (const pre of pres) {
    if (pre.querySelector(".copy-btn")) continue;
    const btn = document.createElement("button");
    btn.className = "copy-btn";
    btn.textContent = t("attach.copy");
    btn.addEventListener("click", () => {
      const code = pre.querySelector("code");
      const text = code ? code.textContent : pre.textContent;
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = t("attach.copied");
        setTimeout(() => { btn.textContent = t("attach.copy"); }, 1500);
      });
    });
    pre.style.position = "relative";
    pre.appendChild(btn);
  }
}

function formatSessionDate(isoStr) {
  const date = new Date(isoStr);
  const now = new Date();
  const diffMs = now - date;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return t("time.justNow");
  if (diffMin < 60) return t("time.minutesAgo", { n: diffMin });
  if (diffHr < 24) return t("time.hoursAgo", { n: diffHr });
  if (diffDay < 7) return t("time.daysAgo", { n: diffDay });

  const m = date.getMonth() + 1;
  const d = date.getDate();
  return t("time.dateFormat", { m, d });
}

function cronToHuman(schedule) {
  if (typeof schedule === "number") {
    const h = Math.round(schedule / 3600000);
    return h > 0 ? `每 ${h} 小时` : `每 ${Math.round(schedule / 60000)} 分钟`;
  }
  const s = String(schedule);
  const parts = s.split(" ");
  if (parts.length !== 5) return s;
  const [min, hour, , , dow] = parts;
  if (min.startsWith("*/") && hour === "*" && dow === "*") {
    return `每 ${min.slice(2)} 分钟`;
  }
  if (min === "0" && hour.startsWith("*/") && dow === "*") {
    return `每 ${hour.slice(2)} 小时`;
  }
  if (min === "0" && hour === "*" && dow === "*") {
    return "每小时";
  }
  if (hour === "*" && dow === "*" && /^\d+$/.test(min)) {
    return "每小时";
  }
  if (dow === "*" && hour !== "*" && min !== "*") {
    return `每天 ${hour}:${min.padStart(2, "0")}`;
  }
  const dayNames = ["日", "一", "二", "三", "四", "五", "六"];
  if (dow !== "*" && hour !== "*") {
    const dayStr = dow.split(",").map(d => `周${dayNames[+d] || d}`).join("/");
    return `${dayStr} ${hour}:${min.padStart(2, "0")}`;
  }
  return s;
}

// 暴露到全局命名空间
window.HanaModules = window.HanaModules || {};
window.HanaModules.utils = {
  escapeHtml, parseCSV, isImageFile, injectCopyButtons,
  formatSessionDate, cronToHuman, IMAGE_EXTS,
};

})();
