/**
 * output-file-tool.js — 文件暂存工具（stage_files）
 *
 * agent 声明持有文件，框架按上下文投递（桌面渲染 / bridge 发送）。
 * 服务端拦截 tool_execution_end 事件，通过 WebSocket 推送 file_output 事件给前端。
 *
 * 参数：{ filepaths: string[] }
 * 同时向下兼容旧的单文件调用：{ filePath: string, label?: string }
 */
import fs from "fs";
import path from "path";
import { Type } from "../pi-sdk/index.js";
import { t } from "../../server/i18n.js";
import { getToolSessionPath } from "./tool-session.js";

/** 修正 LLM 常见的路径问题：转义空格、URL 编码、多余引号 */
function sanitizePath(p) {
  p = p.trim().replace(/^["']|["']$/g, "");
  p = p.replace(/\\ /g, " ");
  if (p.includes("%20")) {
    try { p = decodeURIComponent(p); } catch {}
  }
  return p;
}

export function createStageFilesTool({ registerSessionFile, getSessionPath } = {}) {
  return {
    name: "stage_files",
    label: t("toolDef.outputFile.label"),
    description: t("toolDef.outputFile.description"),
    parameters: Type.Object({
      filepaths: Type.Optional(Type.Array(Type.String(), {
        minItems: 1,
        description: t("toolDef.outputFile.filepathsDesc"),
      })),
      // 向下兼容旧接口
      filePath: Type.Optional(Type.String({ description: t("toolDef.outputFile.filePathDesc") })),
      label: Type.Optional(Type.String({ description: t("toolDef.outputFile.labelDesc") })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      // 统一为路径数组：优先使用 filepaths，兼容 filePath
      let paths = params.filepaths;
      if (!paths || paths.length === 0) {
        if (params.filePath) {
          paths = [params.filePath];
        } else {
          return {
            content: [{ type: "text", text: t("error.outputFileNeedPaths") }],
            details: {},
          };
        }
      }

      const results = [];
      const errors = [];
      const sessionPath = registerSessionFile
        ? getToolSessionPath(ctx) || ctx?.sessionPath || getSessionPath?.() || null
        : null;

      for (const raw of paths) {
        const fp = sanitizePath(raw);

        if (!path.isAbsolute(fp)) {
          errors.push(t("error.outputFileNotAbsolute", { path: fp }));
          continue;
        }
        if (!fs.existsSync(fp)) {
          errors.push(t("error.outputFileNotFound", { path: fp }));
          continue;
        }

        const displayLabel = path.basename(fp);
        const ext = path.extname(fp).toLowerCase().replace(".", "");
        const label = params.label || displayLabel;
        if (registerSessionFile) {
          if (!sessionPath) {
            errors.push("stage_files requires an active sessionPath to register files");
            continue;
          }
          try {
            const sessionFile = await registerSessionFile({
              sessionPath,
              filePath: fp,
              label,
              origin: "stage_files",
            });
            results.push(toStageFileResult(sessionFile, { filePath: fp, label, ext }));
          } catch (err) {
            errors.push(err?.message || String(err));
          }
        } else {
          results.push({ filePath: fp, label, ext });
        }
      }

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: errors.join("\n") }],
          details: {},
        };
      }

      const summary = results.map(r => r.label).join(", ");
      return {
        content: [{ type: "text", text: t("error.outputFilePresented", { summary }) }],
        details: {
          files: results,
          media: {
            ...(results.some(r => r.fileId) ? { items: results.map(toMediaItem).filter(Boolean) } : {}),
            mediaUrls: results.map(r => r.filePath),
          },
        },
      };
    },
  };
}

function toStageFileResult(sessionFile, legacy) {
  const fileId = sessionFile?.id || sessionFile?.fileId || null;
  return {
    ...(fileId ? { id: fileId, fileId } : {}),
    filePath: sessionFile?.filePath || legacy.filePath,
    label: legacy.label || sessionFile?.displayName || sessionFile?.label,
    ext: sessionFile?.ext || legacy.ext || "",
    ...(sessionFile?.mime ? { mime: sessionFile.mime } : {}),
    ...(sessionFile?.size !== undefined ? { size: sessionFile.size } : {}),
    ...(sessionFile?.kind ? { kind: sessionFile.kind } : {}),
    ...(sessionFile?.sessionPath ? { sessionPath: sessionFile.sessionPath } : {}),
    ...(sessionFile?.origin ? { origin: sessionFile.origin } : {}),
    ...(sessionFile?.storageKind ? { storageKind: sessionFile.storageKind } : {}),
    ...(sessionFile?.status ? { status: sessionFile.status } : {}),
    ...(sessionFile?.missingAt !== undefined ? { missingAt: sessionFile.missingAt } : {}),
  };
}

function toMediaItem(file) {
  if (!file?.fileId) return null;
  return {
    type: "session_file",
    fileId: file.fileId,
    sessionPath: file.sessionPath,
    filePath: file.filePath,
    filename: path.basename(file.filePath),
    label: file.label,
    mime: file.mime,
    size: file.size,
    kind: file.kind,
  };
}
