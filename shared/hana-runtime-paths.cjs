const os = require("os");
const path = require("path");
const fs = require("fs");

const PI_SDK_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

function expandHome(input, homeDir = os.homedir()) {
  if (!input) return input;
  if (input === "~") return homeDir;
  if (input.startsWith("~/") || input.startsWith("~" + path.sep)) {
    return path.join(homeDir, input.slice(2));
  }
  return input;
}

function resolveHanakoHome(input, homeDir = os.homedir()) {
  const raw = input || path.join(homeDir, ".hanako");
  return path.resolve(expandHome(raw, homeDir));
}

function resolveHanaPiRoot(hanakoHome) {
  if (!hanakoHome || typeof hanakoHome !== "string") {
    throw new Error("resolveHanaPiRoot: hanakoHome is required");
  }
  return path.join(hanakoHome, ".pi");
}

function resolveHanaPiAgentDir(hanakoHome) {
  return path.join(resolveHanaPiRoot(hanakoHome), "agent");
}

function resolveHanaPiProjectDir(hanakoHome) {
  return path.join(resolveHanaPiRoot(hanakoHome), "project");
}

function withHanaPiSdkEnv(env, hanakoHome) {
  return {
    ...env,
    [PI_SDK_AGENT_DIR_ENV]: resolveHanaPiAgentDir(hanakoHome),
  };
}

function ensureHanaPiSdkDirs(hanakoHome) {
  fs.mkdirSync(resolveHanaPiAgentDir(hanakoHome), { recursive: true });
  fs.mkdirSync(resolveHanaPiProjectDir(hanakoHome), { recursive: true });
}

function configureProcessPiSdkEnv(hanakoHome, env = process.env) {
  const agentDir = resolveHanaPiAgentDir(hanakoHome);
  env[PI_SDK_AGENT_DIR_ENV] = agentDir;
  return agentDir;
}

module.exports = {
  PI_SDK_AGENT_DIR_ENV,
  configureProcessPiSdkEnv,
  ensureHanaPiSdkDirs,
  resolveHanakoHome,
  resolveHanaPiAgentDir,
  resolveHanaPiProjectDir,
  resolveHanaPiRoot,
  withHanaPiSdkEnv,
};
