/**
 * Regression test for issue #402: keep browser tool schema small.
 * Current en description + actionDesc ≈ 631 chars, threshold 700 leaves ~69 char buffer.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnBrowserDef() {
  const path = resolve(__dirname, "../desktop/src/locales/en.json");
  return JSON.parse(readFileSync(path, "utf8")).toolDef.browser;
}

describe("browser tool schema size (#402)", () => {
  let def;
  beforeAll(() => {
    def = loadEnBrowserDef();
  });

  it("keeps en description + actionDesc under 700 chars", () => {
    const total = def.description.length + def.actionDesc.length;
    expect(total).toBeLessThan(700);
  });

  it("encodes the action→param contract in actionDesc", () => {
    for (const action of ["navigate", "click", "type", "scroll", "select", "key", "evaluate"]) {
      expect(def.actionDesc).toContain(action);
    }
  });

  it("keeps the stale-ref warning in description", () => {
    expect(def.description).toContain("[ref]");
  });
});
