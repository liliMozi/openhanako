/**
 * config-loader.js 单元测试
 *
 * 测试：加载、保存（含 deep merge）、atomic write、缓存清除
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import {
  loadConfig,
  saveConfig,
  clearConfigCache,
  resolveModelApi,
  getAllProviders,
} from "../lib/memory/config-loader.js";

const tmpDir = path.join(os.tmpdir(), "hana-test-config-" + Date.now());
const configPath = path.join(tmpDir, "config.yaml");
const hanakoHome = path.join(tmpDir, ".hanako");

function writeYaml(obj) {
  fs.writeFileSync(configPath, YAML.dump(obj), "utf-8");
}

function readYaml() {
  return YAML.load(fs.readFileSync(configPath, "utf-8"));
}

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(hanakoHome, { recursive: true });
  process.env.HANA_HOME = hanakoHome;
  clearConfigCache();
});

afterEach(() => {
  clearConfigCache();
  delete process.env.HANA_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("加载基础配置", () => {
    writeYaml({ api: { provider: "openai", api_key: "sk-test", base_url: "https://api.openai.com/v1" } });
    const cfg = loadConfig(configPath);
    expect(cfg.api.provider).toBe("openai");
    expect(cfg.api.api_key).toBe("sk-test");
  });

  it("缓存生效：第二次读取返回同一对象", () => {
    writeYaml({ api: { provider: "openai", api_key: "sk-test", base_url: "https://api.openai.com/v1" } });
    const a = loadConfig(configPath);
    const b = loadConfig(configPath);
    expect(a).toBe(b);
  });

  it("clearConfigCache 后重新读取", () => {
    writeYaml({ api: { provider: "openai", api_key: "sk-1", base_url: "https://api.openai.com/v1" } });
    const a = loadConfig(configPath);
    clearConfigCache();
    writeYaml({ api: { provider: "openai", api_key: "sk-2", base_url: "https://api.openai.com/v1" } });
    const b = loadConfig(configPath);
    expect(a.api.api_key).toBe("sk-1");
    expect(b.api.api_key).toBe("sk-2");
  });

  it("embedding_api 未配置时保持为空", () => {
    writeYaml({ api: { provider: "openai", api_key: "sk-test", base_url: "https://api.openai.com/v1" } });
    const cfg = loadConfig(configPath);
    expect(cfg.embedding_api).toBeNull();
  });

  it("provider 缺失时不再注入默认供应商", () => {
    writeYaml({ api: { api_key: "sk-test", base_url: "https://api.openai.com/v1" } });
    const cfg = loadConfig(configPath);
    expect(cfg.api.provider).toBe("");
  });

  it("从 providers.yaml 解析 API 协议", () => {
    fs.writeFileSync(
      path.join(hanakoHome, "providers.yaml"),
      YAML.dump({
        providers: {
          openai: {
            base_url: "https://api.openai.com/v1",
            api_key: "sk-test",
            api: "openai-completions",
          },
        },
      }),
      "utf-8",
    );
    writeYaml({ api: { provider: "openai" } });
    const cfg = loadConfig(configPath);
    expect(cfg.api.api).toBe("openai-completions");
  });

  it("resolveModelApi 从 models.json 找 provider，从 auth.json 补 api_key", () => {
    fs.writeFileSync(
      path.join(hanakoHome, "providers.yaml"),
      YAML.dump({
        providers: {
          "openai-codex": {
            base_url: "https://chatgpt.com/backend-api",
            api: "openai-codex-responses",
          },
        },
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(hanakoHome, "models.json"),
      JSON.stringify({
        providers: {
          "openai-codex": {
            models: [{ id: "gpt-5.4" }],
          },
        },
      }, null, 2),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(hanakoHome, "auth.json"),
      JSON.stringify({
        "openai-codex": { access: "oauth-token" },
      }, null, 2),
      "utf-8",
    );
    writeYaml({ api: { provider: "openai-codex" } });

    const result = resolveModelApi("gpt-5.4", configPath);
    expect(result.provider).toBe("openai-codex");
    expect(result.api).toBe("openai-codex-responses");
    expect(result.api_key).toBe("oauth-token");
  });

  it("getAllProviders 会合并 models.json 中的模型列表", () => {
    fs.writeFileSync(
      path.join(hanakoHome, "providers.yaml"),
      YAML.dump({
        providers: {
          dashscope: {
            base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            api_key: "sk-test",
            api: "openai-completions",
          },
        },
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(hanakoHome, "models.json"),
      JSON.stringify({
        providers: {
          dashscope: {
            models: [{ id: "qwen-plus" }, { id: "qwen-max" }],
          },
        },
      }, null, 2),
      "utf-8",
    );
    writeYaml({ api: { provider: "dashscope" } });

    const providers = getAllProviders(configPath);
    expect(providers.dashscope.models).toEqual(["qwen-plus", "qwen-max"]);
  });
});

describe("saveConfig", () => {
  it("deep merge 保留已有字段", () => {
    writeYaml({ api: { provider: "openai", api_key: "sk-1", base_url: "https://api.openai.com/v1" }, user: { name: "Alice" } });
    saveConfig(configPath, { user: { age: 18 } });
    const result = readYaml();
    expect(result.user.name).toBe("Alice");
    expect(result.user.age).toBe(18);
    expect(result.api.provider).toBe("openai");
  });

  it("null 值删除对应 key", () => {
    writeYaml({ api: { provider: "openai" }, debug: true });
    saveConfig(configPath, { debug: null });
    const result = readYaml();
    expect(result.debug).toBeUndefined();
    expect(result.api.provider).toBe("openai");
  });

  it("数组直接覆盖（不合并）", () => {
    writeYaml({ tags: ["a", "b"] });
    saveConfig(configPath, { tags: ["c"] });
    const result = readYaml();
    expect(result.tags).toEqual(["c"]);
  });

  it("atomic write：不会留下 .tmp 文件", () => {
    writeYaml({ api: { provider: "openai" } });
    saveConfig(configPath, { user: { name: "Test" } });
    const files = fs.readdirSync(tmpDir);
    expect(files).not.toContain("config.yaml.tmp");
    expect(files).toContain("config.yaml");
  });

  it("保存后缓存被清除（下次 loadConfig 读到新值）", () => {
    writeYaml({ api: { provider: "openai", api_key: "sk-1", base_url: "https://api.openai.com/v1" } });
    loadConfig(configPath);
    saveConfig(configPath, { api: { api_key: "sk-2" } });
    const cfg = loadConfig(configPath);
    expect(cfg.api.api_key).toBe("sk-2");
  });
});
