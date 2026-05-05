export const name = "full_agent";
export const description = "调用另一个完整能力的 Agent 执行任务。被调用的 Agent 拥有全部工具、记忆、人格。\n\n可用的助手ID：\n- mingjian — 逻辑检查与分析\n- suetsuki — 创意写作与表达\n\n用法：full_agent {助手ID} {任务描述}";
export const parameters = {
  type: "object",
  properties: {
    agent_id: { type: "string", description: "助手ID：mingjian 或 suetsuki" },
    task: { type: "string", description: "任务描述" }
  },
  required: ["agent_id", "task"]
};

const TIMEOUT = 15 * 60 * 1000;

export async function execute(input, toolCtx) {
  const { agent_id, task } = input;
  if (!agent_id || !task) return "错误：agent_id 和 task 都是必填参数";

  const idMap = { mingjian: "mingjian", suetsuki: "suetsuki" };
  const agentId = idMap[agent_id] || agent_id;
  const bus = toolCtx?.bus;
  const sp = toolCtx?.sessionPath;

  if (!bus?.request) return "错误：系统总线不可用";

  const taskId = "fa_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);

  bus.request("groupchat:execute-agent", {
    agentId, text: task, parentSessionPath: sp, taskId
  }, { timeout: TIMEOUT }).catch(function(e) {
    console.error("[full_agent]", e.message);
  });

  return {
    content: [{ type: "text", text: "已将任务派发给 " + agentId + "（" + taskId + "）" }],
    details: {
      taskId: taskId,
      task: task,
      taskTitle: task.split(/\r?\n/).map(function(l) { return l.trim(); }).find(Boolean) || agentId,
      agentId: agentId,
      sessionPath: null,
      streamStatus: "running",
      executorAgentId: agentId,
      executorAgentNameSnapshot: agentId,
    },
  };
}
