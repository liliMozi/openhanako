import fs from "fs";
import path from "path";

export class GroupChatStore {
  constructor(dataDir) {
    this._dir = path.join(dataDir, "groups");
    fs.mkdirSync(this._dir, { recursive: true });
  }

  _groupFilePath(groupId) {
    return path.join(this._dir, `${groupId}.jsonl`);
  }

  _metaFilePath(groupId) {
    return path.join(this._dir, `${groupId}.json`);
  }

  async createGroup({ id, name, members }) {
    const metaPath = this._metaFilePath(id);
    const group = { id, name, members, createdAt: Date.now() };
    await fs.promises.writeFile(metaPath, JSON.stringify(group, null, 2), "utf-8");
    return group;
  }

  async deleteGroup(groupId) {
    const metaPath = this._metaFilePath(groupId);
    const msgPath = this._groupFilePath(groupId);
    if (fs.existsSync(metaPath)) await fs.promises.unlink(metaPath);
    if (fs.existsSync(msgPath)) await fs.promises.unlink(msgPath);
  }

  async getGroup(groupId) {
    const metaPath = this._metaFilePath(groupId);
    if (!fs.existsSync(metaPath)) return null;
    return JSON.parse(await fs.promises.readFile(metaPath, "utf-8"));
  }

  listGroups() {
    const groups = [];
    for (const f of fs.readdirSync(this._dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        groups.push(JSON.parse(fs.readFileSync(path.join(this._dir, f), "utf-8")));
      } catch {}
    }
    return groups;
  }

  async append(groupId, message) {
    const line = JSON.stringify(message) + "\n";
    await fs.promises.appendFile(this._groupFilePath(groupId), line, "utf-8");
  }

  getMessages(groupId, since = 0) {
    const p = this._groupFilePath(groupId);
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, "utf-8");
    if (!raw.trim()) return [];
    const lines = raw.split("\n").filter(Boolean);
    const messages = [];
    for (const line of lines) {
      try {
        const m = JSON.parse(line);
        if (!since || (m.timestamp && m.timestamp > since)) {
          messages.push(m);
        }
      } catch {}
    }
    return messages;
  }
}
