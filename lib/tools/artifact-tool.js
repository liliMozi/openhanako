/**
 * artifact-tool.js — Artifact 预览工具（create_artifact）
 *
 * Agent 调用此工具在前端预览面板中展示 HTML 页面、代码或 Markdown。
 * 内容通过 WS 推送到前端渲染，不写入磁盘。
 */
import { Type } from "@sinclair/typebox";

let _counter = 0;

export function createArtifactTool() {
  return {
    name: "create_artifact",
    label: "创建预览",
    description:
      "当你需要向用户展示 HTML 页面、代码片段或长篇 Markdown 内容时，调用此工具。\n" +
      "内容会在独立的预览面板中渲染，用户可以实时查看效果。\n" +
      "适用场景：可运行的 HTML/CSS/JS 页面、交互式可视化、SVG 图表、完整代码文件、长篇格式化文档。\n" +
      "不适用场景：简短的文字回复、对话性回答、单行代码片段（直接在消息中展示即可）。",
    parameters: Type.Object({
      type: Type.Union(
        [
          Type.Literal("html"),
          Type.Literal("code"),
          Type.Literal("markdown"),
        ],
        { description: "内容类型：html（渲染页面）、code（语法高亮）、markdown（文档）" },
      ),
      title: Type.String({ description: "展示标题，简短描述内容" }),
      content: Type.String({ description: "完整内容（HTML 源码 / 代码 / Markdown 文本）" }),
      language: Type.Optional(
        Type.String({
          description: "编程语言（仅 type=code 时有效），如 javascript, python, css",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const artifactId = `art-${Date.now()}-${++_counter}`;
      return {
        content: [{ type: "text", text: `已创建预览: ${params.title}` }],
        details: {
          artifactId,
          type: params.type,
          title: params.title,
          content: params.content,
          language: params.language || null,
        },
      };
    },
  };
}
