/**
 * patch-pi-sdk.cjs — postinstall 补丁
 *
 * 修复 Pi SDK createAgentSession() 没有把 options.tools 作为
 * baseToolsOverride 传给 AgentSession 的问题。
 *
 * AgentSession 本身支持 baseToolsOverride，但 createAgentSession()
 * 只取了 tool name 列表，丢弃了实际的 tool 对象，导致 session
 * 回退到 SDK 内置默认工具。Windows 上内置 bash 工具找不到 shell，
 * 所有命令返回 exit code 1 + 空输出。
 *
 * See: https://github.com/anthropics/openhanako/issues/221
 */

const fs = require("fs");
const path = require("path");

const target = path.join(
  __dirname, "..",
  "node_modules", "@mariozechner", "pi-coding-agent",
  "dist", "core", "sdk.js"
);

if (!fs.existsSync(target)) {
  console.log("[patch-pi-sdk] sdk.js not found, skipping");
  process.exit(0);
}

let code = fs.readFileSync(target, "utf8");

if (code.includes("baseToolsOverride")) {
  console.log("[patch-pi-sdk] already patched, skipping");
  process.exit(0);
}

const needle = "        initialActiveToolNames,\n        extensionRunnerRef,";
const replacement =
  "        initialActiveToolNames,\n" +
  "        baseToolsOverride: options.tools\n" +
  "            ? Object.fromEntries(options.tools.map(t => [t.name, t]))\n" +
  "            : undefined,\n" +
  "        extensionRunnerRef,";

if (!code.includes(needle)) {
  console.warn(
    "[patch-pi-sdk] sdk.js structure changed, cannot apply patch " +
    "— custom bash tools may not work on Windows"
  );
  process.exit(0);
}

code = code.replace(needle, replacement);
fs.writeFileSync(target, code, "utf8");
console.log("[patch-pi-sdk] patched createAgentSession → baseToolsOverride wired through");
