import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import {
  configureProcessPiSdkEnv,
  ensureHanaPiSdkDirs,
  resolveHanakoHome,
  resolveHanaPiAgentDir,
  resolveHanaPiProjectDir,
  withHanaPiSdkEnv,
} from "../shared/hana-runtime-paths.js";

describe("Hana runtime path contracts", () => {
  it("derives the Pi SDK agent directory from HANA_HOME", () => {
    const hanakoHome = path.join(os.tmpdir(), "hana-runtime-paths", ".hanako-dev");

    expect(resolveHanaPiAgentDir(hanakoHome)).toBe(path.join(hanakoHome, ".pi", "agent"));
    expect(resolveHanaPiProjectDir(hanakoHome)).toBe(path.join(hanakoHome, ".pi", "project"));
  });

  it("normalizes HANA_HOME before deriving Pi SDK paths", () => {
    const homeDir = path.join(os.tmpdir(), "hana-runtime-home");

    expect(resolveHanakoHome("~/.hanako-dev", homeDir)).toBe(path.join(homeDir, ".hanako-dev"));
  });

  it("adds PI_CODING_AGENT_DIR without dropping existing environment", () => {
    const hanakoHome = path.join(os.tmpdir(), "hana-runtime-env", ".hanako");
    const baseEnv = { PATH: "/usr/bin", PI_CODING_AGENT_DIR: "/old-pi" };

    expect(withHanaPiSdkEnv(baseEnv, hanakoHome)).toEqual({
      PATH: "/usr/bin",
      PI_CODING_AGENT_DIR: path.join(hanakoHome, ".pi", "agent"),
    });
    expect(baseEnv.PI_CODING_AGENT_DIR).toBe("/old-pi");
  });

  it("can install the Pi SDK agent directory into a process env object", () => {
    const hanakoHome = path.join(os.tmpdir(), "hana-runtime-process", ".hanako");
    const env = {};

    expect(configureProcessPiSdkEnv(hanakoHome, env)).toBe(path.join(hanakoHome, ".pi", "agent"));
    expect(env.PI_CODING_AGENT_DIR).toBe(path.join(hanakoHome, ".pi", "agent"));
  });

  it("creates Hana-owned Pi SDK directories explicitly", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-runtime-dirs-"));
    const hanakoHome = path.join(root, ".hanako");

    ensureHanaPiSdkDirs(hanakoHome);

    expect(fs.statSync(path.join(hanakoHome, ".pi", "agent")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(hanakoHome, ".pi", "project")).isDirectory()).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
