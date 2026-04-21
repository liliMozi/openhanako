/**
 * Guards against drift between:
 *   - shared/tool-categories.js OPTIONAL_TOOL_NAMES (backend source of truth)
 *   - desktop/src/react/settings/tabs/agent/AgentToolsSection.tsx
 *     OPTIONAL_TOOL_NAMES (frontend copy)
 *
 * Frontend intentionally does not import from shared/ to keep the desktop
 * bundle independent of node-only code. This test is the safety net for that
 * duplication: if the two lists ever differ, fail loudly.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { OPTIONAL_TOOL_NAMES, DEFAULT_DISABLED_TOOL_NAMES } from "../shared/tool-categories.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("OPTIONAL_TOOL_NAMES frontend/backend drift", () => {
  it("frontend copy in AgentToolsSection.tsx matches shared/tool-categories.js", () => {
    const tsxPath = resolve(
      __dirname,
      "../desktop/src/react/settings/tabs/agent/AgentToolsSection.tsx"
    );
    const src = readFileSync(tsxPath, "utf8");

    const match = src.match(
      /const\s+OPTIONAL_TOOL_NAMES\s*=\s*\[([\s\S]*?)\]\s*as\s+const/
    );
    expect(
      match,
      "Could not find `const OPTIONAL_TOOL_NAMES = [...] as const` in AgentToolsSection.tsx"
    ).toBeTruthy();

    const arrayBody = match[1];
    const names = [...arrayBody.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);

    expect(new Set(names)).toEqual(new Set(OPTIONAL_TOOL_NAMES));
  });

  it("DEFAULT_DISABLED_TOOL_NAMES is a subset of OPTIONAL_TOOL_NAMES", () => {
    // If a name is in DEFAULT_DISABLED but not in OPTIONAL, the backend PUT
    // whitelist would reject a user trying to re-enable it — a latent bug.
    const optional = new Set(OPTIONAL_TOOL_NAMES);
    for (const name of DEFAULT_DISABLED_TOOL_NAMES) {
      expect(optional.has(name)).toBe(true);
    }
  });

  it("AgentTab.tsx default-disabled list matches DEFAULT_DISABLED_TOOL_NAMES", () => {
    // AgentTab.tsx has an inline default used when settingsConfig.tools.disabled
    // is undefined. It must match the backend constant so fresh agents render
    // the same initial state the backend will compute.
    const tsxPath = resolve(
      __dirname,
      "../desktop/src/react/settings/tabs/AgentTab.tsx"
    );
    const src = readFileSync(tsxPath, "utf8");

    const match = src.match(
      /disabled=\{settingsConfig\?\.tools\?\.disabled\s*\?\?\s*\[([\s\S]*?)\]\}/
    );
    expect(
      match,
      "Could not find the default-disabled inline list in AgentTab.tsx"
    ).toBeTruthy();

    const names = [...match[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
    expect(new Set(names)).toEqual(new Set(DEFAULT_DISABLED_TOOL_NAMES));
  });
});
