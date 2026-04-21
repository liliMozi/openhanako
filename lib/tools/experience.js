/**
 * experience.js — recall_experience / record_experience 工具
 *
 * 经验库采用渐进式披露：
 *   experience.md   — 索引（分类 + description + 路径），recall 无参时返回
 *   experience/*.md  — 分类文件（数字列表），recall 有参时返回
 *
 * 索引由 rebuildIndex 自动生成，不手写。
 */

import { Type } from "@sinclair/typebox";
import { t } from "../../server/i18n.js";
import fs from "node:fs";
import path from "node:path";

// ── 共享存储操作（导出给 extractor 复用）──

/**
 * 重建索引文件 experience.md
 *
 * 扫描 experienceDir/*.md，每个文件：
 *   - 标题行：# {分类名}（{N} 条）
 *   - description：各条目前 ~20 字拼接，分号分隔
 *   - 路径引用：→ experience/{文件名}
 */
export function rebuildIndex(experienceDir, indexPath) {
  if (!fs.existsSync(experienceDir)) {
    // 目录不存在 → 清空索引
    try { fs.writeFileSync(indexPath, "", "utf-8"); } catch {}
    return;
  }

  let files;
  try {
    files = fs.readdirSync(experienceDir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return;
  }

  if (files.length === 0) {
    try { fs.writeFileSync(indexPath, "", "utf-8"); } catch {}
    return;
  }

  const blocks = [];

  for (const file of files) {
    const category = file.replace(/\.md$/, "");
    const content = readFile(path.join(experienceDir, file));
    const entries = content
      .split("\n")
      .filter((l) => /^\d+\.\s/.test(l.trim()))
      .map((l) => l.replace(/^\d+\.\s*/, "").trim());

    if (entries.length === 0) continue;

    // description：每条取前 20 字，分号拼接，总长上限 120 字
    const snippets = entries.map((e) =>
      e.length > 20 ? e.slice(0, 20) + "…" : e,
    );
    let desc = snippets.join("; ");
    if (desc.length > 120) desc = desc.slice(0, 117) + "…";

    blocks.push(
      `# ${category}（${entries.length} 条）\n${desc}\n→ experience/${file}`,
    );
  }

  const indexContent = blocks.join("\n\n") + "\n";
  fs.writeFileSync(indexPath, indexContent, "utf-8");
}

/**
 * 记录一条经验到分类文件，并重建索引
 *
 * @returns {{ added: boolean, reason?: string }}
 */
export function recordEntry(experienceDir, indexPath, category, content) {
  // 确保目录存在
  if (!fs.existsSync(experienceDir)) {
    fs.mkdirSync(experienceDir, { recursive: true });
  }

  const filePath = path.join(experienceDir, `${category}.md`);
  const existing = readFile(filePath);

  // 去重
  if (existing.includes(content)) {
    return { added: false, reason: "duplicate" };
  }

  // 计算下一个编号
  const lines = existing.split("\n").filter((l) => /^\d+\.\s/.test(l.trim()));
  const nextNum = lines.length + 1;
  const newLine = `${nextNum}. ${content}`;

  const updated = existing.trimEnd()
    ? existing.trimEnd() + "\n" + newLine + "\n"
    : newLine + "\n";

  fs.writeFileSync(filePath, updated, "utf-8");
  rebuildIndex(experienceDir, indexPath);

  return { added: true };
}

// ── 工具工厂 ──

/**
 * 创建 recall_experience + record_experience 工具
 * @param {string} agentDir - agent 数据目录
 * @returns {import('../pi-sdk/index.js').ToolDefinition[]}
 */
export function createExperienceTools(agentDir) {
  const experienceDir = path.join(agentDir, "experience");
  const indexPath = path.join(agentDir, "experience.md");

  const recallTool = {
    name: "recall_experience",
    label: t("toolDef.experience.recallLabel"),
    description: t("toolDef.experience.recallDescription"),
    parameters: Type.Object({
      category: Type.Optional(
        Type.String({ description: t("toolDef.experience.recallCategoryDesc") }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const category = params.category?.trim();

      if (!category) {
        // 返回索引
        const index = readFile(indexPath);
        if (!index.trim()) {
          return {
            content: [{ type: "text", text: t("error.expEmpty") }],
            details: {},
          };
        }
        return {
          content: [{ type: "text", text: index }],
          details: {},
        };
      }

      // 返回具体分类
      const filePath = path.join(experienceDir, `${category}.md`);
      const content = readFile(filePath);
      if (!content.trim()) {
        return {
          content: [
            { type: "text", text: t("error.expCategoryNotFound", { category }) },
          ],
          details: {},
        };
      }
      return {
        content: [{ type: "text", text: `# ${category}\n\n${content}` }],
        details: { category },
      };
    },
  };

  const recordTool = {
    name: "record_experience",
    label: t("toolDef.experience.recordLabel"),
    description: t("toolDef.experience.recordDescription"),
    parameters: Type.Object({
      category: Type.String({
        description: t("toolDef.experience.recordCategoryDesc"),
      }),
      content: Type.String({
        description: t("toolDef.experience.recordContentDesc"),
      }),
    }),
    execute: async (_toolCallId, params) => {
      const category = params.category.replace(/^#+\s*/, "").trim();
      const content = params.content.trim();

      if (!category || !content) {
        return {
          content: [{ type: "text", text: t("error.expEmptyInput") }],
          details: {},
        };
      }

      const result = recordEntry(experienceDir, indexPath, category, content);

      if (!result.added) {
        return {
          content: [{ type: "text", text: t("error.expDuplicate") }],
          details: {},
        };
      }

      return {
        content: [
          { type: "text", text: t("error.expRecorded", { category, content }) },
        ],
        details: { category, content },
      };
    },
  };

  return [recallTool, recordTool];
}

// ── 内部工具 ──

function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}
