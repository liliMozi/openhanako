/**
 * full_agent - call another complete Agent (replaces limited subagent)
 *
 * Async fire-and-forget + DeferredResultStore: same mechanism as subagent
 * Results delivered via deferred-result-ext (steer message)
 * Progress delivered via block_update events
 */

export const name = "full_agent";
export const description = `调用另一个助手执行任务。被调用的助手拥有完整能力：全部工具、文件读写、搜索、命令执行、记忆、人格。

使用方式：full_agent {助手ID} {任务描述}

可用的助手ID：
- mingjian - 逻辑检查与分析
- suetsuki - 创意写作与表达

示例：
- full_agent mingjian 帮我检查这段代码的逻辑漏洞
- full_agent suetsuki 根据以下设定写一段场景描写`;

export const parameters = {
  type: "object",
  properties: {
    agent_id: {
      type: "string",
      description: "要调用的助手ID：mingjian 或 suetsuki"
    },
    task: {
      type: "string",
      description: "要分配给该助手的完整任务描述"
    }
  },
  required: ["agent_id", "task"]
};

export const promptSnippet = `当你需要调用 {{agent_id}} 执行任务时，使用 full_agent。被调用的 {{agent_id}} 拥有完整能力——可以读写文件、搜索网页、执行命令、使用自己的记忆和人格。

调用格式：full_agent {助手ID} {详细任务描述}

注意：被调用的助手的回复会自动追加到当前对话中，你不需要再次转述。`;

const TIMEOUT_MS = 15 * 60 * 1000;

export async function execute(toolArgs, pluginCtx) {
  const { agent_id, task } = toolArgs;
  if (!agent_id || !task) {
    return { content: [{ type: "text", text: "错误：agent_id 和 task 都是必填参数" }] };
  }

  const idMap = {
    mingjian: "mingjian", "\u660e\u9274": "mingjian",
    suetsuki: "suetsuki", "\u7d20\u6708": "suetsuki",
  };
  const agentId = idMap[agent_id] || agent_id;

  const bus = pluginCtx?.bus;
  const parentSessionPath = pluginCtx?.sessionPath;

  if (!bus?.request) {
    return { content: [{ type: "text", text: "错误：EventBus 不可用" }] };
  }

  const taskId = `full_agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const taskTitle = task.split(/\r?\n/).map(function(l) { return l.trim(); }).find(Boolean) || "";

  bus.request("groupchat:execute-agent", {
    agentId,
    text: task,
    parentSessionPath,
    taskId,
  }, { timeout: TIMEOUT_MS }).catch(function(err) {
    console.error("[full_agent] request failed:", err.message);
  });

  return {
    content: [{ type: "text", text: "已将任务派发给 " + agentId + "（" + taskId + "）" }],
    details: {
      taskId,
      task,
      taskTitle,
      agentId,
      sessionPath: null,
      streamStatus: "running",
      executorAgentId: agentId,
      executorAgentNameSnapshot: agentId,
    },
  };
}