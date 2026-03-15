/**
 * fact-store.js — 深度记忆存储（元事实 + 标签）
 *
 * v2 记忆系统的 archival 层。每条记忆是一个"元事实"，
 * 附带标签和时间，通过标签匹配 + FTS5 全文搜索检索。
 *
 * 替代 v1 的 store.js（SQLite + sqlite-vec 向量搜索）。
 * 不使用 embedding / 向量 / score / decay / hit_count。
 */

import Database from "better-sqlite3";
import { scrubPII } from "../pii-guard.js";

/**
 * 当前 schema 版本。每次改表结构时递增，
 * 并在 _migrate() 里添加对应的迁移逻辑。
 */
const SCHEMA_VERSION = 1;

export class FactStore {
  /**
   * @param {string} dbPath - facts.db 的路径
   */
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("cache_size = -16000");     // 16MB（默认 ~2MB）
    this.db.pragma("temp_store = MEMORY");
    this.db.pragma("mmap_size = 30000000");    // 30MB mmap I/O
    this._initSchema();
    this._migrate();
    this._prepareStatements();
    this._tagSearchCache = new Map();          // tag 数量 → prepared statement
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        fact       TEXT NOT NULL,
        tags       TEXT NOT NULL DEFAULT '[]',
        time       TEXT,
        session_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_facts_time ON facts(time);
      CREATE INDEX IF NOT EXISTS idx_facts_session ON facts(session_id);
    `);

    // FTS5 全文搜索（中文 + 通用 tokenizer）
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE facts_fts USING fts5(
          fact,
          content=facts,
          content_rowid=id,
          tokenize='unicode61'
        );
      `);
    } catch {
      // 表已存在
    }

    // FTS 触发器：自动同步 facts → facts_fts
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
        INSERT INTO facts_fts(rowid, fact) VALUES (new.id, new.fact);
      END;
      CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, fact) VALUES ('delete', old.id, old.fact);
      END;
      CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, fact) VALUES ('delete', old.id, old.fact);
        INSERT INTO facts_fts(rowid, fact) VALUES (new.id, new.fact);
      END;
    `);
  }

  /**
   * Schema 迁移：读取 user_version，逐级执行迁移函数。
   * 每次改表结构时：
   *   1. SCHEMA_VERSION += 1
   *   2. 在 switch 里加一个 case
   */
  _migrate() {
    const current = this.db.pragma("user_version", { simple: true });
    if (current >= SCHEMA_VERSION) return;

    this.db.transaction(() => {
      let v = current;
      while (v < SCHEMA_VERSION) {
        switch (v) {
          case 0:
            // v0 → v1：初始 schema 标记（无实际变更，仅打版本戳）
            break;
          // 未来迁移示例：
          // case 1:
          //   this.db.exec("ALTER TABLE facts ADD COLUMN source TEXT");
          //   break;
        }
        v++;
      }
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();

    console.log(`[FactStore] schema migrated: v${current} → v${SCHEMA_VERSION}`);
  }

  _prepareStatements() {
    this._stmts = {
      insert: this.db.prepare(`
        INSERT INTO facts (fact, tags, time, session_id, created_at)
        VALUES (@fact, @tags, @time, @sessionId, @createdAt)
      `),
      getAll: this.db.prepare(`SELECT * FROM facts ORDER BY time DESC`),
      getById: this.db.prepare(`SELECT * FROM facts WHERE id = ?`),
      getBySession: this.db.prepare(`SELECT * FROM facts WHERE session_id = ? ORDER BY time DESC`),
      count: this.db.prepare(`SELECT COUNT(*) as cnt FROM facts`),
      deleteById: this.db.prepare(`DELETE FROM facts WHERE id = ?`),
      deleteAll: this.db.prepare(`DELETE FROM facts`),
      ftsSearch: this.db.prepare(`
        SELECT f.*, rank
        FROM facts_fts fts
        JOIN facts f ON f.id = fts.rowid
        WHERE facts_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `),
    };
  }

  /**
   * 新增一条元事实
   * @param {{ fact: string, tags: string[], time?: string, session_id?: string }} entry
   * @returns {{ id: number }}
   */
  add(entry) {
    const { cleaned, detected } = scrubPII(entry.fact);
    if (detected.length > 0) {
      console.warn(`[FactStore] PII detected (${detected.join(", ")}), redacted before storage`);
    }

    const now = new Date().toISOString();
    const result = this._stmts.insert.run({
      fact: cleaned,
      tags: JSON.stringify(entry.tags || []),
      time: entry.time || null,
      sessionId: entry.session_id || null,
      createdAt: now,
    });
    return { id: Number(result.lastInsertRowid) };
  }

  /**
   * 批量新增（事务）
   * @param {Array<{ fact: string, tags: string[], time?: string, session_id?: string }>} entries
   * @returns {number} 写入条数
   */
  addBatch(entries) {
    const run = this.db.transaction(() => {
      for (const entry of entries) {
        this.add(entry);
      }
    });
    run();
    return entries.length;
  }

  /**
   * 按标签搜索（精确匹配，OR 逻辑，按匹配数降序）
   *
   * 使用 json_each 精确匹配标签值，避免 LIKE 子串误匹配
   *
   * @param {string[]} queryTags - 查询标签
   * @param {{ from?: string, to?: string }} [dateRange] - 可选日期范围（YYYY-MM-DD 或 YYYY-MM-DDTHH:MM）
   * @param {number} [limit=20] - 最大返回数
   * @returns {Array<{ id, fact, tags, time, session_id, created_at, matchCount }>}
   */
  searchByTags(queryTags, dateRange, limit = 20) {
    if (!queryTags || queryTags.length === 0) return [];

    const stmt = this._getTagSearchStmt(queryTags.length, dateRange);

    const params = { limit };
    for (let i = 0; i < queryTags.length; i++) {
      params[`tag${i}`] = queryTags[i];
    }
    if (dateRange?.from) params.dateFrom = dateRange.from;
    if (dateRange?.to) params.dateTo = dateRange.to;

    const rows = stmt.all(params);
    return rows.map((row) => this._rowToFact(row));
  }

  /** 按 (tagCount, dateRangeType) 缓存 prepared statement */
  _getTagSearchStmt(tagCount, dateRange) {
    // dateRange 类型编码：0=无, 1=from, 2=to, 3=both
    const dateKey = (dateRange?.from ? 1 : 0) | (dateRange?.to ? 2 : 0);
    const cacheKey = `${tagCount}:${dateKey}`;

    let stmt = this._tagSearchCache.get(cacheKey);
    if (stmt) return stmt;

    const placeholders = Array.from({ length: tagCount }, (_, i) => `@tag${i}`).join(", ");
    let dateWhere = "";
    if (dateKey & 1) dateWhere += ` AND f.time >= @dateFrom`;
    if (dateKey & 2) dateWhere += ` AND f.time <= @dateTo`;

    const sql = `
      SELECT f.*, COUNT(DISTINCT je.value) as matchCount
      FROM facts f, json_each(f.tags) je
      WHERE je.value IN (${placeholders})${dateWhere}
      GROUP BY f.id
      ORDER BY matchCount DESC, f.time DESC
      LIMIT @limit
    `;

    stmt = this.db.prepare(sql);
    this._tagSearchCache.set(cacheKey, stmt);
    return stmt;
  }

  /**
   * 全文搜索（FTS5）
   *
   * @param {string} query - 搜索查询
   * @param {number} [limit=20]
   * @returns {Array<{ id, fact, tags, time, session_id, created_at }>}
   */
  searchFullText(query, limit = 20) {
    if (!query || !query.trim()) return [];

    try {
      // FTS5 查询：将自然语言查询分词后用 OR 连接
      // 对中文，unicode61 tokenizer 会按字符拆分
      const ftsQuery = query
        .trim()
        .split(/\s+/)
        .map((w) => `"${w.replace(/"/g, '""')}"`)
        .join(" OR ");

      const rows = this._stmts.ftsSearch.all(ftsQuery, limit);
      return rows.map((row) => this._rowToFact(row));
    } catch {
      // FTS 查询语法错误时降级为 LIKE
      return this._likeFallback(query, limit);
    }
  }

  /**
   * LIKE 降级搜索（FTS 失败时使用）
   */
  _likeFallback(query, limit) {
    const rows = this.db
      .prepare(`SELECT * FROM facts WHERE fact LIKE '%' || ? || '%' ORDER BY time DESC LIMIT ?`)
      .all(query, limit);
    return rows.map((row) => this._rowToFact(row));
  }

  /** 获取所有元事实（按时间降序） */
  getAll() {
    return this._stmts.getAll.all().map((row) => this._rowToFact(row));
  }

  /** 按 session_id 查询 */
  getBySession(sessionId) {
    return this._stmts.getBySession.all(sessionId).map((row) => this._rowToFact(row));
  }

  /** 按 id 查询 */
  getById(id) {
    const row = this._stmts.getById.get(id);
    return row ? this._rowToFact(row) : null;
  }

  get size() {
    return this._stmts.count.get().cnt;
  }

  /** 删除单条 */
  delete(id) {
    return this._stmts.deleteById.run(id).changes > 0;
  }

  /** 清空所有 */
  clearAll() {
    this.db.transaction(() => {
      this._stmts.deleteAll.run();
      // 重建 FTS 索引
      this.db.exec("INSERT INTO facts_fts(facts_fts) VALUES ('rebuild')");
    })();
  }

  /** 导出所有（不含内部字段），供 API 使用 */
  exportAll() {
    return this.getAll();
  }

  /**
   * 批量导入
   * @param {Array<{ fact, tags, time?, session_id? }>} entries
   */
  importAll(entries) {
    const run = this.db.transaction(() => {
      for (const entry of entries) {
        this.add({
          fact: entry.fact,
          tags: entry.tags || [],
          time: entry.time || null,
          session_id: entry.session_id || null,
        });
      }
    });
    run();
  }

  /** 关闭数据库连接 */
  close() {
    if (this.db?.open) this.db.close();
  }

  /** 行 → 对象 */
  _rowToFact(row) {
    return {
      id: row.id,
      fact: row.fact,
      tags: (() => {
        try { return JSON.parse(row.tags); } catch { return []; }
      })(),
      time: row.time,
      session_id: row.session_id,
      created_at: row.created_at,
      matchCount: row.matchCount ?? undefined,
    };
  }
}
