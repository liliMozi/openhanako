/**
 * block-extractors.js 鈥?Content Block 缁熶竴鎻愬彇娉ㄥ唽琛? *
 * 浠?toolResult.details 涓彁鍙?content blocks銆? * 鍏抽敭绾︽潫锛歟xtractor 鍙緷璧?details锛堝拰 toolResult.content锛夛紝
 * 涓嶄緷璧?toolCall.args锛屽洜涓?sessions.js 涓?Pi SDK 瀛樺偍鐨? * toolResult 娑堟伅娌℃湁 .toolCall 灞炴€с€? */

import { materializeExecutorIdentity } from "../lib/subagent-executor-metadata.js";

export const BLOCK_EXTRACTORS = {
  // COMPAT(v0.98): present_files 鏄?stage_files 鐨勬棫鍚嶏紝鍏辩敤 extractor銆倂0.98 鍚庡彲鍒?  stage_files: (details) => {
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
    const data = imgBlock?.data || details.thumbnail;
    if (!data) return null;
    return [{
      type: "screenshot",
      base64: data,
      mimeType: imgBlock?.mimeType || details.mimeType || "image/jpeg",
    }];
  },

  computer: (details) => {
    const confirmation = details.confirmation;
    if (details.action !== "start" || confirmation?.kind !== "computer_app_approval") return null;
    const block = buildComputerAppApprovalBlock(confirmation);
    return block ? [block] : null;
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
      // COMPAT(v0.98): 鑰?session 娌℃湁 jobData 瀛楁锛屼粠 job 瀵硅薄閲嶅缓銆倂0.98 鍚庡彲鍒?      const j = details.job;
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

  subagent: (details) => {
    if (!details.taskId) return null;
    const executor = materializeExecutorIdentity(details);
    const requestedAgentId = details.requestedAgentId || details.agentId || null;
    const requestedAgentName = details.requestedAgentNameSnapshot || details.agentName || requestedAgentId || null;
    return [{
      type: "subagent",
      taskId: details.taskId,
      task: details.task || "",
      taskTitle: details.taskTitle || "",
      agentId: executor?.agentId || null,
      agentName: executor?.agentName || null,
      requestedAgentId,
      requestedAgentName,
      executorAgentId: details.executorAgentId || executor?.agentId || null,
      executorAgentNameSnapshot: details.executorAgentNameSnapshot || executor?.agentName || null,
      streamKey: details.sessionPath || "",
      streamStatus: details.streamStatus || "running",
      summary: details.summary || null,
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

BLOCK_EXTRACTORS.present_files = BLOCK_EXTRACTORS.stage_files; // COMPAT(v0.98)
BLOCK_EXTRACTORS["agent-groupchat_full_agent"] = BLOCK_EXTRACTORS.subagent;

function buildComputerAppApprovalBlock(confirmation) {
  const approval = confirmation?.approval;
  if (!approval?.providerId || !approval?.appId) return null;
  const appName = approval.appName || approval.appId;
  return {
    type: "session_confirmation",
    confirmId: confirmation.confirmId || "",
    kind: "computer_app_approval",
    surface: "input",
    status: confirmation.status || "pending",
    title: "鍏佽 Hana 浣跨敤鐢佃剳",
    body: "Hana 鎯虫帶鍒惰繖涓簲鐢ㄦ潵缁х画褰撳墠浠诲姟銆?,
    subject: {
      label: appName,
      detail: `${approval.providerId} 路 ${approval.appId}`,
    },
    severity: "elevated",
    actions: {
      confirmLabel: "鍚屾剰",
      rejectLabel: "鎷掔粷",
    },
    payload: { approval },
  };
}

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
