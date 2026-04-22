import { SlashCommandRegistry } from "../slash-command-registry.js";
import { SlashCommandDispatcher } from "../slash-command-dispatcher.js";
import { createSessionOps } from "./session-ops.js";
import { bridgeCommands } from "./bridge-commands.js";
import { RcStateStore } from "./rc-state.js";

// 注：此前这里曾有 exposeSkillsAsCommands 把 agent 的 runtime skills 暴露成
// /<skillName> 斜杠命令。但实际链路是：
//   - 桌面端：前端 InputArea 通过 useSkillSlashItems hook 拿 skill 列表，
//     走 editor SkillBadge 插入，**不经过 slash registry / dispatcher**
//   - bridge 端：dispatcher 能匹配到 /<skillName>，但 handler 返回 silent 占位
//     不做任何 prompt 注入——对用户表现为"斜杠被吞掉无反应"
// 因此 registry 里的 skill 条目对桌面是噪声、对 bridge 是糟糕 UX。
// 按用户决策删除，让 bridge 的 /diary /xing 等走"未知斜杠"路径：
// dispatcher handled=false → 消息进 _flushPending → LLM 正常处理 "/diary" 文本。
// 真要给 bridge 做 skill 执行时再专门写一条 "bridge 调 skill" 的路径，
// 不在 registry 里留 silent 空壳。

export function createSlashSystem({ engine, hub }) {
  const registry = new SlashCommandRegistry();
  const sessionOps = createSessionOps({ engine });
  // Phase 2-A：rc 态 store 在 slash-system 构造时注入（随 engine 生命周期，重启清空）
  const rcState = new RcStateStore();
  const dispatcher = new SlashCommandDispatcher({ registry, engine, hub, sessionOps });
  for (const def of bridgeCommands) registry.registerCommand(def);
  return { registry, dispatcher, sessionOps, rcState };
}
