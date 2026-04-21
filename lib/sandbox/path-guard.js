/**
 * path-guard.js — 路径权限校验
 *
 * 定义四种访问级别：BLOCKED / READ_ONLY / READ_WRITE / FULL
 * 所有路径先经过 realpath 解析符号链接，再匹配区域。
 *
 * 常量从 policy.js 导入（单一来源）。
 */

import fs from "fs";
import path from "path";
import { t } from "../../server/i18n.js";
import {
  BLOCKED_FILES,
  BLOCKED_DIRS,
  READ_ONLY_AGENT_FILES,
  READ_ONLY_AGENT_DIRS,
  READ_ONLY_HOME_DIRS,
  READ_WRITE_AGENT_DIRS,
  READ_WRITE_AGENT_FILES,
  READ_WRITE_HOME_DIRS,
} from "./policy.js";

export const AccessLevel = {
  BLOCKED: "blocked",
  READ_ONLY: "read_only",
  READ_WRITE: "read_write",
  FULL: "full",
};

/** 操作 → 所需最低级别 */
const OP_REQUIREMENTS = {
  read: new Set([AccessLevel.READ_ONLY, AccessLevel.READ_WRITE, AccessLevel.FULL]),
  write: new Set([AccessLevel.READ_WRITE, AccessLevel.FULL]),
  delete: new Set([AccessLevel.FULL]),
};

export class PathGuard {
  /**
   * @param {object} policy  从 deriveSandboxPolicy() 得到，或兼容旧格式
   */
  constructor(policy) {
    if (policy.mode === "full-access") {
      this._fullAccess = true;
      return;
    }
    this._fullAccess = false;
    this.hanakoHome = path.resolve(policy.hanakoHome);
    this.agentDir = path.resolve(policy.agentDir);
    this.workspace = policy.workspace ? path.resolve(policy.workspace) : null;
  }

  /**
   * 解析路径（跟踪符号链接）。
   * 文件不存在时递归往上找到最近的存在的祖先目录，
   * 对它做 realpath，然后把不存在的段拼回去。
   * 这样 mkdir -p 多层目录时也能正确判断权限。
   */
  _resolveReal(p) {
    const abs = path.resolve(p);
    try {
      return fs.realpathSync(abs);
    } catch (err) {
      if (err.code !== "ENOENT") return null;

      const pending = [];
      let current = abs;
      while (true) {
        const parent = path.dirname(current);
        if (parent === current) return null; // 到根目录还找不到
        pending.push(path.basename(current));
        try {
          const realParent = fs.realpathSync(parent);
          pending.reverse();
          return path.join(realParent, ...pending);
        } catch (e) {
          if (e.code !== "ENOENT") return null;
          current = parent;
        }
      }
    }
  }

  /** 判断 target 是否在 base 内部（含相等） */
  _isInside(target, base) {
    return target === base || target.startsWith(base + path.sep);
  }

  /**
   * 获取路径的访问级别
   * @param {string} rawPath 绝对路径
   * @returns {string} AccessLevel
   */
  getAccessLevel(rawPath) {
    const resolved = this._resolveReal(rawPath);
    if (!resolved) return AccessLevel.BLOCKED;

    // 1. BLOCKED 文件（hanakoHome 根）
    for (const f of BLOCKED_FILES) {
      if (resolved === path.join(this.hanakoHome, f)) return AccessLevel.BLOCKED;
    }

    // 2. BLOCKED 目录
    for (const d of BLOCKED_DIRS) {
      if (this._isInside(resolved, path.join(this.hanakoHome, d))) {
        return AccessLevel.BLOCKED;
      }
    }

    // 3. READ_ONLY agent 文件
    for (const f of READ_ONLY_AGENT_FILES) {
      if (resolved === path.join(this.agentDir, f)) return AccessLevel.READ_ONLY;
    }

    // 4. READ_ONLY agent 目录（learned-skills 等）
    for (const d of READ_ONLY_AGENT_DIRS) {
      if (this._isInside(resolved, path.join(this.agentDir, d))) {
        return AccessLevel.READ_ONLY;
      }
    }

    // 5. READ_ONLY 全局目录
    for (const d of READ_ONLY_HOME_DIRS) {
      if (this._isInside(resolved, path.join(this.hanakoHome, d))) {
        return AccessLevel.READ_ONLY;
      }
    }

    // 6. READ_WRITE agent 目录
    for (const d of READ_WRITE_AGENT_DIRS) {
      if (this._isInside(resolved, path.join(this.agentDir, d))) {
        return AccessLevel.READ_WRITE;
      }
    }

    // 6. READ_WRITE agent 文件
    for (const f of READ_WRITE_AGENT_FILES) {
      if (resolved === path.join(this.agentDir, f)) return AccessLevel.READ_WRITE;
    }

    // 7. READ_WRITE 全局目录
    for (const d of READ_WRITE_HOME_DIRS) {
      if (this._isInside(resolved, path.join(this.hanakoHome, d))) {
        return AccessLevel.READ_WRITE;
      }
    }

    // 8. hanakoHome 内未匹配 → 安全兜底 BLOCKED
    if (this._isInside(resolved, this.hanakoHome)) return AccessLevel.BLOCKED;

    // 9. workspace 内 → FULL
    if (this.workspace && this._isInside(resolved, this.workspace)) {
      return AccessLevel.FULL;
    }

    // 10. 其他 → BLOCKED
    return AccessLevel.BLOCKED;
  }

  /**
   * 检查操作是否被允许
   * @param {string} absolutePath
   * @param {"read"|"write"|"delete"} operation
   * @returns {{ allowed: boolean, reason?: string }}
   */
  check(absolutePath, operation) {
    if (this._fullAccess) return { allowed: true };
    const level = this.getAccessLevel(absolutePath);
    const allowed = OP_REQUIREMENTS[operation]?.has(level) ?? false;

    if (allowed) return { allowed: true };

    const resolved = this._resolveReal(absolutePath) || absolutePath;
    const opLabel = { read: t("sandbox.opRead"), write: t("sandbox.opWrite"), delete: t("sandbox.opDelete") }[operation] || operation;
    return {
      allowed: false,
      reason: t("sandbox.denied", { op: opLabel, path: resolved, level }),
    };
  }

}
