/**
 * block-extractors.js — Content Block 统一提取注册表
 *
 * 从 toolResult.details 中提取 content blocks。
 * 关键约束：extractor 只依赖 details（和 toolResult.content），
 * 不依赖 toolCall.args，因为 sessions.js 中 Pi SDK 存储的
 * toolResult 消息没有 .toolCall 属性。
 */

export const BLOCK_EXTRACTORS = {
  // COMPAT(v0.78): present_files 是 stage_files 的旧名，共用 extractor
  stage_files: (details) => {
    const files = details.files || [];
    if (!files.length && details.filePath) {
      files.push({ filePath: details.filePath, label: details.label, ext: details.ext || "" });
    }
    return files.map(f => ({ type: "file", filePath: f.filePath, label: f.label, ext: f.ext || "" }));
  },

  create_artifact: (details) => {
    if (!details.content) return null;
    return [{
      type: "artifact",
      artifactId: details.artifactId,
      artifactType: details.type,
      title: details.title,
      content: details.content,
      language: details.language,
    }];
  },

  browser: (details, toolResult) => {
    if (details.action !== "screenshot") return null;
    const imgBlock = toolResult?.content?.find(c => c.type === "image");
    if (!imgBlock?.data) return null;
    return [{
      type: "screenshot",
      base64: imgBlock.data,
      mimeType: imgBlock.mimeType || "image/jpeg",
    }];
  },

  install_skill: (details) => {
    if (!details.skillName) return null;
    return [{
      type: "skill",
      skillName: details.skillName,
      skillFilePath: details.skillFilePath || "",
    }];
  },

  cron: (details) => {
    let jobData = details.jobData;
    if (!jobData && details.job) {
      // COMPAT: 老 session 没有 jobData 字段，从 job 对象重建
      const j = details.job;
      jobData = { type: j.type, schedule: j.schedule, prompt: j.prompt, label: j.label, model: j.model };
    }
    if (!jobData) return null;
    const status = details.confirmed === false
      ? "rejected"
      : (details.action === "cancelled" ? "rejected" : "approved");
    return [{
      type: "cron_confirm",
      confirmId: "",
      jobData,
      status,
    }];
  },

  update_settings: (details) => {
    if (!details.settingKey) return null;
    const status = details.confirmed === "timeout"
      ? "timeout"
      : (details.confirmed === false ? "rejected" : "confirmed");
    return [{
      type: "settings_confirm",
      confirmId: "",
      settingKey: details.settingKey,
      cardType: details.cardType || "list",
      currentValue: details.currentValue || "",
      proposedValue: details.proposedValue || "",
      label: details.label || details.settingKey,
      status,
    }];
  },
};

BLOCK_EXTRACTORS.present_files = BLOCK_EXTRACTORS.stage_files;

function extractPluginCard(details) {
  if (!details?.card?.pluginId) return null;
  const c = details.card;
  return { type: "plugin_card", card: { ...c, type: c.type || "iframe" } };
}

export function extractBlocks(toolName, details, toolResult) {
  const blocks = [];
  const extractor = BLOCK_EXTRACTORS[toolName];
  if (extractor) {
    const result = extractor(details || {}, toolResult);
    if (result) blocks.push(...result);
  }
  const card = extractPluginCard(details);
  if (card) blocks.push(card);
  return blocks;
}
