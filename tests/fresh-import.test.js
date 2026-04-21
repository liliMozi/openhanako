import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { freshImport } from "../core/fresh-import.js";

describe("freshImport", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fresh-import-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("imports a JS module", async () => {
    const filePath = path.join(tmpDir, "mod.js");
    fs.writeFileSync(filePath, "export const value = 42;");
    const mod = await freshImport(filePath);
    expect(mod.value).toBe(42);
  });

  it("bypasses ESM cache on re-import", async () => {
    const filePath = path.join(tmpDir, "counter.js");
    fs.writeFileSync(filePath, "export const v = 1;");
    const mod1 = await freshImport(filePath);
    expect(mod1.v).toBe(1);

    fs.writeFileSync(filePath, "export const v = 2;");
    const mod2 = await freshImport(filePath);
    expect(mod2.v).toBe(2);
  });
});
