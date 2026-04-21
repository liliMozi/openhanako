/**
 * Integration test for the /api/agents/:id/config endpoint regarding
 * tool management (Tasks 7 + 8):
 *   - PUT accepts valid tools.disabled
 *   - PUT accepts empty tools.disabled []
 *   - PUT rejects non-optional tool names (400)
 *   - PUT rejects non-array tools.disabled (400)
 *   - GET response includes availableTools field
 */
import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/memory/config-loader.js", () => ({
  saveConfig: vi.fn(),
  clearConfigCache: vi.fn(),
}));

vi.mock("../lib/tools/experience.js", () => ({
  rebuildIndex: vi.fn(),
}));

describe("agents route: tools.disabled", () => {
  let tempRoot, agentDir, app, engine;
  const agentId = "hana";

  beforeEach(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-tools-route-"));
    agentDir = path.join(tempRoot, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "config.yaml"),
      "tools:\n  disabled: []\n",
      "utf-8"
    );

    const { createAgentsRoute } = await import("../server/routes/agents.js");

    const fakeAgent = {
      id: agentId,
      tools: [
        { name: "read" },
        { name: "bash" },
        { name: "browser" },
        { name: "cron" },
        { name: "install_skill" },
        { name: "update_settings" },
      ],
    };

    engine = {
      agentsDir: tempRoot,
      currentAgentId: agentId,
      getAgent: vi.fn(() => fakeAgent),
      providerRegistry: {
        saveProvider: vi.fn(),
        removeProvider: vi.fn(),
        getAllProvidersRaw: vi.fn(() => ({})),
        get: vi.fn(() => null),
      },
      onProviderChanged: vi.fn().mockResolvedValue(undefined),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      invalidateAgentListCache: vi.fn(),
      listAgents: vi.fn(() => [{ id: agentId }]),
      // global-scope getters called by injectGlobalFields in GET handler
      getLocale: vi.fn(() => ""),
      getTimezone: vi.fn(() => ""),
      getSandbox: vi.fn(() => false),
      getFileBackup: vi.fn(() => false),
      getUpdateChannel: vi.fn(() => "stable"),
      getThinkingLevel: vi.fn(() => "auto"),
      getLearnSkills: vi.fn(() => true),
      getHeartbeatMaster: vi.fn(() => true),
    };

    app = new Hono();
    app.route("/api", createAgentsRoute(engine));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("PUT with valid tools.disabled (subset of OPTIONAL) returns 200", async () => {
    const res = await app.request(`/api/agents/${agentId}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tools: { disabled: ["browser", "cron"] } }),
    });
    expect(res.status).toBe(200);
  });

  it("PUT with empty tools.disabled array returns 200 (clearing the list)", async () => {
    const res = await app.request(`/api/agents/${agentId}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tools: { disabled: [] } }),
    });
    expect(res.status).toBe(200);
  });

  it("PUT with non-optional tool name (read) returns 400", async () => {
    const res = await app.request(`/api/agents/${agentId}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tools: { disabled: ["read"] } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("read");
    expect(body.error).toContain("Only optional tools");
  });

  it("PUT with mix of valid and invalid names returns 400 listing only invalid", async () => {
    const res = await app.request(`/api/agents/${agentId}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tools: { disabled: ["browser", "bash", "edit"] } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("bash");
    expect(body.error).toContain("edit");
    // browser is valid — must not appear in the invalid names list
    // The error message format is: "Invalid tool names in tools.disabled: bash, edit. Only optional tools..."
    // "browser" does not appear anywhere in the invalid list portion
    expect(body.error).not.toMatch(/bash.*browser|browser.*bash/);
    const invalidPortion = body.error.split(".")[0]; // "Invalid tool names in tools.disabled: bash, edit"
    expect(invalidPortion).not.toContain("browser");
  });

  it("PUT with non-array tools.disabled returns 400", async () => {
    const res = await app.request(`/api/agents/${agentId}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tools: { disabled: "browser" } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("must be an array");
  });

  it("GET response includes availableTools array from engine.getAgent", async () => {
    const res = await app.request(`/api/agents/${agentId}/config`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.availableTools)).toBe(true);
    expect(body.availableTools).toContain("read");
    expect(body.availableTools).toContain("browser");
    expect(body.availableTools).toContain("cron");
    expect(engine.getAgent).toHaveBeenCalledWith(agentId);
  });
});
