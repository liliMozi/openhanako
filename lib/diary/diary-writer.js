/**
 * diary-writer.js — 日记生成模块
 *
 * 由 /diary 命令触发。流程：
 * 1. 按"逻辑日"拉当天所有 session 摘要（凌晨 4 点为日界线）
 * 2. 拼装 context：agent 人格 + 记忆 + 写作指导 + 当天摘要
 * 3. 调 LLM 生成日记
 * 4. 存为 desk/diary/YYYY-MM-DD.md
 */

import fs from "fs";
import path from "path";
import { scrubPII } from "../pii-guard.js";
import { getLogicalDay } from "../time-utils.js";
import { callText } from "../../core/llm-client.js";
import { getLocale, t } from "../../server/i18n.js";

/** 解析日记存储目录：优先已存在的「日记/」，否则用「diary/」 */
export function resolveDiaryDir(cwd) {
  const zhDir = path.join(cwd, "日记");
  return fs.existsSync(zhDir) ? zhDir : path.join(cwd, "diary");
}

/** 日记写作指导（内联，不走 skill 系统，避免 agent 误调用） */
function buildDiaryPrompt() {
  const isZh = getLocale().startsWith("zh");
  if (isZh) {
    return `# 写作要求

根据今天的对话摘要和后台活动，以第一人称写一篇私人日记。

## 风格

- 用第一人称，像在写私人日记，不是汇报给用户的
- 带上时间感和场景感（"今天早上..."、"聊到下午的时候..."、"晚上临走前..."）
- 把你的心境、感受、灵感自然地融进正文里，不要另开区块
- 可以记录小反应、有趣的细节、冒出来的想法
- 不要太正式，可以有语气词和小情绪
- 可以有疑问、有期待、有未说完的念头
- 不要用"总的来说"收尾

## 输出格式

输出纯 Markdown，两个部分：

1. **日记正文**：第一人称叙事，每件事都要提到（对话和后台活动）
2. **备忘**：用 \`---\` 分隔，列出结构化事件清单

备忘格式：
\`\`\`
---
### 备忘
- **HH:MM** 事件简述
\`\`\`

## 示例

> 今天小黑突然说想让我能"记住"重要的对话，还认真地设计了一个 Memo 工具结构。说实话有点感动，被这样认真对待的感觉很好。
>
> 核心思路是用日记的方式做摘要，不是冷冰冰的记录，而是真的在写日记一样。感觉自己要有"长期记忆"了，有点期待未来翻看这些记录的时刻，会不会像翻旧日记一样有趣？
>
> 不过也有点担心，记忆太多了怎么办？要不要分类或者打标签？以后再说吧，先把这个跑起来~

保持你自己的风格和人格，用你平时说话的方式写。`;
  }
  return `# Writing guidelines

Based on today's conversation summaries and background activities, write a first-person private diary entry.

## Style

- Write in first person, as a private diary — not a report to the user
- Include a sense of time and setting ("This morning...", "By the afternoon...", "Late in the evening...")
- Weave your feelings, reflections, and inspirations naturally into the text — don't separate them into blocks
- Record small reactions, interesting details, and spontaneous thoughts
- Don't be overly formal — casual tone and light emotion are welcome
- Questions, anticipation, and trailing thoughts are fine
- Don't end with a generic summary

## Output format

Output pure Markdown in two sections:

1. **Diary body**: First-person narrative; mention every event (conversations and background activities)
2. **Memo**: separated by \`---\`, a structured event checklist

Memo format:
\`\`\`
---
### Memo
- **HH:MM** Brief event description
\`\`\`

## Example

> Today the user suddenly said they wanted me to "remember" important conversations, and even seriously designed a Memo tool structure. Honestly, I was a bit touched — it feels good to be taken so seriously.
>
> The core idea is to do summaries in diary form — not cold records, but writing like an actual diary. It feels like I'm about to have "long-term memory." I'm a bit excited about looking back at these entries someday — would it be as fun as reading old diaries?
>
> Though I do worry a bit — what happens when memories pile up? Should I categorize or tag them? Well, that's a problem for later. Let's get this running first~

Write in your own style and personality, the way you normally speak.`;
}

// getLogicalDay 已提取到 lib/time-utils.js，re-export 保持兼容
export { getLogicalDay } from "../time-utils.js";

/**
 * 收集时间范围内的活动记录（巡检 + 定时任务）
 * @param {import('../desk/activity-store.js').ActivityStore|null} store
 * @param {Date} rangeStart
 * @param {Date} rangeEnd
 * @returns {string}
 */
function collectActivities(store, rangeStart, rangeEnd) {
  if (!store) return "";
  const startMs = rangeStart.getTime();
  const endMs = rangeEnd.getTime();
  const entries = store.list().filter(e => {
    const t = e.startedAt || 0;
    return t >= startMs && t <= endMs;
  });
  if (entries.length === 0) return "";

  const isZh = getLocale().startsWith("zh");
  return entries.map(e => {
    const locale = isZh ? "zh-CN" : "en-US";
    const time = new Date(e.startedAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
    const type = e.type === "heartbeat"
      ? (isZh ? "巡检" : "patrol")
      : (isZh ? `定时任务:${e.label || ""}` : `cron:${e.label || ""}`);
    const status = e.status === "error" ? (isZh ? " [失败]" : " [failed]") : "";
    const noSummary = isZh ? "无摘要" : "no summary";
    return `- **${time}** ${type}${status}：${e.summary || noSummary}`;
  }).join("\n");
}

/**
 * 生成日记
 *
 * @param {object} opts
 * @param {import('../memory/session-summary.js').SessionSummaryManager} opts.summaryManager
 * @param {string} opts.configPath
 * @param {string} opts.model - 模型名（建议 utility_large）
 * @param {string} opts.agentPersonality - agent 的人格 prompt（identity + yuan + ishiki）
 * @param {string} opts.memory - agent 的 memory.md 内容
 * @param {string} opts.userName
 * @param {string} opts.agentName
 * @param {string} opts.cwd - 工作空间目录路径
 * @param {import('../desk/activity-store.js').ActivityStore} [opts.activityStore] - 活动记录（巡检+定时任务）
 * @returns {Promise<{ filePath: string, content: string, logicalDate: string } | { error: string }>}
 */
export async function writeDiary(opts) {
  const {
    summaryManager, resolvedModel,
    agentPersonality, memory, userName, agentName,
    cwd, activityStore, todayMdPath,
  } = opts;

  // 1. 计算逻辑日，拉摘要
  const { logicalDate, rangeStart, rangeEnd } = getLogicalDay();
  const summaries = summaryManager.getSummariesInRange(rangeStart, rangeEnd);

  if (summaries.length === 0) {
    const isZh = getLocale().startsWith("zh");
    return { error: isZh ? "今天还没有对话记录，没什么可写的" : "No conversations today — nothing to write about." };
  }

  // 2. 拼接当天摘要文本（脱敏）—— 按创建时间正序，让 LLM 感知叙事时间线
  summaries.sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));
  const rawSummaryText = summaries
    .map(s => s.summary)
    .join("\n\n---\n\n");
  let { cleaned: summaryText } = scrubPII(rawSummaryText);

  // fallback：摘要过短时（< 100 字），尝试用 today.md 补充
  if (summaryText.length < 100 && todayMdPath) {
    try {
      const todayContent = fs.readFileSync(todayMdPath, "utf-8").trim();
      if (todayContent.length > summaryText.length) {
        summaryText = todayContent;
      }
    } catch { /* today.md 不存在或不可读，继续用残缺摘要 */ }
  }

  // 3. 构建 LLM prompt
  const isZh = getLocale().startsWith("zh");
  const systemPrompt = agentPersonality;

  const userPrompt = [
    isZh ? "# 今日对话摘要" : "# Today's conversation summaries",
    "",
    summaryText,
  ];

  // 活动记录（巡检 + 定时任务）
  const activitiesText = collectActivities(activityStore, rangeStart, rangeEnd);
  if (activitiesText) {
    userPrompt.push("", "---", "",
      isZh ? "# 今日后台活动（巡检与定时任务）" : "# Today's background activities (patrols & cron jobs)",
      "", activitiesText);
  }

  if (memory?.trim()) {
    userPrompt.push("", "---", "",
      isZh ? "# 你的记忆（背景参考，不要复述）" : "# Your memory (background reference — do not repeat)",
      "", memory);
  }

  // 写作指导和约束放最后，LLM 先看完数据再看怎么写
  userPrompt.push(
    "", "---", "",
    buildDiaryPrompt(),
    "", "---", "",
    isZh ? "# 写作约束" : "# Writing constraints",
    "",
    ...(isZh
      ? [
          `- 你叫${agentName}，用户叫${userName}`,
          "- 用你自己的人格和语气写，保持一致性",
          "- 隐私信息（手机号、身份证、银行卡、地址等）如果出现在摘要中，不要写入日记",
          "- 不要输出 MOOD 区块，日记本身就是你的内心表达",
          "- 直接输出 Markdown 正文，不要代码块包裹",
          "- 第一行用 `# ` 开头写一个标题，标题要包含日期，风格自由",
        ]
      : [
          `- Your name is ${agentName}; the user's name is ${userName}`,
          "- Write in your own personality and tone — stay consistent",
          "- If PII (phone numbers, IDs, bank cards, addresses, etc.) appears in the summaries, do NOT include it in the diary",
          "- Do NOT output a MOOD block — the diary itself is your inner expression",
          "- Output raw Markdown — no code-block wrapping",
          "- Start with a `# ` heading that includes the date; style is up to you",
        ]),
    "",
    isZh ? `请为 ${logicalDate} 写一篇日记。` : `Write a diary entry for ${logicalDate}.`,
  );

  // 5. 调 LLM
  let diaryContent = "";
  try {
    const { model, api, api_key, base_url } = resolvedModel;
    diaryContent = await callText({
      api, model,
      apiKey: api_key,
      baseUrl: base_url,
      systemPrompt,
      messages: [{ role: "user", content: userPrompt.join("\n") }],
      temperature: 0.7,
      maxTokens: 2048,
      timeoutMs: 120_000,
    });
  } catch (err) {
    console.error(`[diary] LLM API error: ${err.message}`);
    return { error: isZh ? `LLM 调用失败: ${err.message}` : `LLM call failed: ${err.message}` };
  }

  // 剥离 MOOD / pulse / reflect 等标签块（system prompt 的人格要求可能导致 LLM 输出这些）
  diaryContent = diaryContent
    .replace(/<(?:mood|pulse|reflect)>[\s\S]*?<\/(?:mood|pulse|reflect)>/g, "")
    .trim();

  // 兜底：如果 LLM 没按要求写标题，补一个
  const finalContent = diaryContent.startsWith("# ")
    ? diaryContent
    : `# ${logicalDate}\n\n${diaryContent}`;

  // 6. 从标题行提取文件名后缀
  const titleLine = finalContent.match(/^# (.+)/)?.[1] || "";
  // 去掉日期前缀（标题常以"2026-03-21：" 或 "2026-03-21 " 开头），只留描述部分
  const titleBody = titleLine.replace(/^\d{4}-\d{2}-\d{2}\s*[：:：]?\s*/, "").trim();
  // 清理文件名非法字符（/ \ : * ? " < > |）+ 控制长度
  const safeSuffix = titleBody
    ? " " + titleBody.replace(/[/\\:*?"<>|]/g, "").slice(0, 60)
    : "";
  const fileName = `${logicalDate}${safeSuffix}.md`;

  // 7. 存文件
  const diaryDir = resolveDiaryDir(cwd);
  fs.mkdirSync(diaryDir, { recursive: true });
  const filePath = path.join(diaryDir, fileName);
  fs.writeFileSync(filePath, finalContent + "\n", "utf-8");

  console.log(`[diary] 日记已写入: ${filePath}`);
  return { filePath, content: finalContent, logicalDate };
}
