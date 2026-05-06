import { PassThrough } from "stream";
import { EventEmitter } from "events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawn, spawnSync } = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("child_process", () => ({
  spawn,
  spawnSync,
}));

vi.mock("node:child_process", () => ({
  spawn,
  spawnSync,
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  createAgentSession: vi.fn(),
  ModelRegistry: class {},
  SessionManager: class {},
  SettingsManager: class {},
  createReadTool: vi.fn(),
  createWriteTool: vi.fn(),
  createEditTool: vi.fn(),
  createBashTool: vi.fn(),
  createGrepTool: vi.fn(() => ({
    name: "grep",
    execute: vi.fn(async () => ({ content: [{ type: "text", text: "sdk passthrough" }] })),
  })),
  createFindTool: vi.fn(() => ({
    name: "find",
    execute: vi.fn(async () => ({ content: [{ type: "text", text: "sdk passthrough" }] })),
  })),
  createLsTool: vi.fn(),
  createGrepToolDefinition: vi.fn(() => ({
    name: "grep",
    label: "grep",
    description: "grep",
    parameters: {},
    execute: vi.fn(),
  })),
  createFindToolDefinition: vi.fn((_cwd, options = {}) => ({
    name: "find",
    label: "find",
    description: "find",
    parameters: {},
    execute: async (_toolCallId, { pattern, limit }, signal) => {
      const results = await options.operations.glob(pattern, process.cwd(), {
        ignore: [],
        limit: limit ?? 1000,
      });
      if (signal?.aborted) throw new Error("Operation aborted");
      return { content: [{ type: "text", text: results.join("\n") }] };
    },
  })),
  DefaultResourceLoader: class {},
  formatSkillsForPrompt: vi.fn(),
  getLastAssistantUsage: vi.fn(),
  AuthStorage: class {},
  estimateTokens: vi.fn(),
  findCutPoint: vi.fn(),
  generateSummary: vi.fn(),
  serializeConversation: vi.fn(),
  shouldCompact: vi.fn(),
  parseSessionEntries: vi.fn(),
  buildSessionContext: vi.fn(),
  DEFAULT_MAX_BYTES: 50 * 1024,
  formatSize: (bytes) => `${(bytes / 1024).toFixed(1)}KB`,
  truncateHead: (content) => ({
    content,
    truncated: false,
    maxBytes: 50 * 1024,
  }),
  truncateLine: (line, maxChars = 500) => (
    line.length <= maxChars
      ? { text: line, wasTruncated: false }
      : { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true }
  ),
  getAgentDir: () => process.cwd(),
}));

function createChildProcess({ stdout = "", stderr = "", code = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
  });

  setImmediate(() => {
    if (stdout) child.stdout.write(stdout);
    child.stdout.end();
    if (stderr) child.stderr.write(stderr);
    child.stderr.end();
    child.emit("close", code);
  });

  return child;
}

describe("Hana Pi SDK search tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnSync.mockReturnValue({ status: 0, stdout: "tool version\n", stderr: "" });
  });

  it("runs grep ripgrep with hidden Windows console windows", async () => {
    const { createGrepTool } = await import("../lib/pi-sdk/index.js");
    const cwd = process.cwd();
    const match = {
      type: "match",
      data: {
        path: { text: `${cwd}/package.json` },
        line_number: 1,
        lines: { text: "{\n" },
      },
    };
    spawn.mockReturnValue(createChildProcess({ stdout: `${JSON.stringify(match)}\n` }));

    const tool = createGrepTool(cwd, {
      operations: {
        isDirectory: () => true,
        readFile: () => "",
      },
    });

    await tool.execute("call-1", { pattern: "name", path: "." });

    expect(spawn).toHaveBeenCalledWith(
      "rg",
      expect.any(Array),
      expect.objectContaining({
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }),
    );
  });

  it("runs find fd with hidden Windows console windows", async () => {
    const { createFindTool } = await import("../lib/pi-sdk/index.js");
    const cwd = process.cwd();
    spawn.mockReturnValue(createChildProcess({ stdout: `${cwd}/package.json\n` }));

    const tool = createFindTool(cwd);

    await tool.execute("call-2", { pattern: "package.json", path: "." });

    expect(spawn).toHaveBeenCalledWith(
      "fd",
      expect.any(Array),
      expect.objectContaining({
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }),
    );
  });
});
