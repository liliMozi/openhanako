/**
 * output-file-tool.js — 文件呈现工具（present_files）
 *
 * 兼容 Claude.ai 的 present_files 接口：接收文件路径数组，
 * 服务端拦截并通过 WebSocket 推送 file_output 事件给前端。
 *
 * 参数：{ filepaths: string[] }
 * 同时向下兼容旧的单文件调用：{ filePath: string, label?: string }
 */
import fs from "fs";
import path from "path";
import { Type } from "@sinclair/typebox";

/** 修正 LLM 常见的路径问题：转义空格、URL 编码、多余引号 */
function sanitizePath(p) {
  p = p.trim().replace(/^["']|["']$/g, "");
  p = p.replace(/\\ /g, " ");
  if (p.includes("%20")) {
    try { p = decodeURIComponent(p); } catch {}
  }
  return p;
}

export function createPresentFilesTool() {
  return {
    name: "present_files",
    label: "呈现文件",
    description:
      "当你为用户成功创建了文件（PDF、Word、Excel、PPT、Markdown 等）后，" +
      "调用此工具将文件呈现在对话中，让用户可以直接点击打开。" +
      "只在文件确实已经写入磁盘后调用，不要在文件创建失败时调用。" +
      "第一个路径应该是用户最想看到的文件。",
    parameters: Type.Object({
      filepaths: Type.Optional(Type.Array(Type.String(), {
        minItems: 1,
        description: "要呈现给用户的文件绝对路径数组",
      })),
      // 向下兼容旧接口
      filePath: Type.Optional(Type.String({ description: "(兼容) 单个文件的绝对路径" })),
      label: Type.Optional(Type.String({ description: "(兼容) 显示给用户的文件名" })),
    }),
    execute: async (_toolCallId, params) => {
      // 统一为路径数组：优先使用 filepaths，兼容 filePath
      let paths = params.filepaths;
      if (!paths || paths.length === 0) {
        if (params.filePath) {
          paths = [params.filePath];
        } else {
          return {
            content: [{ type: "text", text: "需要提供 filepaths 数组或 filePath。" }],
            details: {},
          };
        }
      }

      const results = [];
      const errors = [];

      for (const raw of paths) {
        const fp = sanitizePath(raw);

        if (!path.isAbsolute(fp)) {
          errors.push(`路径必须是绝对路径: ${fp}`);
          continue;
        }
        if (!fs.existsSync(fp)) {
          errors.push(`文件不存在: ${fp}`);
          continue;
        }

        const displayLabel = path.basename(fp);
        const ext = path.extname(fp).toLowerCase().replace(".", "");
        results.push({ filePath: fp, label: params.label || displayLabel, ext });
      }

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: errors.join("\n") }],
          details: {},
        };
      }

      const summary = results.map(r => r.label).join(", ");
      return {
        content: [{ type: "text", text: `文件已呈现: ${summary}` }],
        details: { files: results },
      };
    },
  };
}

// 向下兼容旧导出名
export const createOutputFileTool = createPresentFilesTool;
