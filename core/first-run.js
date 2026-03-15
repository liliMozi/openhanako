/**
 * first-run.js — 首次运行播种
 *
 * 在 server/engine 启动之前调用，确保 ~/.hanako/ 结构存在。
 * 如果是全新安装（agents/ 为空），自动创建默认 agent。
 */

import fs from "fs";
import path from "path";

/**
 * 确保 ~/.hanako/ 数据目录就绪
 * @param {string} hanakoHome - ~/.hanako 绝对路径
 * @param {string} productDir - 产品模板目录（lib/）
 */
export function ensureFirstRun(hanakoHome, productDir) {
  // 1. 确保目录结构存在
  fs.mkdirSync(path.join(hanakoHome, "agents"), { recursive: true });
  fs.mkdirSync(path.join(hanakoHome, "user"), { recursive: true });

  // 2. 如果 agents/ 没有任何 agent → 播种默认 agent
  const agentsDir = path.join(hanakoHome, "agents");
  const hasAgent = fs.readdirSync(agentsDir).some(name => {
    const full = path.join(agentsDir, name);
    return fs.statSync(full).isDirectory() && !name.startsWith(".");
  });

  if (!hasAgent) {
    console.log("[first-run] 首次启动，正在创建默认助手...");
    seedDefaultAgent(agentsDir, productDir);
  }

  // 3. 同步 skills：从 skills2set/ 复制到 ~/.hanako/skills/
  const skillsSrc = path.join(productDir, "..", "skills2set");
  const skillsDst = path.join(hanakoHome, "skills");
  fs.mkdirSync(skillsDst, { recursive: true });
  if (fs.existsSync(skillsSrc)) {
    syncSkills(skillsSrc, skillsDst);
  }

  // 4. 确保 user/preferences.json 存在
  const prefsPath = path.join(hanakoHome, "user", "preferences.json");
  if (!fs.existsSync(prefsPath)) {
    fs.writeFileSync(
      prefsPath,
      JSON.stringify({ primaryAgent: "hanako" }, null, 2) + "\n",
      "utf-8",
    );
  }
}

/**
 * 从模板播种默认 agent（与 engine.createAgent 相同逻辑，但纯同步、无依赖）
 */
function seedDefaultAgent(agentsDir, productDir) {
  const agentId = "hanako";
  const agentDir = path.join(agentsDir, agentId);

  // 创建目录结构
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "avatars"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "desk"), { recursive: true });

  // config.yaml（保持模板默认值：name=Hanako, yuan=hanako）
  const configSrc = path.join(productDir, "config.example.yaml");
  if (fs.existsSync(configSrc)) {
    fs.copyFileSync(configSrc, path.join(agentDir, "config.yaml"));
  }

  // identity.md（填入默认名字）
  const identitySrc = path.join(productDir, "identity.example.md");
  if (fs.existsSync(identitySrc)) {
    const tmpl = fs.readFileSync(identitySrc, "utf-8");
    const filled = tmpl
      .replace(/\{\{agentName\}\}/g, "Hanako")
      .replace(/\{\{userName\}\}/g, "");
    fs.writeFileSync(path.join(agentDir, "identity.md"), filled, "utf-8");
  }

  // yuan 由 buildSystemPrompt 实时从 lib/yuan/ 读取，无需复制

  // ishiki.md
  const ishikiSrc = path.join(productDir, "ishiki.example.md");
  if (fs.existsSync(ishikiSrc)) {
    fs.copyFileSync(ishikiSrc, path.join(agentDir, "ishiki.md"));
  }

  console.log(`[first-run] 默认助手 "${agentId}" 已创建`);
}

/**
 * 同步 skills2set/ → ~/.hanako/skills/
 * 每次启动都跑，确保新增/更新的 skill 能同步到用户目录
 */
function syncSkills(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

    const skillSrc = path.join(srcDir, entry.name);
    const skillDst = path.join(dstDir, entry.name);

    // 只要源里有 SKILL.md 就同步整个目录
    if (!fs.existsSync(path.join(skillSrc, "SKILL.md"))) continue;

    copyDirSync(skillSrc, skillDst);
  }
}

/** 递归复制目录（覆盖已有文件） */
function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(s, d);
    } else {
      // 目标文件可能是只读的，先解除再覆盖
      if (fs.existsSync(d)) {
        fs.chmodSync(d, 0o644);
      }
      fs.copyFileSync(s, d);
    }
  }
}
