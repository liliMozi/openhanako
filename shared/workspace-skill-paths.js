import fs from "fs";
import path from "path";

export const WORKSPACE_SKILL_DIRS = [
  { sub: ".claude/skills", label: "Claude Code" },
  { sub: ".codex/skills", label: "Codex" },
  { sub: ".openclaw/skills", label: "OpenClaw" },
  { sub: ".agents/skills", label: "Agents" },
  { sub: ".pi/skills", label: "Pi" },
];

export function resolveWorkspaceSkillPaths(workspaceDir) {
  if (!workspaceDir) return [];
  return WORKSPACE_SKILL_DIRS
    .map(({ sub, label }) => ({
      dirPath: path.join(workspaceDir, sub),
      label,
      scope: "workspace",
    }))
    .filter(({ dirPath }) => fs.existsSync(dirPath));
}
