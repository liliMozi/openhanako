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
import { wrapPathTool, wrapBashTool } from "./tool-wrapper.js";
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

  // full-access: 不包装，直接返回原始工具
  if (policy.mode === "full-access") {
    return {
      tools: [
        createReadTool(cwd),
        createWriteTool(cwd),
        createEditTool(cwd),
        createBashTool(cwd),
        createGrepTool(cwd),
        createFindTool(cwd),
        createLsTool(cwd),
      ],
      customTools,
    };
  }

  // standard: PathGuard + OS 沙盒 exec
  const platform = detectPlatform();
  if (!checkAvailability(platform)) {
    throw new Error(
      `[sandbox] standard 模式要求 OS 级沙盒，但当前平台不支持（${platform}）。` +
      `请安装 sandbox-exec (macOS) 或 bubblewrap (Linux)，或切换到 full-access 模式。`
    );
  }

  const guard = new PathGuard(policy);

  const sandboxExec = platform === "seatbelt"
    ? createSeatbeltExec(policy)
    : createBwrapExec(policy);
  const bashOps = { exec: sandboxExec };

  return {
    tools: [
      wrapPathTool(createReadTool(cwd), guard, "read", cwd),
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
