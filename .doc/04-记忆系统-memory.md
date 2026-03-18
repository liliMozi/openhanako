# 记忆系统 (lib/memory/)

记忆系统是 OpenHanako 最核心的差异化特性。它让 Agent 能够跨对话记住用户的信息，并在合适的时候自然地运用这些记忆。

## 设计理念

1. **轻量** — 不用向量数据库，用 SQLite FTS5 全文搜索
2. **分层** — 短期记忆（今天）→ 中期记忆（本周）→ 长期记忆
3. **自然** — 记忆的存在感为零，影响力为满（不说"我记得"，但行为体现记忆）
4. **可控** — 两层开关（Agent 级 + Session 级），用户可随时关闭

## 架构总览

```
对话消息流
  │
  ▼
SessionSummaryManager — 滚动摘要（每 6 轮 / Session 结束时）
  │
  ▼
compile.js — 四阶段编译
  ├── compileToday() → today.md
  ├── compileWeek() → week.md
  ├── compileLongterm() → longterm.md
  └── compileFacts() → facts.md
  │
  ▼
assemble() → memory.md（注入 System Prompt）
  │
  ▼
deep-memory.js — 元事实提取
  │
  ▼
FactStore (facts.db) — SQLite FTS5 全文搜索
  │
  ▼
search_memory 工具 — Agent 主动搜索记忆
```

## FactStore — 元事实数据库

### 数据库结构

```sql
CREATE TABLE facts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  fact       TEXT NOT NULL,           -- 元事实内容
  tags       TEXT NOT NULL DEFAULT '[]',  -- JSON 数组，标签
  time       TEXT,                    -- 时间 YYYY-MM-DDTHH:MM
  session_id TEXT,                    -- 所属 session
  created_at TEXT NOT NULL            -- 创建时间
);

CREATE INDEX idx_facts_time ON facts(time);
CREATE INDEX idx_facts_session ON facts(session_id);

-- FTS5 全文搜索虚拟表
CREATE VIRTUAL TABLE facts_fts USING fts5(
  fact,
  content=facts,
  content_rowid=id,
  tokenize='unicode61'
);

-- 同步触发器（INSERT/DELETE/UPDATE 自动同步到 FTS5）
```

### 搜索方式

**1. 标签搜索** `searchByTags(queryTags, dateRange, limit)`

```sql
SELECT f.*, COUNT(DISTINCT jt.value) AS matchCount
FROM facts f, json_each(f.tags) jt
WHERE jt.value IN (?, ?, ...)
GROUP BY f.id
ORDER BY matchCount DESC, f.time DESC
LIMIT ?
```

用 `json_each` 展开 JSON 数组做精确匹配，避免 LIKE 误匹配（如搜"编程"不会匹配到"编程语言"标签中的子串）。

**2. 全文搜索** `searchFullText(query, limit)`

```sql
SELECT f.*, rank
FROM facts_fts fts
JOIN facts f ON f.id = fts.rowid
WHERE facts_fts MATCH '"term1" OR "term2" OR "term3"'
ORDER BY rank
LIMIT ?
```

将自然语言分词后用 OR 连接。中文由 `unicode61` tokenizer 按字符拆分。FTS5 失败时降级为 LIKE 搜索。

### PII 脱敏

写入前调用 `scrubPII()` 检测个人身份信息（手机号、身份证号等），检测到时打日志并脱敏后存储。

---

## SessionSummaryManager — 滚动摘要

### 数据结构

每个 Session 一个 JSON 文件（`summaries/{sessionId}.json`）：

```json
{
  "session_id": "2024-03-18T10-30-00.jsonl",
  "created_at": "2024-03-18T10:30:00.000Z",
  "updated_at": "2024-03-18T11:45:00.000Z",
  "summary": "## 重要事实\n- 用户在做 React 项目\n\n## 事情经过\n- 讨论了组件设计...",
  "snapshot": "上次深度记忆处理时的摘要快照",
  "snapshot_at": "2024-03-18T11:00:00.000Z"
}
```

### 滚动摘要逻辑

```
输入：对话消息列表
  │
  ├── 1. 转换为文本格式
  │      [10:30] 【用户】帮我看看这段代码
  │      [10:31] 【Hanako】好的，我来看看...（超过300字截断）
  │
  ├── 2. 计算配额
  │      totalBudget = min(400, max(40, turnCount × 40))
  │      factsBudget ≈ 30%
  │      eventsBudget = 剩余
  │
  ├── 3. 调用 LLM 生成摘要
  │      ├── 无旧摘要 → 从对话直接生成
  │      └── 有旧摘要 → 输入"已有摘要 + 新增对话"，合并更新
  │
  └── 4. 输出固定两节
         ## 重要事实
         - ...
         ## 事情经过
         - ...
```

---

## MemoryTicker — 记忆调度器

### 触发时机

| 触发点 | 条件 | 执行内容 |
|--------|------|----------|
| 每 6 轮对话 | `notifyTurn()` 且 `count % 6 === 0` | 滚动摘要 → compileToday → assemble |
| Session 结束 | `notifySessionEnd()` | 滚动摘要 → compileToday → assemble → 经验提取 |
| 每日（日期变化） | `_lastDailyJobDate !== todayStr` | 完整编译 + deep-memory |
| 每小时 | `start()` 的 timer | 检查是否需要执行每日任务 |

### 每日任务步骤

```
1. compileToday() — 当天 session 摘要 → today.md
2. compileWeek() — 过去 7 天摘要 → week.md
3. compileLongterm() — week.md 折叠进 longterm.md
4. compileFacts() — 摘要中的重要事实 → facts.md
5. assemble() — 四个文件 → memory.md
6. deep-memory — 提取元事实 → facts.db
```

### 容错机制

- **断点续跑**：`_dailyStepsCompleted` 记录完成步骤，失败时 1 小时后重试
- **崩溃恢复**：启动时扫描 24 小时内修改的 Session，补跑未完成的滚动摘要
- **大文件处理**：超过 256KB 的 JSONL 只读尾部

---

## compile.js — 四阶段编译

### 编译流程

```
                    当天 session 摘要
                         │
                         ▼
               ┌─── compileToday() ───┐
               │                      │
               │    today.md          │
               │    (当天记忆)         │
               │                      │
               └──────────────────────┘
                         │
          过去 7 天 session 摘要
                         │
                         ▼
               ┌─── compileWeek() ────┐
               │                      │
               │    week.md           │
               │    (本周记忆)         │
               │                      │
               └──────────────────────┘
                         │
               week.md + 现有 longterm.md
                         │
                         ▼
              ┌── compileLongterm() ──┐
              │                      │
              │    longterm.md       │
              │    (长期记忆)         │
              │                      │
              └──────────────────────┘

          过去 30 天摘要的"重要事实"段
                         │
                         ▼
              ┌── compileFacts() ────┐
              │                      │
              │    facts.md          │
              │    (重要事实)         │
              │                      │
              └──────────────────────┘

              facts.md + today.md + week.md + longterm.md
                         │
                         ▼
              ┌──── assemble() ──────┐
              │                      │
              │    memory.md         │
              │    (最终记忆)         │
              │    注入 System Prompt │
              │                      │
              └──────────────────────┘
```

### memory.md 最终格式

```markdown
## 重要事实
- 用户叫小明，是前端工程师
- 用户在做一个 React 项目
- 用户喜欢简洁的代码风格

## 今天
- 讨论了组件设计方案
- 帮用户修了一个 useEffect 的 bug

## 最近一周
- 周一：讨论了项目架构
- 周三：帮用户写了测试

## 长期情况
- 用户从去年开始学 React
- 用户的项目是一个电商平台
```

### 指纹缓存

每次编译前计算输入的 MD5 指纹，与上次比较。指纹未变则跳过编译，避免重复调用 LLM。

---

## deep-memory.js — 深度记忆

### 处理流程

```
1. getDirtySessions() — 找到 summary !== snapshot 的 session
2. 对每个脏 session：
   │
   ├── 有 snapshot（旧快照）
   │   └── 输入：旧快照 + 当前摘要 → 只提取新增/变化内容
   │
   └── 无 snapshot（首次处理）
       └── 输入：摘要内容 → 整体拆分
   │
   ▼
3. LLM 提取元事实
   │  输出：[{ fact, tags, time }]
   │
   ▼
4. factStore.addBatch() — 批量写入 facts.db
   │
   ▼
5. markProcessed() — 更新 snapshot = summary
```

### 元事实格式

```json
{
  "fact": "用户在做一个 React 电商项目",
  "tags": ["react", "电商", "项目", "前端"],
  "time": "2024-03-18T10:30"
}
```

### 提取规则

1. 每条事实原子化（一个事实只说一件事）
2. 标签 2-5 个，用于检索
3. time 从摘要时间标注提取
4. 不提取助手内心活动

### 并发控制

- 最多 3 个 session 并发处理
- 单 session 失败最多重试 3 次，超过则标记为已处理并跳过

---

## memory-search.js — 搜索工具

### 工具定义

```
名称: search_memory
参数:
  - query (必填): 搜索关键词
  - tags (可选): 标签数组
  - date_from (可选): 起始日期
  - date_to (可选): 结束日期
```

### 搜索策略

```
1. 有 tags → searchByTags()，最多 15 条
2. 标签结果少于 3 条且有 query → searchFullText() 补充，最多 10 条
3. 合并去重
4. 按 date_from / date_to 过滤
5. 格式化输出
```

### 输出格式

```
1. 用户在做一个 React 电商项目 (react, 电商, 项目) — 2024-03-18T10:30
2. 用户喜欢简洁的代码风格 (代码风格, 偏好) — 2024-03-15T14:00
```

---

## 记忆在 System Prompt 中的注入

记忆注入时附带严格的使用规则：

```
## 记忆使用规则

记忆和用户档案是你内化的背景知识。你和用户是认识很久的人，这些事你本来就知道。
你对用户的了解应该像空气一样，在场但不可见。记忆的存在感应该是零，它的作用应该是满的。

- 只有当用户提到了相关内容，记忆才参与进来。
- 永远不要让用户感觉到"记忆"这个东西的存在。禁止使用"我记得""你之前说过"等表述。
- 记忆可能过时，当前对话永远优先。
```

这段规则确保 Agent 不会机械地"背诵"记忆，而是自然地将记忆融入对话。
