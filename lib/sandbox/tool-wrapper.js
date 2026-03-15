/**
 * tool-wrapper.js — 工具沙盒包装
 *
 * 在 Pi SDK 工具的 execute 外面套一层路径校验。
 * 被拦截时返回 LLM 可读的文本错误，不抛异常。
 *
 * bash 工具的 preflight 检查（sudo 等）是体验层，不是安全边界。
 * 安全边界在 OS 沙盒（seatbelt/bwrap）。
 */

import path from "path";

/** 构造被拦截时返回给 LLM 的结果 */
function blockedResult(reason) {
  return {
    content: [{ type: "text", text: `[sandbox] ${reason}` }],
  };
}

/** 解析工具参数中的路径为绝对路径 */
function resolvePath(rawPath, cwd) {
  if (!rawPath) return null;
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
}

/**
 * 轻量 preflight 模式匹配（体验层）
 * 提前拦截常见危险命令，给 LLM 清晰错误消息。
 * 安全边界在 OS 沙盒，这里只优化交互体验。
 */
const PREFLIGHT_PATTERNS = [
  [/\bsudo\s/, "禁止使用 sudo"],
  [/\bsu\s+\w/, "禁止使用 su 切换用户"],
  [/\bchmod\s/, "禁止修改文件权限"],
  [/\bchown\s/, "禁止修改文件所有者"],
];

/**
 * 包装路径类工具（read, write, edit, grep, find, ls）
 */
export function wrapPathTool(tool, guard, operation, cwd) {
  return {
    ...tool,
    execute: async (toolCallId, params, ...rest) => {
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
 * 2. 执行：OS 沙盒在 BashOperations.exec 里生效
 * 3. 错误翻译：OS 沙盒拦截后 stderr 的 Operation not permitted
 */
export function wrapBashTool(tool) {
  return {
    ...tool,
    execute: async (toolCallId, params, ...rest) => {
      // preflight
      for (const [pattern, reason] of PREFLIGHT_PATTERNS) {
        if (pattern.test(params.command)) {
          return blockedResult(reason);
        }
      }

      try {
        const result = await tool.execute(toolCallId, params, ...rest);

        // 成功路径的错误翻译（exitCode 0 但 stderr 有 sandbox 拒绝）
        const text = result?.content?.[0]?.text;
        if (text && text.includes("Operation not permitted")) {
          result.content[0].text += "\n\n[sandbox] 文件系统写入被限制在工作空间内";
        }

        return result;
      } catch (err) {
        // Pi SDK 对非零退出 throw Error，错误消息里包含 stderr 输出。
        // 如果是沙盒拦截导致的，追加友好提示。
        if (err.message?.includes("Operation not permitted")) {
          err.message += "\n\n[sandbox] 文件系统写入被限制在工作空间内";
        }
        throw err;
      }
    },
  };
}
