/**
 * artifact-tool.js — Artifact 预览工具（create_artifact）
 *
 * Agent 调用此工具在前端预览面板中展示 HTML 页面、代码或 Markdown。
 * 内容通过 WS 推送到前端渲染，不写入磁盘。
 */
import { Type } from "@sinclair/typebox";
import { StringEnum } from "../pi-sdk/index.js";
import { t } from "../../server/i18n.js";

let _counter = 0;

export function createArtifactTool() {
  return {
    name: "create_artifact",
    label: t("toolDef.artifact.label"),
    description: t("toolDef.artifact.description"),
    parameters: Type.Object({
      type: StringEnum(
        ["html", "code", "markdown"],
        { description: t("toolDef.artifact.typeDesc") },
      ),
      title: Type.String({ description: t("toolDef.artifact.titleDesc") }),
      content: Type.String({ description: t("toolDef.artifact.contentDesc") }),
      language: Type.Optional(
        Type.String({
          description: t("toolDef.artifact.languageDesc"),
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const artifactId = `art-${Date.now()}-${++_counter}`;
      return {
        content: [{ type: "text", text: t("error.artifactCreated", { title: params.title }) }],
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
