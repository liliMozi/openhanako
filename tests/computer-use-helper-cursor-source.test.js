import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const helperSourceDir = path.join(
  process.cwd(),
  "desktop/native/HanaComputerUseHelper/Sources/HanaComputerUseHelper",
);

describe("Hana computer-use helper cursor integration", () => {
  it("leaves native cursor visibility under provider control", () => {
    const main = fs.readFileSync(path.join(helperSourceDir, "main.swift"), "utf8");

    expect(main).not.toContain("AgentCursor.shared.setEnabled(false)");
  });

  it("bootstraps AppKit and applies cursor config before one-shot tool calls", () => {
    const main = fs.readFileSync(path.join(helperSourceDir, "main.swift"), "utf8");

    expect(main).toContain("import AppKit");
    expect(main).toContain("AppKitBootstrap.runBlockingAppKitWith");
    expect(main).toContain("NSApplication.shared.run");
    expect(main).toContain("ConfigStore.shared.load()");
    expect(main).toContain("AgentCursor.shared.apply(config: config.agentCursor)");
  });

  it("applies Hana runtime cursor overrides inside the helper process", () => {
    const main = fs.readFileSync(path.join(helperSourceDir, "main.swift"), "utf8");

    expect(main).toContain("HANA_AGENT_CURSOR_CONFIG_JSON");
    expect(main).toContain("applyHanaCursorRuntimeConfig");
    expect(main).toContain("AgentCursor.shared.glideDurationSeconds");
    expect(main).toContain("AgentCursor.shared.dwellAfterClickSeconds");
    expect(main).toContain("AgentCursor.shared.idleHideDelay");
  });
});
