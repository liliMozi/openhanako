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
import { t } from "../../server/i18n.js";
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
} from "../pi-sdk/index.js";

/**
 * 为一个 session 创建沙盒包装后的工具集
 *
 * 每次调用独立，不共享状态。
 * 当传入 getSandboxEnabled 回调时，工具在每次调用时动态检查沙盒状态，
 * 切换偏好后无需重建 session 即可生效。
 *
 * @param {string} cwd  工作目录
 * @param {object[]} customTools  自定义工具
 * @param {object} opts
 * @param {string} opts.agentDir
 * @param {string|null} opts.workspace
 * @param {string} opts.hanakoHome
 * @param {() => boolean} opts.getSandboxEnabled  动态沙盒开关（每次工具调用时求值）
 * @returns {{ tools: object[], customTools: object[] }}
 */
export function createSandboxedTools(cwd, customTools, { agentDir, workspace, hanakoHome, getSandboxEnabled }) {
  // 始终按 standard 模式构建策略和 PathGuard，wrappers 在运行时动态 bypass
  const policy = deriveSandboxPolicy({ agentDir, workspace, hanakoHome, mode: "standard" });
  const guard = new PathGuard(policy);

  // 增强 readFile：xlsx 解析 + 编码检测，保留 PI SDK 默认的 access / detectImageMimeType
  const IMAGE_MIMES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" };
  const readOps = {
    readFile: createEnhancedReadFile(),
    access: (p) => fsAccess(p, constants.R_OK),
    detectImageMimeType: async (p) => IMAGE_MIMES[extname(p).toLowerCase()] || undefined,
  };

  const platform = detectPlatform();
  const isWin32 = process.platform === "win32";
  const wrapOpts = { getSandboxEnabled };

  // 无 OS 沙盒时的 bash 工具（沙盒关闭时回退用）
  const normalBashTool = isWin32
    ? createBashTool(cwd, { operations: { exec: createWin32Exec() } })
    : createBashTool(cwd);

  const bashWrapOpts = { getSandboxEnabled, fallbackTool: normalBashTool };

  // ── Windows: PathGuard 包装 + win32 exec（无 OS 沙盒）──
  if (platform === "win32-full-access") {
    return {
      tools: [
        wrapPathTool(createReadTool(cwd, { operations: readOps }), guard, "read", cwd, wrapOpts),
        wrapPathTool(createWriteTool(cwd), guard, "write", cwd, wrapOpts),
        wrapPathTool(createEditTool(cwd), guard, "write", cwd, wrapOpts),
        wrapBashTool(normalBashTool, guard, cwd, bashWrapOpts),
        wrapPathTool(createGrepTool(cwd), guard, "read", cwd, wrapOpts),
        wrapPathTool(createFindTool(cwd), guard, "read", cwd, wrapOpts),
        wrapPathTool(createLsTool(cwd), guard, "read", cwd, wrapOpts),
      ],
      customTools,
    };
  }

  // ── macOS / Linux: PathGuard + OS 沙盒 ──
  // OS 沙盒不可用时退化为 PathGuard-only（与 Windows 同等安全级别）
  let sandboxedBashTool = normalBashTool;
  if (checkAvailability(platform)) {
    const sandboxExec = platform === "seatbelt"
      ? createSeatbeltExec(policy)
      : createBwrapExec(policy);
    sandboxedBashTool = createBashTool(cwd, { operations: { exec: sandboxExec } });
  }

  return {
    tools: [
      wrapPathTool(createReadTool(cwd, { operations: readOps }), guard, "read", cwd, wrapOpts),
      wrapPathTool(createWriteTool(cwd), guard, "write", cwd, wrapOpts),
      wrapPathTool(createEditTool(cwd), guard, "write", cwd, wrapOpts),
      wrapBashTool(sandboxedBashTool, guard, cwd, bashWrapOpts),
      wrapPathTool(createGrepTool(cwd), guard, "read", cwd, wrapOpts),
      wrapPathTool(createFindTool(cwd), guard, "read", cwd, wrapOpts),
      wrapPathTool(createLsTool(cwd), guard, "read", cwd, wrapOpts),
    ],
    customTools,
  };
}
