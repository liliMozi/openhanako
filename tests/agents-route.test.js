import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

vi.mock("../lib/memory/config-loader.js", () => ({
  saveConfig: vi.fn(),
  clearConfigCache: vi.fn(),
  loadConfig: vi.fn((filePath) => YAML.parse(fs.readFileSync(filePath, "utf-8"))),
}));

describe("agents route", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-agents-route-"));

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.mkdirSync(tempRoot, { recursive: true });
  });

  it("editing another agent config can clear saved provider credentials", async () => {
    const agentId = "hana";
    const agentDir = path.join(tempRoot, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), "api:\n  provider: openai\n", "utf-8");

    const { createAgentsRoute } = await import("../server/routes/agents.js");
    const app = new Hono();
    const saveProvider = vi.fn();
    const engine = {
      agentsDir: tempRoot,
      currentAgentId: "other",
      providerRegistry: {
        saveProvider,
        removeProvider: vi.fn(),
        getAllProvidersRaw: vi.fn(() => ({})),
        get: vi.fn(() => null),
      },
      onProviderChanged: vi.fn().mockResolvedValue(undefined),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      invalidateAgentListCache: vi.fn(),
      listAgents: vi.fn(() => []),
    };

    app.route("/api", createAgentsRoute(engine));

    const res = await app.request(`/api/agents/${agentId}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api: {
          api_key: "",
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(saveProvider).toHaveBeenCalledWith("openai", { api_key: "" });
    expect(engine.onProviderChanged).toHaveBeenCalledTimes(1);
  });

  it("rejects dangerous experience headings without overwriting agent files", async () => {
    const agentId = "hana";
    const agentDir = path.join(tempRoot, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: Hana\n", "utf-8");
    fs.writeFileSync(path.join(agentDir, "identity.md"), "original identity\n", "utf-8");

    const { createAgentsRoute } = await import("../server/routes/agents.js");
    const app = new Hono();
    const engine = {
      agentsDir: tempRoot,
      currentAgentId: agentId,
      providerRegistry: {
        saveProvider: vi.fn(),
        removeProvider: vi.fn(),
        getAllProvidersRaw: vi.fn(() => ({})),
        get: vi.fn(() => null),
      },
      onProviderChanged: vi.fn().mockResolvedValue(undefined),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      invalidateAgentListCache: vi.fn(),
      listAgents: vi.fn(() => []),
    };

    app.route("/api", createAgentsRoute(engine));

    const res = await app.request(`/api/agents/${agentId}/experience`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "# ../identity\nmalicious overwrite\n",
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid experience category" });
    expect(fs.readFileSync(path.join(agentDir, "identity.md"), "utf-8")).toBe("original identity\n");
    expect(engine.updateConfig).not.toHaveBeenCalled();
  });
});
