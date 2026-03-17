/**
 * sandbox/index.js — 沙盒入口（无状态工厂）
 *
 * 每次 buildTools 调用时创建 session 级的 PathGuard + OS 沙盒 exec。
 * 不持有 engine 级状态，天然支持多 agent 并发。
 */

import { deriveSandboxPolicy } from "./policy.js";
import { PathGuard } from "./path-guard.js";
import { detectPlatform, checkAvailability } from "./platform.js";
import { createSeatbeltExec } from "./seatbelt.js";
import { createBwrapExec } from "./bwrap.js";
import { createWin32Exec } from "./win32-exec.js";
import { wrapPathTool, wrapBashTool } from "./tool-wrapper.js";
import { createEnhancedReadFile } from "./read-enhanced.js";
import { constants } from "fs";
import { access as fsAccess } from "fs/promises";
import { extname } from "path";
import {
  createReadTool,
  createWriteTool,
  createEditTool,
  createBashTool,
  createGrepTool,
  createFindTool,
  createLsTool,
} from "@mariozechner/pi-coding-agent";

/**
 * 为一个 session 创建沙盒包装后的工具集
 *
 * 每次调用独立，不共享状态。
 *
 * @param {string} cwd  工作目录
 * @param {object[]} customTools  自定义工具
 * @param {object} opts
 * @param {string} opts.agentDir
 * @param {string|null} opts.workspace
 * @param {string} opts.hanakoHome
 * @param {"standard"|"full-access"} opts.mode
 * @returns {{ tools: object[], customTools: object[] }}
 */
export function createSandboxedTools(cwd, customTools, { agentDir, workspace, hanakoHome, mode }) {
  const policy = deriveSandboxPolicy({ agentDir, workspace, hanakoHome, mode });
  // 增强 readFile：xlsx 解析 + 编码检测，保留 PI SDK 默认的 access / detectImageMimeType
  const IMAGE_MIMES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" };
  const readOps = {
    readFile: createEnhancedReadFile(),
    access: (p) => fsAccess(p, constants.R_OK),
    detectImageMimeType: async (p) => IMAGE_MIMES[extname(p).toLowerCase()] || undefined,
  };

  // full-access: 不包装，直接返回原始工具
  // Windows 即使 full-access 也要用自定义 exec（PI SDK 默认的 detached 导致空输出 + shell 查找不含内嵌 Git）
  if (policy.mode === "full-access") {
    const isWin32 = process.platform === "win32";
    const bashTool = isWin32
      ? createBashTool(cwd, { operations: { exec: createWin32Exec() } })
      : createBashTool(cwd);
    return {
      tools: [
        createReadTool(cwd, { operations: readOps }),
        createWriteTool(cwd),
        createEditTool(cwd),
        bashTool,
        createGrepTool(cwd),
        createFindTool(cwd),
        createLsTool(cwd),
      ],
      customTools,
    };
  }

  // standard: PathGuard + OS 沙盒 exec
  const platform = detectPlatform();
  const guard = new PathGuard(policy);

  // Windows: PathGuard 包装生效，bash 用自定义 exec（避免 detached 导致空输出）
  if (platform === "win32-full-access") {
    const win32BashOps = { exec: createWin32Exec() };
    return {
      tools: [
        wrapPathTool(createReadTool(cwd, { operations: readOps }), guard, "read", cwd),
        wrapPathTool(createWriteTool(cwd), guard, "write", cwd),
        wrapPathTool(createEditTool(cwd), guard, "write", cwd),
        wrapBashTool(createBashTool(cwd, { operations: win32BashOps }), guard, cwd),
        wrapPathTool(createGrepTool(cwd), guard, "read", cwd),
        wrapPathTool(createFindTool(cwd), guard, "read", cwd),
        wrapPathTool(createLsTool(cwd), guard, "read", cwd),
      ],
      customTools,
    };
  }

  if (!checkAvailability(platform)) {
    throw new Error(
      `[sandbox] standard 模式要求 OS 级沙盒，但当前平台不支持（${platform}）。` +
      `请安装 sandbox-exec (macOS) 或 bubblewrap (Linux)，或切换到 full-access 模式。`
    );
  }

  const sandboxExec = platform === "seatbelt"
    ? createSeatbeltExec(policy)
    : createBwrapExec(policy);
  const bashOps = { exec: sandboxExec };

  return {
    tools: [
      wrapPathTool(createReadTool(cwd, { operations: readOps }), guard, "read", cwd),
      wrapPathTool(createWriteTool(cwd), guard, "write", cwd),
      wrapPathTool(createEditTool(cwd), guard, "write", cwd),
      wrapBashTool(createBashTool(cwd, { operations: bashOps })),
      wrapPathTool(createGrepTool(cwd), guard, "read", cwd),
      wrapPathTool(createFindTool(cwd), guard, "read", cwd),
      wrapPathTool(createLsTool(cwd), guard, "read", cwd),
    ],
    customTools,
  };
}
