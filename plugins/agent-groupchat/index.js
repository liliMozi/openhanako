import path from "path";
import fs from "fs";
import { GroupChatStore } from "./lib/group-store.js";
import { setGroupStore } from "./extensions/context.js";

export default class AgentGroupChatPlugin {
  async onload() {
    const { bus, dataDir, log } = this.ctx;
    log.info("onload start");

    const hanakoHome = path.resolve(dataDir, "..", "..");
    log.info("hanakoHome=" + hanakoHome);

    const store = new GroupChatStore(dataDir);
    setGroupStore(store);
    log.info("store init ok");

    this.register(bus.handle("groupchat:send", async ({ groupId, text }) => {
      const group = await store.getGroup(groupId);
      if (!group) throw new Error("group not found: " + groupId);

      await store.append(groupId, {
        role: "owner", speaker: "master",
        content: text, timestamp: Date.now(),
      });

      let order = [...group.members];
      const mention = text.match(/@(\S+)/);
      if (mention) {
        const nameMap = { "hanako": "hanako", "mingjian": "mingjian", "suetsuki": "suetsuki" };
        const id = mention[1].startsWith("@") ? mention[1].slice(1) : mention[1];
        const found = order.find(a => id === a || nameMap[a] === id);
        if (found) order = [found, ...order.filter(a => a !== found)];
      }

      for (const agentId of order) {
        const sp = path.join(hanakoHome, "agents", agentId, "sessions",
          `group_${groupId}.jsonl`);
        fs.mkdirSync(path.dirname(sp), { recursive: true });

        try {
          await bus.request("session:send", { text, sessionPath: sp });
        } catch (err) {
          log.warn(agentId + " skip: " + err.message);
          continue;
        }

        const reply = await waitForAgentDone(bus, sp);
        if (reply.trim()) {
          await store.append(groupId, {
            role: agentId, speaker: agentId,
            content: reply, timestamp: Date.now(),
          });
        }
      }
    }));

    this.register(bus.handle("groupchat:create", async ({ name, members }) => {
      const id = "g_" + Date.now();
      await store.createGroup({ id, name, members });
      return { id, name, members };
    }));

    this.register(bus.handle("groupchat:append", async ({ groupId, role, speaker, content }) => {
      await store.append(groupId, { role, speaker, content, timestamp: Date.now() });
    }));

    this.register(bus.handle("groupchat:delete", async ({ groupId }) => {
      await store.deleteGroup(groupId);
      return { ok: true };
    }));

    this.register(bus.handle("groupchat:list", () => store.listGroups()));
    this.register(bus.handle("groupchat:messages", ({ groupId, since }) =>
      store.getMessages(groupId, since || 0)));

    log.info("loaded ok");
  }
}

function waitForAgentDone(bus, sp, ms = 180_000) {
  return new Promise(resolve => {
    let t = "";
    const u = bus.subscribe((e, p) => {
      if (p !== sp) return;
      if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta")
        t += e.assistantMessageEvent.delta || "";
      if (e.type === "turn_end") { u(); resolve(t); }
    });
    setTimeout(() => { u(); resolve(t); }, ms);
  });
}
