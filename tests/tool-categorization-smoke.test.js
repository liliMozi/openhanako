/**
 * CI-level safety net: every OpenHanako tool defined under lib/tools/ and
 * lib/memory/ must be categorized in shared/tool-categories.js.
 *
 * Static source scan (no engine boot). Handles both string-literal names
 * (`name: "x"`) and constant-reference names (`name: SOME_CONST`), where the
 * latter are resolved by looking up `export const SOME_CONST = "value"` in
 * the same directory.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertAllToolsCategorized } from "../shared/tool-categories.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const LITERAL_RE = /name:\s*["']([a-z_][a-z0-9_]*)["']/g;
const CONST_REF_RE = /name:\s*([A-Z_][A-Z0-9_]*)/g;
const CONST_DECL_RE = /export\s+const\s+([A-Z_][A-Z0-9_]*)\s*=\s*["']([a-z_][a-z0-9_]*)["']/g;

function scanDir(dir) {
  const literals = [];
  const refs = [];
  const decls = new Map();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".js")) continue;
    const src = readFileSync(join(dir, file), "utf8");
    for (const m of src.matchAll(LITERAL_RE)) literals.push(m[1]);
    for (const m of src.matchAll(CONST_REF_RE)) refs.push(m[1]);
    for (const m of src.matchAll(CONST_DECL_RE)) decls.set(m[1], m[2]);
  }
  return { literals, refs, decls };
}

function collectAllNames() {
  const toolsDir = resolve(__dirname, "../lib/tools");
  const memoryDir = resolve(__dirname, "../lib/memory");
  const tools = scanDir(toolsDir);
  const memory = scanDir(memoryDir);

  const allDecls = new Map([...tools.decls, ...memory.decls]);
  const resolved = [...tools.refs, ...memory.refs]
    .map((ident) => allDecls.get(ident))
    .filter(Boolean);

  return new Set([...tools.literals, ...memory.literals, ...resolved]);
}

describe("tool-categorization smoke", () => {
  it("every tool name declared under lib/tools/ and lib/memory/ is categorized", () => {
    const all = collectAllNames();
    const names = [...all];

    // Sentinel assertions — if any of these are missing, the scan broke.
    // These cover both literal-declared and constant-declared name paths.
    expect(names).toContain("web_search");
    expect(names).toContain("browser");
    expect(names).toContain("todo_write");
    expect(names).toContain("search_memory");

    expect(names.length).toBeGreaterThan(15);
    expect(() => assertAllToolsCategorized(names)).not.toThrow();
  });
});
