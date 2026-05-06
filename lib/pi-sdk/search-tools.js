import { createInterface } from "node:readline";
import { spawn, spawnSync } from "child_process";
import extractZip from "extract-zip";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "fs";
import { arch, homedir, platform } from "os";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  DEFAULT_MAX_BYTES,
  formatSize,
  getAgentDir,
  truncateHead,
  truncateLine,
} from "@mariozechner/pi-coding-agent";

const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_FIND_LIMIT = 1000;
const GREP_MAX_LINE_LENGTH = 500;
const NETWORK_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

const TOOL_CONFIGS = {
  fd: {
    name: "fd",
    repo: "sharkdp/fd",
    binaryName: "fd",
    tagPrefix: "v",
    getAssetName: (version, plat, architecture) => {
      if (plat === "darwin") {
        const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
        return `fd-v${version}-${archStr}-apple-darwin.tar.gz`;
      }
      if (plat === "linux") {
        const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
        return `fd-v${version}-${archStr}-unknown-linux-gnu.tar.gz`;
      }
      if (plat === "win32") {
        const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
        return `fd-v${version}-${archStr}-pc-windows-msvc.zip`;
      }
      return null;
    },
  },
  rg: {
    name: "ripgrep",
    repo: "BurntSushi/ripgrep",
    binaryName: "rg",
    tagPrefix: "",
    getAssetName: (version, plat, architecture) => {
      if (plat === "darwin") {
        const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
        return `ripgrep-${version}-${archStr}-apple-darwin.tar.gz`;
      }
      if (plat === "linux") {
        return architecture === "arm64"
          ? `ripgrep-${version}-aarch64-unknown-linux-gnu.tar.gz`
          : `ripgrep-${version}-x86_64-unknown-linux-musl.tar.gz`;
      }
      if (plat === "win32") {
        const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
        return `ripgrep-${version}-${archStr}-pc-windows-msvc.zip`;
      }
      return null;
    },
  },
};

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function wrapToolDefinition(definition) {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    prepareArguments: definition.prepareArguments,
    executionMode: definition.executionMode,
    renderCall: definition.renderCall,
    renderResult: definition.renderResult,
    renderShell: definition.renderShell,
    promptSnippet: definition.promptSnippet,
    promptGuidelines: definition.promptGuidelines,
    execute: (toolCallId, params, signal, onUpdate, ctx) =>
      definition.execute(toolCallId, params, signal, onUpdate, ctx),
  };
}

function spawnHidden(command, args, options = {}) {
  return spawn(command, args, {
    ...options,
    windowsHide: true,
  });
}

function spawnSyncHidden(command, args, options = {}) {
  return spawnSync(command, args, {
    ...options,
    windowsHide: true,
  });
}

function isOfflineModeEnabled() {
  const value = process.env.PI_OFFLINE;
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

function getBinDir() {
  return path.join(getAgentDir(), "bin");
}

function commandExists(command) {
  try {
    const result = spawnSyncHidden(command, ["--version"], { stdio: "pipe" });
    return result.error == null;
  } catch {
    return false;
  }
}

function getToolPath(tool) {
  const config = TOOL_CONFIGS[tool];
  if (!config) return null;

  const binaryExt = platform() === "win32" ? ".exe" : "";
  const managedPath = path.join(getBinDir(), `${config.binaryName}${binaryExt}`);
  if (existsSync(managedPath)) return managedPath;

  if (commandExists(config.binaryName)) return config.binaryName;
  return null;
}

async function getLatestVersion(repo) {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { "User-Agent": "hanako-search-tools" },
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
  const data = await response.json();
  return String(data.tag_name || "").replace(/^v/, "");
}

async function downloadFile(url, dest) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Failed to download: ${response.status}`);
  if (!response.body) throw new Error("No response body");

  const fileStream = createWriteStream(dest);
  await pipeline(Readable.fromWeb(response.body), fileStream);
}

function findBinaryRecursively(rootDir, binaryFileName) {
  const stack = [rootDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) continue;
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isFile() && entry.name === binaryFileName) return fullPath;
      if (entry.isDirectory()) stack.push(fullPath);
    }
  }
  return null;
}

async function downloadTool(tool) {
  const config = TOOL_CONFIGS[tool];
  if (!config) throw new Error(`Unknown tool: ${tool}`);

  const plat = platform();
  const architecture = arch();
  const version = await getLatestVersion(config.repo);
  const assetName = config.getAssetName(version, plat, architecture);
  if (!assetName) throw new Error(`Unsupported platform: ${plat}/${architecture}`);

  mkdirSync(getBinDir(), { recursive: true });
  const archiveUrl = `https://github.com/${config.repo}/releases/download/${config.tagPrefix}${version}/${assetName}`;
  const archivePath = path.join(getBinDir(), assetName);
  const binaryExt = plat === "win32" ? ".exe" : "";
  const binaryFileName = `${config.binaryName}${binaryExt}`;
  const binaryPath = path.join(getBinDir(), binaryFileName);
  const extractDir = path.join(
    getBinDir(),
    `extract_tmp_${config.binaryName}_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
  );

  await downloadFile(archiveUrl, archivePath);
  mkdirSync(extractDir, { recursive: true });

  try {
    if (assetName.endsWith(".tar.gz")) {
      const result = spawnSyncHidden("tar", ["xzf", archivePath, "-C", extractDir], { stdio: "pipe" });
      if (result.error || result.status !== 0) {
        const message = result.error?.message ?? result.stderr?.toString().trim() ?? "unknown error";
        throw new Error(`Failed to extract ${assetName}: ${message}`);
      }
    } else if (assetName.endsWith(".zip")) {
      await extractZip(archivePath, { dir: extractDir });
    } else {
      throw new Error(`Unsupported archive format: ${assetName}`);
    }

    const extractedDir = path.join(extractDir, assetName.replace(/\.(tar\.gz|zip)$/, ""));
    const extractedBinary = [
      path.join(extractedDir, binaryFileName),
      path.join(extractDir, binaryFileName),
      findBinaryRecursively(extractDir, binaryFileName),
    ].find((candidate) => candidate && existsSync(candidate));

    if (!extractedBinary) {
      throw new Error(`Binary not found in archive: expected ${binaryFileName} under ${extractDir}`);
    }

    renameSync(extractedBinary, binaryPath);
    if (plat !== "win32") chmodSync(binaryPath, 0o755);
    return binaryPath;
  } finally {
    rmSync(archivePath, { force: true });
    rmSync(extractDir, { recursive: true, force: true });
  }
}

async function ensureSearchTool(tool) {
  const existingPath = getToolPath(tool);
  if (existingPath) return existingPath;
  if (isOfflineModeEnabled() || platform() === "android") return undefined;
  try {
    return await downloadTool(tool);
  } catch {
    return undefined;
  }
}

function normalizeAtPrefix(filePath) {
  return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

function expandPath(filePath) {
  const normalized = normalizeAtPrefix(filePath).replace(UNICODE_SPACES, " ");
  if (normalized === "~") return homedir();
  if (normalized.startsWith("~/")) return path.join(homedir(), normalized.slice(2));
  return normalized;
}

function resolveToCwd(filePath, cwd) {
  const expanded = expandPath(filePath);
  return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function defaultGrepOperations() {
  return {
    isDirectory: (p) => statSync(p).isDirectory(),
    readFile: (p) => readFileSync(p, "utf-8"),
  };
}

function createGrepExecute(cwd, options = {}) {
  const customOps = options?.operations;

  return async function executeGrep(
    _toolCallId,
    { pattern, path: searchDir, glob, ignoreCase, literal, context, limit },
    signal,
  ) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("Operation aborted"));
        return;
      }

      let settled = false;
      const settle = (fn) => {
        if (settled) return;
        settled = true;
        fn();
      };

      (async () => {
        try {
          const rgPath = await ensureSearchTool("rg");
          if (!rgPath) {
            settle(() => reject(new Error("ripgrep (rg) is not available and could not be downloaded")));
            return;
          }

          const searchPath = resolveToCwd(searchDir || ".", cwd);
          const ops = customOps ?? defaultGrepOperations();
          let isDirectory;
          try {
            isDirectory = await ops.isDirectory(searchPath);
          } catch {
            settle(() => reject(new Error(`Path not found: ${searchPath}`)));
            return;
          }

          const contextValue = context && context > 0 ? context : 0;
          const effectiveLimit = Math.max(1, limit ?? DEFAULT_GREP_LIMIT);
          const formatPath = (filePath) => {
            if (isDirectory) {
              const relative = path.relative(searchPath, filePath);
              if (relative && !relative.startsWith("..")) return relative.replace(/\\/g, "/");
            }
            return path.basename(filePath);
          };
          const fileCache = new Map();
          const getFileLines = async (filePath) => {
            let lines = fileCache.get(filePath);
            if (!lines) {
              try {
                const content = await ops.readFile(filePath);
                lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
              } catch {
                lines = [];
              }
              fileCache.set(filePath, lines);
            }
            return lines;
          };

          const args = ["--json", "--line-number", "--color=never", "--hidden"];
          if (ignoreCase) args.push("--ignore-case");
          if (literal) args.push("--fixed-strings");
          if (glob) args.push("--glob", glob);
          args.push(pattern, searchPath);

          const child = spawnHidden(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
          const rl = createInterface({ input: child.stdout });
          let stderr = "";
          let matchCount = 0;
          let matchLimitReached = false;
          let linesTruncated = false;
          let aborted = false;
          let killedDueToLimit = false;
          const outputLines = [];
          const matches = [];

          const cleanup = () => {
            rl.close();
            signal?.removeEventListener("abort", onAbort);
          };
          const stopChild = (dueToLimit = false) => {
            if (!child.killed) {
              killedDueToLimit = dueToLimit;
              child.kill();
            }
          };
          const onAbort = () => {
            aborted = true;
            stopChild();
          };

          signal?.addEventListener("abort", onAbort, { once: true });

          child.stderr?.on("data", (chunk) => {
            stderr += chunk.toString();
          });

          const formatBlock = async (filePath, lineNumber) => {
            const relativePath = formatPath(filePath);
            const lines = await getFileLines(filePath);
            if (!lines.length) return [`${relativePath}:${lineNumber}: (unable to read file)`];

            const block = [];
            const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
            const end = contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber;
            for (let current = start; current <= end; current++) {
              const lineText = lines[current - 1] ?? "";
              const sanitized = lineText.replace(/\r/g, "");
              const isMatchLine = current === lineNumber;
              const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
              if (wasTruncated) linesTruncated = true;
              block.push(
                isMatchLine
                  ? `${relativePath}:${current}: ${truncatedText}`
                  : `${relativePath}-${current}- ${truncatedText}`,
              );
            }
            return block;
          };

          rl.on("line", (line) => {
            if (!line.trim() || matchCount >= effectiveLimit) return;
            let event;
            try {
              event = JSON.parse(line);
            } catch {
              return;
            }
            if (event.type !== "match") return;

            matchCount++;
            const filePath = event.data?.path?.text;
            const lineNumber = event.data?.line_number;
            const lineText = event.data?.lines?.text;
            if (filePath && typeof lineNumber === "number") {
              matches.push({ filePath, lineNumber, lineText });
            }
            if (matchCount >= effectiveLimit) {
              matchLimitReached = true;
              stopChild(true);
            }
          });

          child.on("error", (error) => {
            cleanup();
            settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
          });

          child.on("close", async (code) => {
            cleanup();
            if (aborted) {
              settle(() => reject(new Error("Operation aborted")));
              return;
            }
            if (!killedDueToLimit && code !== 0 && code !== 1) {
              const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
              settle(() => reject(new Error(errorMsg)));
              return;
            }
            if (matchCount === 0) {
              settle(() => resolve({ content: [{ type: "text", text: "No matches found" }], details: undefined }));
              return;
            }

            for (const match of matches) {
              if (contextValue === 0 && match.lineText !== undefined) {
                const relativePath = formatPath(match.filePath);
                const sanitized = match.lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
                const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
                if (wasTruncated) linesTruncated = true;
                outputLines.push(`${relativePath}:${match.lineNumber}: ${truncatedText}`);
              } else {
                outputLines.push(...await formatBlock(match.filePath, match.lineNumber));
              }
            }

            const truncation = truncateHead(outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
            let output = truncation.content;
            const details = {};
            const notices = [];
            if (matchLimitReached) {
              notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
              details.matchLimitReached = effectiveLimit;
            }
            if (truncation.truncated) {
              notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
              details.truncation = truncation;
            }
            if (linesTruncated) {
              notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
              details.linesTruncated = true;
            }
            if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

            settle(() => resolve({
              content: [{ type: "text", text: output }],
              details: Object.keys(details).length > 0 ? details : undefined,
            }));
          });
        } catch (err) {
          settle(() => reject(err));
        }
      })();
    });
  };
}

function createFindExecute(cwd, options = {}) {
  const customOps = options?.operations;

  return async function executeFind(_toolCallId, { pattern, path: searchDir, limit }, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("Operation aborted"));
        return;
      }

      let settled = false;
      let stopChild;
      const settle = (fn) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        stopChild = undefined;
        fn();
      };
      const onAbort = () => {
        stopChild?.();
        settle(() => reject(new Error("Operation aborted")));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      (async () => {
        try {
          const searchPath = resolveToCwd(searchDir || ".", cwd);
          const effectiveLimit = limit ?? DEFAULT_FIND_LIMIT;

          if (customOps?.glob) {
            if (!(await customOps.exists(searchPath))) {
              settle(() => reject(new Error(`Path not found: ${searchPath}`)));
              return;
            }
            const results = await customOps.glob(pattern, searchPath, {
              ignore: ["**/node_modules/**", "**/.git/**"],
              limit: effectiveLimit,
            });
            if (signal?.aborted) {
              settle(() => reject(new Error("Operation aborted")));
              return;
            }
            settle(() => resolve(formatFindResults(results, searchPath, effectiveLimit)));
            return;
          }

          const fdPath = await ensureSearchTool("fd");
          if (signal?.aborted) {
            settle(() => reject(new Error("Operation aborted")));
            return;
          }
          if (!fdPath) {
            settle(() => reject(new Error("fd is not available and could not be downloaded")));
            return;
          }

          const args = [
            "--glob",
            "--color=never",
            "--hidden",
            "--no-require-git",
            "--max-results",
            String(effectiveLimit),
          ];
          let effectivePattern = pattern;
          if (pattern.includes("/")) {
            args.push("--full-path");
            if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
              effectivePattern = `**/${pattern}`;
            }
          }
          args.push(effectivePattern, searchPath);

          const child = spawnHidden(fdPath, args, { stdio: ["ignore", "pipe", "pipe"] });
          const rl = createInterface({ input: child.stdout });
          let stderr = "";
          const lines = [];

          stopChild = () => {
            if (!child.killed) child.kill();
          };
          const cleanup = () => {
            rl.close();
          };

          child.stderr?.on("data", (chunk) => {
            stderr += chunk.toString();
          });
          rl.on("line", (line) => {
            lines.push(line);
          });
          child.on("error", (error) => {
            cleanup();
            settle(() => reject(new Error(`Failed to run fd: ${error.message}`)));
          });
          child.on("close", (code) => {
            cleanup();
            if (signal?.aborted) {
              settle(() => reject(new Error("Operation aborted")));
              return;
            }

            const output = lines.join("\n");
            if (code !== 0) {
              const errorMsg = stderr.trim() || `fd exited with code ${code}`;
              if (!output) {
                settle(() => reject(new Error(errorMsg)));
                return;
              }
            }
            settle(() => resolve(formatFindResults(lines, searchPath, effectiveLimit)));
          });
        } catch (e) {
          if (signal?.aborted) {
            settle(() => reject(new Error("Operation aborted")));
            return;
          }
          settle(() => reject(e instanceof Error ? e : new Error(String(e))));
        }
      })();
    });
  };
}

function formatFindResults(results, searchPath, effectiveLimit) {
  if (results.length === 0) {
    return {
      content: [{ type: "text", text: "No files found matching pattern" }],
      details: undefined,
    };
  }

  const relativized = [];
  for (const rawResult of results) {
    const line = String(rawResult).replace(/\r$/, "").trim();
    if (!line) continue;
    const hadTrailingSlash = line.endsWith("/") || line.endsWith("\\");
    const absoluteLine = path.isAbsolute(line) ? line : path.resolve(searchPath, line);
    let relativePath = absoluteLine.startsWith(searchPath)
      ? absoluteLine.slice(searchPath.length + 1)
      : path.relative(searchPath, absoluteLine);
    if (hadTrailingSlash && !relativePath.endsWith("/")) relativePath += "/";
    relativized.push(toPosixPath(relativePath));
  }

  if (relativized.length === 0) {
    return {
      content: [{ type: "text", text: "No files found matching pattern" }],
      details: undefined,
    };
  }

  const resultLimitReached = relativized.length >= effectiveLimit;
  const truncation = truncateHead(relativized.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
  let resultOutput = truncation.content;
  const details = {};
  const notices = [];
  if (resultLimitReached) {
    notices.push(`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
    details.resultLimitReached = effectiveLimit;
  }
  if (truncation.truncated) {
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
    details.truncation = truncation;
  }
  if (notices.length > 0) resultOutput += `\n\n[${notices.join(". ")}]`;

  return {
    content: [{ type: "text", text: resultOutput }],
    details: Object.keys(details).length > 0 ? details : undefined,
  };
}

export function createGrepTool(cwd, options) {
  return wrapToolDefinition({
    ...createGrepToolDefinition(cwd, options),
    execute: createGrepExecute(cwd, options),
  });
}

export function createFindTool(cwd, options) {
  return wrapToolDefinition({
    ...createFindToolDefinition(cwd, options),
    execute: createFindExecute(cwd, options),
  });
}
