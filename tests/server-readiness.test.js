/**
 * 测试 server 启动前的"文件就绪性校验"逻辑（issue #484）。
 *
 * 场景动机：Windows 自动更新（NSIS overlay + Defender 扫描锁）会让新版本文件
 * 落地有几秒到几分钟延迟，server 进程在文件就绪前 spawn 会立刻 ERR_MODULE_NOT_FOUND。
 * 这套逻辑在 spawn 前先做退避检查，并能把 stderr 解析成"模块缺失"的可重试信号。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  ensureServerFilesReady,
  isModuleResolutionError,
  CRITICAL_BUNDLED_EXTERNALS,
  CRITICAL_BUNDLED_FILES,
} from "../desktop/src/shared/server-readiness.cjs";

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "server-readiness-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writePkg(pkgName) {
  const dir = path.join(tmp, "node_modules", pkgName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: pkgName }));
}

function writeCriticalFile(fileName) {
  const filePath = path.join(tmp, fileName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "");
}

function writeAllCriticalFiles() {
  for (const fileName of CRITICAL_BUNDLED_FILES) writeCriticalFile(fileName);
}

describe("ensureServerFilesReady", () => {
  it("所有关键 external 都在 → 立即 ok", async () => {
    for (const pkg of CRITICAL_BUNDLED_EXTERNALS) writePkg(pkg);
    writeAllCriticalFiles();
    const result = await ensureServerFilesReady(tmp);
    expect(result).toEqual({ ok: true });
  });

  it("缺失全部 → 退避耗尽后返回 missing 列表", async () => {
    let sleeps = 0;
    const result = await ensureServerFilesReady(tmp, {
      backoffMs: [1, 1, 1],
      sleep: async () => { sleeps++; },
    });
    expect(result.ok).toBe(false);
    expect(result.missing.sort()).toEqual([
      ...CRITICAL_BUNDLED_EXTERNALS.map((name) => `node_modules/${name}/package.json`),
      ...CRITICAL_BUNDLED_FILES,
    ].sort());
    expect(sleeps).toBe(3);
    expect(typeof result.waitedMs).toBe("number");
  });

  it("初次缺失，第二次 sleep 后文件就绪 → ok", async () => {
    // 模拟自动更新：文件在第一次 sleep 期间落地
    let sleepCount = 0;
    const sleep = async () => {
      sleepCount++;
      if (sleepCount === 1) {
        for (const pkg of CRITICAL_BUNDLED_EXTERNALS) writePkg(pkg);
        writeAllCriticalFiles();
      }
    };
    const result = await ensureServerFilesReady(tmp, {
      backoffMs: [1, 1, 1, 1, 1, 1],
      sleep,
    });
    expect(result).toEqual({ ok: true });
    expect(sleepCount).toBe(1);
  });

  it("仅缺 ws 一个包 → 退避耗尽后只报 ws", async () => {
    for (const pkg of CRITICAL_BUNDLED_EXTERNALS.filter(p => p !== "ws")) writePkg(pkg);
    writeAllCriticalFiles();
    const result = await ensureServerFilesReady(tmp, {
      backoffMs: [1, 1],
      sleep: async () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["node_modules/ws/package.json"]);
  });

  it("onRetry 回调能拿到首次缺失列表", async () => {
    let firstMissing = null;
    await ensureServerFilesReady(tmp, {
      backoffMs: [1],
      sleep: async () => {},
      onRetry: (missing) => { firstMissing = missing; },
    });
    expect(firstMissing).toEqual(expect.arrayContaining([
      ...CRITICAL_BUNDLED_EXTERNALS.map((name) => `node_modules/${name}/package.json`),
      ...CRITICAL_BUNDLED_FILES,
    ]));
  });

  it("缺 bootstrap 文件时不进入 spawn 阶段", async () => {
    for (const pkg of CRITICAL_BUNDLED_EXTERNALS) writePkg(pkg);
    for (const fileName of CRITICAL_BUNDLED_FILES.filter((fileName) => fileName !== "bootstrap.js")) {
      writeCriticalFile(fileName);
    }

    const result = await ensureServerFilesReady(tmp, {
      backoffMs: [1],
      sleep: async () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["bootstrap.js"]);
  });
});

describe("isModuleResolutionError", () => {
  it("识别 ESM Cannot find package 'X'", () => {
    const stderr = [
      "[stderr] Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'ws' imported from .../bundle/index.js\n",
    ];
    expect(isModuleResolutionError(stderr)).toBe("ws");
  });

  it("识别 CJS Cannot find module 'X'", () => {
    const stderr = [
      "[stderr] Error: Cannot find module 'better-sqlite3'\n",
      "[stderr]     at Function.Module._resolveFilename ...\n",
    ];
    expect(isModuleResolutionError(stderr)).toBe("better-sqlite3");
  });

  it("仅有 ERR_MODULE_NOT_FOUND 标记 → fallback unknown-module", () => {
    const stderr = ["[stderr] code: 'ERR_MODULE_NOT_FOUND'\n"];
    expect(isModuleResolutionError(stderr)).toBe("unknown-module");
  });

  it("无关错误 → null", () => {
    expect(isModuleResolutionError(["[stderr] TypeError: foo is not a function\n"])).toBe(null);
    expect(isModuleResolutionError([])).toBe(null);
    expect(isModuleResolutionError(null)).toBe(null);
  });

  it("issue #484 真实日志 → 抽出 ws", () => {
    // 来自 https://github.com/liliMozi/openhanako/issues/484
    const real = [
      "[stderr] node:internal/modules/package_json_reader:256\n",
      "[stderr]   throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);\n",
      "[stderr]         ^\n",
      "[stderr] \n",
      "[stderr] Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'ws' imported from D:\\1\\openHanako\\resources\\server\\bundle\\index.js\n",
    ];
    expect(isModuleResolutionError(real)).toBe("ws");
  });
});
