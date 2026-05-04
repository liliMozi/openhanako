/**
 * Pi SDK extension — 群聊上下文注入
 * 写入 global 避免 freshImport 双实例
 */
const SEP = "__groupchat_store";

export function setGroupStore(s) { global[SEP] = s; }
function store() { return global[SEP]; }

export default function () {
  return {
    async session_start(pi, ctx) {
      const s = global[SEP];
      if (!s) return;
      const sf = ctx.sessionManager?.getSessionFile?.() || "";
      if (!sf.includes("group_")) return;

      const groupId = sf.replace(/\\/g, "/").split("/").pop()
        .replace(".jsonl", "").replace("group_", "");

      const messages = s.getMessages(groupId) || [];
      if (!messages.length) return;

      const lines = messages.slice(-20).map(m => {
        const nameMap = { hanako: "半夏", mingjian: "明鉴", suetsuki: "素月", owner: "主人" };
        const speaker = m.speaker || nameMap[m.role] || m.role;
        return `[${speaker}]: ${m.content}`;
      });

      const ctxPrompt = `【群聊上下文】\n${lines.join("\n")}\n---\n`;
      const current = ctx.agent.state.systemPrompt || "";
      ctx.agent.state.systemPrompt = ctxPrompt + current;
    }
  };
}
