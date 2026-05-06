import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createPreferencesRoute } from "../server/routes/preferences.js";

function makeApp(engine) {
  const app = new Hono();
  app.route("/api", createPreferencesRoute(engine));
  return app;
}

describe("workspace UI preference routes", () => {
  it("persists and returns normalized workspace UI state by workspace root", async () => {
    const states = {};
    const engine = {
      getSharedModels: vi.fn(() => ({})),
      getSearchConfig: vi.fn(() => ({})),
      getUtilityApi: vi.fn(() => ({})),
      getWorkspaceUiState: vi.fn((workspace) => states[workspace] || null),
      setWorkspaceUiState: vi.fn((workspace, state) => {
        states[workspace] = state;
        return state;
      }),
    };
    const app = makeApp(engine);

    const putRes = await app.request("/api/preferences/workspace-ui-state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace: "/repo/",
        state: {
          deskExpandedPaths: ["src", "", "../escape", "src"],
          deskSelectedPath: "src/App.tsx",
          previewOpen: true,
          openTabs: ["file-src/App.tsx", "missing-tab"],
          activeTabId: "missing-tab",
          previewTabs: [
            {
              id: "file-src/App.tsx",
              filePath: "/repo/src/App.tsx",
              relativePath: "src/App.tsx",
              title: "App.tsx",
              type: "code",
              ext: "tsx",
              language: "tsx",
              content: "must not persist",
            },
          ],
        },
      }),
    });

    expect(putRes.status).toBe(200);
    const putBody = await putRes.json();
    expect(engine.setWorkspaceUiState).toHaveBeenCalledWith("/repo", expect.objectContaining({
      deskExpandedPaths: ["src"],
      previewOpen: true,
      openTabs: ["file-src/App.tsx"],
      activeTabId: "file-src/App.tsx",
    }));
    expect(putBody.state.previewTabs[0]).toEqual({
      id: "file-src/App.tsx",
      filePath: "/repo/src/App.tsx",
      relativePath: "src/App.tsx",
      title: "App.tsx",
      type: "code",
      ext: "tsx",
      language: "tsx",
    });

    const getRes = await app.request("/api/preferences/workspace-ui-state?workspace=%2Frepo%2F");
    expect(getRes.status).toBe(200);
    await expect(getRes.json()).resolves.toEqual({ state: putBody.state });
  });
});
