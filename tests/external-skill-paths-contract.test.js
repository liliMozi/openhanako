import { describe, expect, it } from "vitest";

import { WELL_KNOWN_SKILL_PATHS } from "../core/engine.js";

describe("external compatible skill path contract", () => {
  it("keeps global Pi agent skills as a compatible external skill source", () => {
    expect(WELL_KNOWN_SKILL_PATHS).toContainEqual({
      suffix: ".pi/agent/skills",
      label: "Pi",
    });
  });
});
