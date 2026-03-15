/**
 * activity-store.js — 助手活动元数据存储
 *
 * 管理心跳、cron 等后台执行的记录。
 * 每次执行存一条元数据（摘要、时间、状态），
 * session .jsonl 文件单独存放在 activity/ 目录。
 *
 * 自动清理：超过 MAX_ENTRIES 条时删除最老的，连同 session 文件。
 */

import fs from "fs";
import path from "path";

const MAX_ENTRIES = 100;

export class ActivityStore {
  /**
   * @param {string} filePath - activities.json 路径
   * @param {string} activityDir - session 文件所在目录
   */
  constructor(filePath, activityDir) {
    this._filePath = filePath;
    this._activityDir = activityDir;
    this._entries = [];
    this._load();
  }

  /** @private */
  _load() {
    try {
      const raw = fs.readFileSync(this._filePath, "utf-8");
      this._entries = JSON.parse(raw);
      if (!Array.isArray(this._entries)) this._entries = [];
    } catch {
      this._entries = [];
    }
  }

  /** @private */
  _save() {
    fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
    // atomic write: tmp + rename，防止写到一半崩溃损坏文件
    const tmpPath = this._filePath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(this._entries, null, 2), "utf-8");
    fs.renameSync(tmpPath, this._filePath);
  }

  /**
   * 添加活动记录
   * @param {object} entry
   * @returns {object} 添加的记录
   */
  add(entry) {
    this._entries.unshift(entry);
    this._cleanup();
    this._save();
    return entry;
  }

  /** 列出所有活动（已按时间倒序） */
  list() {
    return this._entries;
  }

  /** 按 ID 查找 */
  get(id) {
    return this._entries.find(e => e.id === id) || null;
  }

  /** 自动清理超出上限的老记录 */
  _cleanup() {
    while (this._entries.length > MAX_ENTRIES) {
      const old = this._entries.pop();
      // 删除对应的 session 文件
      if (old?.sessionFile) {
        const sessionPath = path.join(this._activityDir, old.sessionFile);
        try { fs.unlinkSync(sessionPath); } catch {}
      }
    }
  }
}
