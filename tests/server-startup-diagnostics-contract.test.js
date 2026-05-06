import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";

const root = process.cwd();

describe("server startup diagnostics contract", () => {
  it("records child process identity when server startup times out without output", () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");

    expect(mainSource).toContain("Server PID:");
    expect(mainSource).toContain("Server command:");
    expect(mainSource).toContain("Server args:");
    expect(mainSource).toContain("Server child alive:");
  });

  it("keeps process diagnostics even when bootstrap already wrote output", () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");

    expect(mainSource).toContain("function buildServerCrashDiagnostics(");
    expect(mainSource).toContain("const diagnostics = buildServerCrashDiagnostics();");
    expect(mainSource).not.toContain("if (!logs) {\n    // production 时 server");
  });

  it("waits for the server graceful shutdown contract before force killing", () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");

    expect(mainSource).toContain("SERVER_SHUTDOWN_GRACE_MS");
    expect(mainSource).toContain("waitForProcessExit(");
    expect(mainSource).toContain("killPid(pid, true)");
    expect(mainSource).not.toContain("setTimeout(done, 3000)");
  });

  it("keeps server-info when shutdown cannot confirm the server is gone", () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");

    expect(mainSource).toContain("let removeServerInfo = true");
    expect(mainSource).toContain("removeServerInfo = false");
    expect(mainSource).toContain("if (removeServerInfo)");
  });

  it("starts packaged and dev server through an early bootstrap entry", () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");
    const buildSource = fs.readFileSync(path.join(root, "scripts", "build-server.mjs"), "utf-8");
    const bootstrapPath = path.join(root, "server", "bootstrap.js");

    expect(fs.existsSync(bootstrapPath)).toBe(true);
    const bootstrapSource = fs.readFileSync(bootstrapPath, "utf-8");
    expect(bootstrapSource).toContain("[server-bootstrap] process started");
    expect(bootstrapSource.indexOf("[server-bootstrap] process started")).toBeLessThan(
      bootstrapSource.indexOf("await import("),
    );
    expect(bootstrapSource).toContain("[server-bootstrap] importing server entry");
    expect(bootstrapSource).toContain("[server-bootstrap] server entry import still pending");
    expect(bootstrapSource).toContain("[server-bootstrap] server entry import completed");

    expect(mainSource).toContain("bootstrap.js");
    expect(mainSource).toContain("HANA_SERVER_ENTRY");
    expect(buildSource).toContain('path.join(outDir, "bootstrap.js")');
    expect(buildSource).toContain('"$DIR/bootstrap.js"');
    expect(buildSource).toContain("bundle\\\\index.js");
  });

  it("resolves packaged bootstrap default root to the bootstrap directory", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hana-bootstrap-"));
    const serverRoot = path.join(tmp, "resources", "server");
    try {
      fs.mkdirSync(path.join(serverRoot, "bundle"), { recursive: true });
      fs.copyFileSync(path.join(root, "server", "bootstrap.js"), path.join(serverRoot, "bootstrap.js"));
      fs.writeFileSync(path.join(serverRoot, "package.json"), JSON.stringify({ type: "module" }));
      fs.writeFileSync(
        path.join(serverRoot, "bundle", "index.js"),
        "process.stdout.write('[fixture] bundle imported\\n');\n",
      );

      const env = { ...process.env };
      delete env.HANA_ROOT;
      delete env.HANA_SERVER_ENTRY;
      const result = spawnSync(process.execPath, [path.join(serverRoot, "bootstrap.js")], {
        env,
        encoding: "utf-8",
      });

      expect(result.status).toBe(0);
      const realServerRoot = fs.realpathSync(serverRoot);
      expect(result.stdout).toContain(`[server-bootstrap] root=${realServerRoot}`);
      expect(result.stdout).toContain(path.join(realServerRoot, "bundle", "index.js"));
      expect(result.stdout).toContain("[fixture] bundle imported");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("lets desktop skip startup session creation so server readiness is not blocked by chat session warmup", () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");
    const serverSource = fs.readFileSync(path.join(root, "server", "index.js"), "utf-8");

    expect(mainSource).toContain("HANA_CREATE_STARTUP_SESSION");
    expect(mainSource).toContain('"0"');
    expect(serverSource).toContain('process.env.HANA_CREATE_STARTUP_SESSION !== "0"');
    expect(serverSource).toContain("[server] ③ 跳过启动期 session 创建");
  });

  it("keeps bridge platform dependencies out of the server readiness path", () => {
    const serverSource = fs.readFileSync(path.join(root, "server", "index.js"), "utf-8");
    const bridgeRouteSource = fs.readFileSync(path.join(root, "server", "routes", "bridge.js"), "utf-8");

    expect(serverSource).not.toMatch(/^import\s+\{\s*BridgeManager\s*\}\s+from\s+["']\.\.\/lib\/bridge\/bridge-manager\.js["'];/m);
    expect(serverSource).toContain('await import("../lib/bridge/bridge-manager.js")');

    const readyWriteIndex = serverSource.indexOf("fs.writeFileSync(serverInfoPath");
    const bridgeStartIndex = serverSource.indexOf("startBridgeManager({ autoStart: true })");
    expect(readyWriteIndex).toBeGreaterThan(-1);
    expect(bridgeStartIndex).toBeGreaterThan(-1);
    expect(readyWriteIndex).toBeLessThan(bridgeStartIndex);

    expect(bridgeRouteSource).not.toContain('import { getWechatQrcode, pollWechatQrcodeStatus } from "../../lib/bridge/wechat-login.js";');
    expect(bridgeRouteSource).toContain('await import("../../lib/bridge/wechat-login.js")');
    expect(bridgeRouteSource).toContain("resolveBridgeManager");
  });

  it("keeps native SQLite out of the server static import graph", () => {
    const factStoreSource = fs.readFileSync(path.join(root, "lib", "memory", "fact-store.js"), "utf-8");
    const agentSource = fs.readFileSync(path.join(root, "core", "agent.js"), "utf-8");

    expect(factStoreSource).not.toMatch(/^import\s+.*better-sqlite3/m);
    expect(factStoreSource).toContain("loadBetterSqliteDatabase");
    expect(agentSource).toContain("[agent] 4. FactStore...");
    expect(agentSource.indexOf("[agent] 4. FactStore...")).toBeLessThan(
      agentSource.indexOf("new FactStore("),
    );
  });
});
