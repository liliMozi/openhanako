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

  /** 内部写入方法（单文件上限 5MB，超过后静默丢弃） */
  _write(level, module, msg) {
    if (this._size >= 5 * 1024 * 1024) return;

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
