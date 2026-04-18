/**
 * Resolve target agent from request context.
 * Priority: query.agentId > params.agentId > engine.currentAgentId (焦点 agent)
 */

/** 读操作用：显式 ID 找不到时抛错；无 ID 时使用焦点 agent */
export function resolveAgent(engine, c) {
  const explicit = c.req.query("agentId") || c.req.param("agentId");
  if (explicit) {
    const found = engine.getAgent(explicit);
    if (!found) throw new AgentNotFoundError(explicit);
    return found;
  }
  // 无显式 ID：使用焦点 agent（UI 请求的默认行为）
  const agent = engine.getAgent(engine.currentAgentId);
  if (!agent) throw new AgentNotFoundError(engine.currentAgentId);
  return agent;
}

/** 写操作用：强制要求显式 agentId，不做 fallback */
export function resolveAgentStrict(engine, c) {
  const explicit = c.req.query("agentId") || c.req.param("agentId");
  if (!explicit) {
    throw new AgentNotFoundError("(missing agentId)");
  }
  const found = engine.getAgent(explicit);
  if (!found) throw new AgentNotFoundError(explicit);
  return found;
}

export class AgentNotFoundError extends Error {
  constructor(id) {
    super(`agent "${id}" not found`);
    this.name = "AgentNotFoundError";
    this.status = 404;
    this.agentId = id;
  }
}
