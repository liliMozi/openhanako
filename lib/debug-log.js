/**
 * debug-log.js — 持久化调试日志
 *
 * 每次 server 启动时创建一个日志文件（按时间戳命名），
 * 运行期间追加写入，关闭后下次启动写新的。
 *
 * 格式：[HH:MM:SS.mmm] [LEVEL] [MODULE] message
 * 路径：~/.hanako/logs/YYYY-MM-DD_HH-MM-SS.log
 */

import fs from "fs";
import path from "path";
import os from "os";

class DebugLog {
  /**
   * @param {string} logDir - 日志目录路径（如 ~/.hanako/logs）
   */
  constructor(logDir) {
    fs.mkdirSync(logDir, { recursive: true });

    const now = new Date();
    const ts = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("-") + "_" + [
      String(now.getHours()).padStart(2, "0"),
      String(now.getMinutes()).padStart(2, "0"),
      String(now.getSeconds()).padStart(2, "0"),
    ].join("-");

    this._filePath = path.join(logDir, `${ts}.log`);
    this._logDir = logDir;
    this._size = 0;
    this._truncated = false;

    // 去重状态：记录上一条写入的内容
    this._dedup = { level: null, module: null, msg: null, count: 0 };

    // 清理超过 7 天的旧日志
    this._cleanup(7);
  }

  get filePath() { return this._filePath; }

  /**
   * 写启动头部信息
   * @param {string} version - 应用版本号
   * @param {object} info - 启动信息
   */
  header(version, info = {}) {
    const lines = [
      "═".repeat(60),
      `Hanako v${version} — started at ${new Date().toISOString()}`,
      "═".repeat(60),
    ];

    if (info.model) lines.push(`Model: ${info.model}`);
    if (info.agent) lines.push(`Agent: ${info.agent} (${info.agentId || "?"})`);
    if (info.utilityModel) lines.push(`Utility: ${info.utilityModel}`);
    if (info.channelsDir) lines.push("Channels: configured");

    lines.push("─".repeat(60), "");

    fs.appendFileSync(this._filePath, lines.join("\n") + "\n", "utf-8");
  }

  /**
   * 写关闭标记
   */
  close() {
    this._flushDedup();
    this._write("INFO", "system", "Server shutting down");
    fs.appendFileSync(this._filePath, "\n" + "═".repeat(60) + "\n", "utf-8");
  }

  /** INFO 级别日志 */
  log(module, msg) {
    this._write("INFO", module, msg);
  }

  /** ERROR 级别日志 */
  error(module, msg) {
    this._write("ERROR", module, msg);
  }

  /** WARN 级别日志 */
  warn(module, msg) {
    this._write("WARN", module, msg);
  }

  /**
   * 读取最近 N 行日志
   * @param {number} n - 行数
   * @returns {string[]}
   */
  tail(n = 100) {
    try {
      const content = fs.readFileSync(this._filePath, "utf-8");
      const lines = content.split("\n");
      return lines.slice(-n);
    } catch {
      return [];
    }
  }

  /** 对消息做隐私清洗后写入（含去重判断） */
  _write(level, module, msg) {
    const cleaned = this._scrub(String(msg));

    // 去重：与上一条完全相同则只计数
    const d = this._dedup;
    if (d.level === level && d.module === module && d.msg === cleaned) {
      d.count++;
      return;
    }

    // 有积压的重复条目，先补写一行摘要
    this._flushDedup();

    // 更新去重状态
    this._dedup = { level, module, msg: cleaned, count: 1 };

    this._append(level, module, cleaned);
  }

  /** 把积压的"重复 N 次"补写进文件 */
  _flushDedup() {
    const d = this._dedup;
    if (d.count > 1) {
      this._append("INFO", "dedup", `⤷ 上条重复 ${d.count} 次`);
    }
    this._dedup = { level: null, module: null, msg: null, count: 0 };
  }

  /** 底层写入（单文件上限 5MB，超限后写一次截断通知再静默丢弃） */
  _append(level, module, msg) {
    const MAX = 5 * 1024 * 1024;

    if (this._truncated) return;

    if (this._size >= MAX) {
      try {
        const notice = "\n[日志已达 5MB 上限，后续内容已截断]\n";
        fs.appendFileSync(this._filePath, notice, "utf-8");
      } catch { /* ignore */ }
      this._truncated = true;
      return;
    }

    const now = new Date();
    const time = [
      String(now.getHours()).padStart(2, "0"),
      String(now.getMinutes()).padStart(2, "0"),
      String(now.getSeconds()).padStart(2, "0"),
    ].join(":") + "." + String(now.getMilliseconds()).padStart(3, "0");

    const line = `[${time}] [${level}] [${module}] ${msg}\n`;

    try {
      fs.appendFileSync(this._filePath, line, "utf-8");
      this._size += Buffer.byteLength(line, "utf-8");
    } catch {
      // 写日志失败不应阻塞业务
    }
  }

  /** 隐私清洗：移除或遮盖可识别用户身份的信息 */
  _scrub(msg) {
    // 1. home 目录路径 → ~（最无损的替换，仅隐藏用户名）
    const home = os.homedir();
    if (home) msg = msg.split(home).join("~");

    // 2. URL 内嵌凭证：https://user:pass@host → https://***@host
    msg = msg.replace(/https?:\/\/[^:@\s/]+:[^@\s/]+@/gi, (m) => {
      const proto = m.match(/^https?:\/\//i)[0];
      const host = m.slice(m.lastIndexOf("@"));
      return `${proto}***${host}`;
    });

    // 3. Bearer token
    msg = msg.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, "Bearer ***");

    // 4. key=/token=/secret= 后跟的值
    msg = msg.replace(
      /\b(api_key|apikey|api-key|token|secret|password|passwd|Authorization)\s*[=:]\s*\S+/gi,
      (_, k) => `${k}=***`
    );

    // 5. 独立的长随机串（40 字符以上的 base64/hex，非路径、非 URL）
    msg = msg.replace(/(?<![/\w])[A-Za-z0-9+/]{40,}={0,2}(?![/\w])/g, "[token]");

    // 6. 电子邮件地址
    msg = msg.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, "[email]");

    return msg;
  }

  /** 清理超过 maxDays 天的旧日志 */
  _cleanup(maxDays) {
    try {
      const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
      const files = fs.readdirSync(this._logDir).filter(f => f.endsWith(".log"));

      for (const f of files) {
        const filePath = path.join(this._logDir, f);
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
        }
      }
    } catch {
      // 清理失败不影响运行
    }
  }
}

// ── 全局单例 ──

let _instance = null;

/**
 * 初始化全局日志实例
 * @param {string} logDir - 日志目录路径
 * @returns {DebugLog}
 */
export function initDebugLog(logDir) {
  _instance = new DebugLog(logDir);
  return _instance;
}

/**
 * 获取全局日志实例
 * @returns {DebugLog|null}
 */
export function debugLog() {
  return _instance;
}

/**
 * 创建模块专用日志器
 *
 * 同时写 console + 持久日志文件，统一替代散落的 console.error / debugLog()?.log()。
 *
 * @param {string} module - 模块标识（如 "engine", "bridge", "session"）
 * @returns {{ log: (msg: string) => void, warn: (msg: string) => void, error: (msg: string) => void }}
 *
 * @example
 * const log = createModuleLogger("bridge");
 * log.error("connection failed");
 * // console: [bridge] connection failed
 * // file:    [HH:MM:SS.mmm] [ERROR] [bridge] connection failed
 */
export function createModuleLogger(module) {
  return {
    log(msg) {
      console.log(`[${module}] ${msg}`);
      _instance?.log(module, msg);
    },
    warn(msg) {
      console.warn(`[${module}] ${msg}`);
      _instance?.warn(module, msg);
    },
    error(msg) {
      console.error(`[${module}] ${msg}`);
      _instance?.error(module, msg);
    },
  };
}
