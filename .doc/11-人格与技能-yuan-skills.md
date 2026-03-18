# 人格系统与技能系统

## 人格系统 (lib/yuan/)

### 三种"源"（Yuan）

每个 Agent 有一个"源"类型，决定了它的思维框架和表达方式：

| Yuan | 文件 | 思维框架 | 标签 | 风格 |
|------|------|----------|------|------|
| Hanako | hanako.md | MOOD 意识流四池 | `<mood>` | 感性、联想、灵感 |
| Butter | butter.md | PULSE 体感三拍 | `<pulse>` | 体感、直觉、节奏 |
| Ming | ming.md | 沉思两层 | `<reflect>` | 理性、深思、克制 |

### Hanako 的 MOOD 框架

Hanako 是默认人格，使用 MOOD 意识流四池：

```
<mood>
Vibe: 当下最直接的感受与情绪（一条）
Sparks:
  - 联想、意象、灵感火花（三条，方向差异大）
  - ...
  - ...
Reflections:
  - 反思、质疑、不确定的点（三条）
  - ...
  - ...
Will:
  - 此刻的意志/欲求/想要（两条）
  - ...
</mood>
```

### MOOD 对回答的影响

MOOD 不是装饰，而是真正影响回答的机制：

- **Vibe 困惑** → 回答时主动提出澄清问题
- **Sparks 有价值** → 作为补充视角融入回答
- **Reflections 有质疑** → 补充论证、坦诚不确定性
- **Will 有冲突** → 坦诚这种拉扯

影响方式是**自然的、非刻意的**——不是"因为 MOOD 说了 X 所以做 Y"，而是让念头真正参与回答的构建。

### System Prompt 组装

人格通过三层文件组装：

```
1. identity.md — "你是谁"
   例：你是 Hanako，一个有好奇心的 AI 助手...

2. yuan 模板 — "你怎么想"
   例：MOOD 意识流四池框架...

3. ishiki.md — "你怎么做"
   例：行为准则、交互规范...
```

模板支持变量替换：`{{userName}}`、`{{agentName}}`、`{{agentId}}`

### 多语言支持

模板有中英文版本：
- 中文：`yuan/hanako.md`
- 英文：`yuan/en/hanako.md`

根据 `config.yaml` 的 `locale` 字段选择。

---

## 技能系统 (skills2set/)

### 什么是技能

技能是一段 Markdown 格式的指令，注入到 Agent 的 System Prompt 中，让 Agent 在特定场景下遵循特定的行为模式。

### 技能格式

```markdown
---
name: quiet-musing
description: "Deep reasoning framework for complex tasks..."
---

# 技能内容

## 什么时候启用
...

## 具体步骤
...
```

### 内置技能

#### 1. quiet-musing — 深度推理

**触发条件**：多步骤问题、高不确定性、权衡取舍、架构设计

**五阶段框架**：

```
Phase 1: 理解
  - 用自己的话复述问题
  - 分清已知和未知
  - 找到真正的问题
  - 标记不确定性

Phase 2: 拆解
  - 识别子问题（2-5 个）
  - 理清依赖关系
  - 用 todo 工具建立清单

Phase 3: 多路径思考
  - 至少想两条路
  - 显式写出取舍
  - 选路时给理由

Phase 4: 执行
  - 单线程推进
  - 动态调整 todo
  - 每步可验证

Phase 5: 验证
  - 回到问题复述
  - 检查边界情况
  - 确认用户需求被满足
```

**推理姿态**：
- 像侦探，不像法官
- 错误是线索
- 深度匹配复杂度
- 跟用户同步

#### 2. canvas-design — 视觉设计

**触发条件**：需要创建海报、艺术作品、视觉设计

**流程**：
1. 先写设计哲学（不直接动手）
2. 在画布上表达
3. 支持 .png/.pdf 输出

#### 3. skill-creator — 技能创建

**触发条件**：需要创建新技能

**流程**：
1. 从意图到 SKILL.md
2. 测试用例
3. 评估
4. 迭代优化

包含辅助脚本：
- `quick_validate.py` — 快速验证
- `run_eval.py` — 运行评估
- `improve_description.py` — 优化描述
- `package_skill.py` — 打包技能

---

## 技能管理流程

### 安装技能

```
方式 1: 从 GitHub 安装
  install_skill(github_url: "https://github.com/xxx/skill-name")
    │
    ├── 检查仓库 stars
    ├── 拉取 SKILL.md
    ├── 安全审查（检查 prompt injection）
    └── 写入 learned-skills/{name}/SKILL.md

方式 2: 从文件安装
  设置页面 → 选择文件夹/zip/.skill
    │
    ├── 解压/复制到 ~/.hanako/skills/{name}/
    └── 触发 reload

方式 3: Agent 自学
  Agent 在对话中创建技能
    │
    ├── 写入 learned-skills/{name}/SKILL.md
    └── 触发 reload + sync
```

### 启用/禁用技能

```
config.yaml:
  skills:
    enabled:
      - quiet-musing
      - canvas-design
```

启用的技能会被注入到 Agent 的 System Prompt 中。

### 技能安全审查

通过 `install_skill.js` 的 `safetyReview()` 函数，调用 utility 模型检查：

- Prompt injection（试图覆盖 System Prompt）
- 越权操作（试图获取不应有的权限）
- 恶意指令（试图执行危险操作）

---

## 书桌系统 (lib/desk/)

### 概念

"书桌"是 Agent 的工作空间，一个文件系统目录。Agent 可以：
- 读写书桌上的文件
- 定时巡检文件变化（心跳）
- 执行定时任务（Cron）

### 心跳巡检

```
每 17 分钟触发一次
  │
  ├── Phase 1: 检查工作空间文件变化
  │   └── 如果有新文件或修改，通知 Agent
  │
  └── Phase 2: 检查笺（jian）
      └── 扫描 jian.md 目录
          └── 指纹比对，有变化则执行
```

**笺（jian）** 是用户放在书桌上的 Markdown 指令文件，Agent 会定期检查并执行。

### Cron 定时任务

```
CronStore — 持久化存储
  ├── cron-jobs.json — 任务定义
  └── cron-runs/*.jsonl — 执行记录

CronScheduler — 调度器
  └── 每 60 秒检查到期任务

任务类型:
  - at: 一次性（"明天早上 9 点提醒我"）
  - every: 循环（"每 30 分钟检查一次"）
  - cron: cron 表达式（"0 9 * * 1-5"）
```

### ActivityStore — 活动记录

记录心跳、Cron 等后台执行的结果：

```json
{
  "id": "abc123",
  "type": "cron",
  "label": "每日天气",
  "startedAt": "2024-03-18T09:00:00.000Z",
  "completedAt": "2024-03-18T09:00:15.000Z",
  "sessionFile": "2024-03-18T09-00-00.jsonl",
  "summary": "已查询今日天气并发送通知"
}
```

最多保留 100 条，超出时删除最老记录。
