import fs from "fs";
import path from "path";

export default function (app, ctx) {
  app.get("/groupchat", (c) => {
    const htmlPath = path.join(ctx.pluginDir, "page", "groupchat.html");
    if (!fs.existsSync(htmlPath)) {
      return c.text("groupchat.html not found", 404);
    }
    let html = fs.readFileSync(htmlPath, "utf-8");

    let token = "";
    let port = "";
    let agentsDir = "";
    try {
      const dataDir = ctx.dataDir;
      const hanaHome = path.resolve(dataDir, "..", "..");
      const infoPath = path.join(hanaHome, "server-info.json");
      if (fs.existsSync(infoPath)) {
        const info = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
        token = info.token || "";
        port = info.port || "";
      }
      agentsDir = path.join(hanaHome, "agents");
    } catch (e) {
      console.error("[agent-groupchat] init failed:", e.message);
    }

    html = html.replace("<script>",
      `<script>window.__TOKEN__="${token}";window.__PORT__="${port}";window.__AGENTS_DIR__="${agentsDir.replace(/\\/g,"\\\\")}";window.__V__=Date.now();`);

    c.header("Cache-Control", "no-store, no-cache, must-revalidate");
    return c.html(html);
  });
}
