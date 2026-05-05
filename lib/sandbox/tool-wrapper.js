/**
 * tool-wrapper.js — 工具沙盒包装
 *
 * 在 Pi SDK 工具的 execute 外面套一层路径校验。
 * 被拦截时返回 LLM 可读的文本错误，不抛异常。
 *
 * macOS/Linux: bash 安全边界在 OS 沙盒（seatbelt/bwrap），preflight 只优化体验。
 * Windows: 无 OS 沙盒，bash 额外做路径提取 + PathGuard 校验作为安全层。
 */

import path from "path";
import { t } from "../../server/i18n.js";
import { normalizeWin32ShellPath } from "./win32-path.js";

/** 构造被拦截时返回给 LLM 的结果 */
function blockedResult(reason) {
  return {
    content: [{ type: "text", text: t("sandbox.blocked", { reason }) }],
  };
}

/** 解析工具参数中的路径为绝对路径 */
function resolvePath(rawPath, cwd) {
  if (!rawPath) return null;
  if (process.platform === "win32") {
    return normalizeWin32ShellPath(rawPath, cwd, { allowRelative: true });
  }
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
}

/**
 * 轻量 preflight 模式匹配
 * macOS/Linux: 体验层（OS 沙盒兜底）
 * Windows: 安全层之一（无 OS 沙盒）
 */
const PREFLIGHT_UNIX = [
  [/\bsudo\s/, () => t("sandbox.noSudo")],
  [/\bsu\s+\w/, () => t("sandbox.noSu")],
  [/\bchmod\s/, () => t("sandbox.noChmod")],
  [/\bchown\s/, () => t("sandbox.noChown")],
];

const PREFLIGHT_WIN32 = [
  [/\bdel\s+\/s/i, () => t("sandbox.noDelRecursive")],
  [/\brmdir\s+\/s/i, () => t("sandbox.noRmdirRecursive")],
  [/\breg\s+(delete|add)\b/i, () => t("sandbox.noRegEdit")],
  [/\btakeown\b/i, () => t("sandbox.noTakeown")],
  [/\bicacls\b/i, () => t("sandbox.noIcacls")],
  [/\bnet\s+(user|localgroup)\b/i, () => t("sandbox.noNetUser")],
  [/\bschtasks\s+\/create\b/i, () => t("sandbox.noSchtasks")],
  [/\bsc\s+(create|delete)\b/i, () => t("sandbox.noScService")],
  [/powershell.*-e(xecutionpolicy)?\s*(bypass|unrestricted)/i, () => t("sandbox.noPsExecutionBypass")],
  [/\bformat\s+[a-z]:/i, () => t("sandbox.noFormat")],
  [/\bbcdedit\b/i, () => t("sandbox.noBcdedit")],
  [/\bwmic\b/i, () => t("sandbox.noWmic")],
];

const PREFLIGHT_PATTERNS = process.platform === "win32"
  ? [...PREFLIGHT_UNIX, ...PREFLIGHT_WIN32]
  : PREFLIGHT_UNIX;

/**
 * 从 bash 命令中提取可能的文件路径（启发式）
 * 用于 Windows 无 OS 沙盒时的 PathGuard 校验
 */
const OP_PRIORITY = { read: 1, write: 2, delete: 3 };
const READ_PATH_COMMANDS = new Set(["cat", "ls", "less", "head", "tail", "stat", "file", "find"]);
const WRITE_PATH_COMMANDS = new Set(["touch", "mkdir", "tee"]);
const DELETE_PATH_COMMANDS = new Set(["rm", "rmdir"]);
const COPY_MOVE_COMMANDS = new Set(["cp", "mv"]);

function readShellWord(command, start) {
  let word = "";
  let quote = null;
  let i = start;

  for (; i < command.length; i++) {
    const ch = command[i];

    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }

    if (quote === "\"") {
      if (ch === "\"") {
        quote = null;
      } else if (ch === "\\" && i + 1 < command.length && /["\\$`\n]/.test(command[i + 1])) {
        word += command[++i];
      } else {
        word += ch;
      }
      continue;
    }

    if (/\s|[;&|<>]/.test(ch)) break;
    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      word += command[++i];
      continue;
    }
    word += ch;
  }

  return { word, end: i };
}

function splitShellSegments(command) {
  const segments = [];
  let quote = null;
  let escaped = false;
  let start = 0;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }

    const isSeparator = ch === ";" || ch === "|" || (ch === "&" && command[i + 1] === "&");
    if (!isSeparator) continue;

    const segment = command.slice(start, i).trim();
    if (segment) segments.push(segment);
    if ((ch === "|" || ch === "&") && command[i + 1] === ch) i++;
    start = i + 1;
  }

  const tail = command.slice(start).trim();
  if (tail) segments.push(tail);
  return segments;
}

function tokenizeShellWords(command) {
  const words = [];
  for (let i = 0; i < command.length;) {
    while (/\s/.test(command[i] || "")) i++;
    if (i >= command.length) break;
    if (/[;&|<>]/.test(command[i])) {
      i++;
      continue;
    }
    const { word, end } = readShellWord(command, i);
    if (word) words.push(word);
    i = Math.max(end, i + 1);
  }
  return words;
}

function commandName(word) {
  return String(word || "")
    .split(/[\\/]/)
    .pop()
    .replace(/\.exe$/i, "")
    .toLowerCase();
}

function normalizePathForCheck(rawPath, cwd, allowRelative) {
  if (process.platform === "win32") {
    return normalizeWin32ShellPath(rawPath, cwd, { allowRelative });
  }
  if (path.isAbsolute(rawPath)) return rawPath;
  return allowRelative && cwd ? path.resolve(cwd, rawPath) : null;
}

function rememberCheck(checks, rawPath, operation, cwd, allowRelative = false) {
  const normalized = normalizePathForCheck(rawPath, cwd, allowRelative);
  if (!normalized) return;
  const previous = checks.get(normalized);
  if (!previous || OP_PRIORITY[operation] > OP_PRIORITY[previous.operation]) {
    checks.set(normalized, { path: normalized, rawPath, operation });
  }
}

function extractRedirectionChecks(command, cwd, checks) {
  let quote = null;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }
    if (ch !== ">" && ch !== "<") continue;

    const operation = ch === ">" ? "write" : "read";
    let targetStart = i + 1;
    if (command[targetStart] === ch || command[targetStart] === "|") targetStart++;
    if (operation === "read" && command[targetStart] === "(") continue;
    while (/\s/.test(command[targetStart] || "")) targetStart++;
    if (command[targetStart] === "&") continue;

    const { word } = readShellWord(command, targetStart);
    if (word) rememberCheck(checks, word, operation, cwd, true);
  }
}

function extractSegmentChecks(segment, cwd, checks) {
  const words = tokenizeShellWords(segment);
  if (!words.length) return;

  const name = commandName(words[0]);
  const operands = words.slice(1).filter((word) => word && !word.startsWith("-"));

  for (const word of words) {
    rememberCheck(checks, word, "read", cwd, false);
  }

  if (DELETE_PATH_COMMANDS.has(name)) {
    for (const word of operands) rememberCheck(checks, word, "delete", cwd, true);
    return;
  }

  if (WRITE_PATH_COMMANDS.has(name)) {
    for (const word of operands) rememberCheck(checks, word, "write", cwd, true);
    return;
  }

  if (COPY_MOVE_COMMANDS.has(name)) {
    const pathOperands = operands.filter((word) => normalizePathForCheck(word, cwd, true));
    pathOperands.forEach((word, index) => {
      const operation = index === pathOperands.length - 1 ? "write" : "read";
      rememberCheck(checks, word, operation, cwd, true);
    });
    return;
  }

  if (READ_PATH_COMMANDS.has(name)) {
    for (const word of operands) rememberCheck(checks, word, "read", cwd, true);
  }
}

function extractPathChecks(command, cwd) {
  const checks = new Map();
  extractRedirectionChecks(command, cwd, checks);
  for (const segment of splitShellSegments(command)) {
    extractSegmentChecks(segment, cwd, checks);
  }
  return [...checks.values()];
}

/**
 * 包装路径类工具（read, write, edit, grep, find, ls）
 *
 * @param {object} tool  原始工具
 * @param {object} guard  PathGuard 实例
 * @param {string} operation  "read" | "write" | "delete"
 * @param {string} cwd  工作目录
 * @param {object} [opts]
 * @param {() => boolean} [opts.getSandboxEnabled]  动态沙盒开关（每次调用时求值）
 */
export function wrapPathTool(tool, guard, operation, cwd, opts = {}) {
  return {
    ...tool,
    execute: async (toolCallId, params, ...rest) => {
      // 沙盒动态关闭 → 直通
      if (opts.getSandboxEnabled && !opts.getSandboxEnabled()) {
        return tool.execute(toolCallId, params, ...rest);
      }

      const rawPath = params.path;
      const absolutePath = resolvePath(rawPath, cwd);
      const checkPath = absolutePath || cwd;
      const result = guard.check(checkPath, operation);

      if (!result.allowed) {
        return blockedResult(result.reason);
      }

      return tool.execute(toolCallId, params, ...rest);
    },
  };
}

/**
 * 包装 bash 工具
 *
 * 1. preflight：常见危险命令提前拦截
 * 2. 路径校验：提取命令中的绝对路径，用 PathGuard 检查（Windows 无 OS 沙盒时的安全层）
 * 3. 执行：OS 沙盒在 BashOperations.exec 里生效（macOS/Linux）
 * 4. 错误翻译：OS 沙盒拦截后 stderr 的 Operation not permitted
 *
 * @param {object} tool  原始 bash 工具（可能带 OS 沙盒 exec）
 * @param {object} [guard]  PathGuard 实例（Windows 必传，macOS/Linux 可选）
 * @param {string} [cwd]  工作目录
 * @param {object} [opts]
 * @param {() => boolean} [opts.getSandboxEnabled]  动态沙盒开关
 * @param {object} [opts.fallbackTool]  沙盒关闭时使用的原始 bash 工具（无 OS 沙盒 exec）
 */
export function wrapBashTool(tool, guard, cwd, opts = {}) {
  return {
    ...tool,
    execute: async (toolCallId, params, ...rest) => {
      // 沙盒动态关闭 → 使用无 OS 沙盒的 bash 工具，跳过 preflight 和 PathGuard
      if (opts.getSandboxEnabled && !opts.getSandboxEnabled()) {
        return (opts.fallbackTool || tool).execute(toolCallId, params, ...rest);
      }

      // preflight
      for (const [pattern, reasonFn] of PREFLIGHT_PATTERNS) {
        if (pattern.test(params.command)) {
          return blockedResult(reasonFn());
        }
      }

      // 路径校验：从命令中提取绝对路径，检查 PathGuard
      if (guard && cwd) {
        const paths = extractPathChecks(params.command, cwd);
        for (const p of paths) {
          const result = guard.check(p.path, p.operation);
          if (!result.allowed) {
            return blockedResult(t("sandbox.restrictedPath", { path: p.rawPath }));
          }
        }
      }

      try {
        const result = await tool.execute(toolCallId, params, ...rest);

        // 成功路径的错误翻译（exitCode 0 但 stderr 有 sandbox 拒绝）
        const text = result?.content?.[0]?.text;
        if (text && text.includes("Operation not permitted")) {
          result.content[0].text += "\n\n" + t("sandbox.writeRestricted");
        }

        return result;
      } catch (err) {
        // Pi SDK 对非零退出 throw Error，错误消息里包含 stderr 输出。
        // 如果是沙盒拦截导致的，追加友好提示。
        if (err.message?.includes("Operation not permitted")) {
          err.message += "\n\n" + t("sandbox.writeRestricted");
        }
        throw err;
      }
    },
  };
}
