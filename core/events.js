/**
 * MoodParser — 从 streaming text 中解析内省标签
 *
 * 支持三种标签（对应三个 yuan 的思维框架）：
 *   <mood></mood>       — Hanako（MOOD 意识流四池）
 *   <pulse></pulse>     — Butter（PULSE 体感三拍）
 *   <reflect></reflect> — Ming（沉思两层）
 *
 * 无论哪种标签，都输出统一的事件流：
 *   mood_start / mood_text / mood_end
 *
 * 用法：
 *   const parser = new MoodParser();
 *   parser.feed(delta, (evt) => {
 *     // evt: { type: 'text', data } | { type: 'mood_start' } | { type: 'mood_text', data } | { type: 'mood_end' }
 *   });
 */

const TAGS = ["mood", "pulse", "reflect"];

/** 检查 buffer 末尾是否是 target 的前缀（1..target.length-1 个字符），返回匹配长度 */
function trailingPrefixLen(buffer, target) {
  const maxCheck = Math.min(buffer.length, target.length - 1);
  for (let len = maxCheck; len >= 1; len--) {
    if (buffer.endsWith(target.slice(0, len))) return len;
  }
  return 0;
}

export class MoodParser {
  constructor() {
    this.inMood = false;
    this.buffer = "";
    this._justEndedMood = false;
    this._currentTag = null; // 当前打开的标签名
  }

  /**
   * 喂入一段 streaming delta 文本，通过 emit 回调输出解析后的事件
   * @param {string} delta
   * @param {(evt: {type: string, data?: string}) => void} emit
   */
  feed(delta, emit) {
    this.buffer += delta;
    this._drain(emit);
  }

  /** 强制输出 buffer 中剩余内容 */
  flush(emit) {
    if (this.buffer) {
      if (this.inMood) {
        emit({ type: "mood_text", data: this.buffer });
      } else {
        emit({ type: "text", data: this.buffer });
      }
      this.buffer = "";
    }
    if (this.inMood) {
      emit({ type: "mood_end" });
      this.inMood = false;
      this._currentTag = null;
    }
  }

  reset() {
    this.inMood = false;
    this.buffer = "";
    this._justEndedMood = false;
    this._currentTag = null;
  }

  _trailingPrefixLen(buffer, target) {
    return trailingPrefixLen(buffer, target);
  }

  /**
   * 在 buffer 中查找最早出现的开始标签
   * @returns {{ tag: string, idx: number, openTag: string } | null}
   */
  _findOpenTag() {
    let best = null;
    for (const tag of TAGS) {
      const openTag = `<${tag}>`;
      const idx = this.buffer.indexOf(openTag);
      if (idx !== -1 && (best === null || idx < best.idx)) {
        best = { tag, idx, openTag };
      }
    }
    return best;
  }

  /**
   * 计算所有开始标签在 buffer 末尾的最大前缀匹配长度
   */
  _maxTrailingPrefix() {
    let max = 0;
    for (const tag of TAGS) {
      const len = trailingPrefixLen(this.buffer, `<${tag}>`);
      if (len > max) max = len;
    }
    return max;
  }

  /** 内部：尽可能多地从 buffer 中提取完整事件 */
  _drain(emit) {
    while (this.buffer.length > 0) {
      // mood 刚结束时，裁掉前导换行
      if (this._justEndedMood && !this.inMood) {
        this.buffer = this.buffer.replace(/^\n+/, "");
        this._justEndedMood = false;
        if (!this.buffer.length) break;
      }

      if (!this.inMood) {
        // 寻找任意开始标签
        const found = this._findOpenTag();
        if (found) {
          const before = this.buffer.slice(0, found.idx);
          if (before) emit({ type: "text", data: before });
          emit({ type: "mood_start" });
          this.inMood = true;
          this._currentTag = found.tag;
          this.buffer = this.buffer.slice(found.idx + found.openTag.length);
          continue;
        }
        // buffer 末尾可能是某个开始标签的前缀
        const holdLen = this._maxTrailingPrefix();
        if (holdLen > 0) {
          const safe = this.buffer.slice(0, -holdLen);
          if (safe) emit({ type: "text", data: safe });
          this.buffer = this.buffer.slice(-holdLen);
          break;
        }
        emit({ type: "text", data: this.buffer });
        this.buffer = "";
      } else {
        // 寻找对应的关闭标签
        const closeTag = `</${this._currentTag}>`;
        const idx = this.buffer.indexOf(closeTag);
        if (idx !== -1) {
          const content = this.buffer.slice(0, idx);
          if (content) emit({ type: "mood_text", data: content });
          emit({ type: "mood_end" });
          this.inMood = false;
          this._justEndedMood = true;
          this.buffer = this.buffer.slice(idx + closeTag.length);
          this._currentTag = null;
          continue;
        }
        // buffer 末尾可能是关闭标签的前缀
        const moodHoldLen = trailingPrefixLen(this.buffer, closeTag);
        if (moodHoldLen > 0) {
          const safe = this.buffer.slice(0, -moodHoldLen);
          if (safe) emit({ type: "mood_text", data: safe });
          this.buffer = this.buffer.slice(-moodHoldLen);
          break;
        }
        emit({ type: "mood_text", data: this.buffer });
        this.buffer = "";
      }
    }
  }
}

/**
 * ThinkTagParser — 拦截 <think>/<thinking> 标签（DeepSeek / Qwen / Kimi 等模型的文本内思考格式）
 *
 * 链在 MoodParser 之前（最外层），输出事件流：
 *   think_start / think_text { data } / think_end
 *   text { data } — 非 think 内容透传
 *
 * 支持标签变体：<think>...</think> 和 <thinking>...</thinking>
 */
const THINK_TAGS = ["think", "thinking"];

export class ThinkTagParser {
  constructor() {
    this.inThink = false;
    this.buffer = "";
    this._justEnded = false;
    this._currentTag = null;
  }

  feed(delta, emit) {
    this.buffer += delta;
    this._drain(emit);
  }

  flush(emit) {
    if (this.buffer) {
      emit({ type: this.inThink ? "think_text" : "text", data: this.buffer });
      this.buffer = "";
    }
    if (this.inThink) {
      emit({ type: "think_end" });
      this.inThink = false;
      this._currentTag = null;
    }
  }

  reset() {
    this.inThink = false;
    this.buffer = "";
    this._justEnded = false;
    this._currentTag = null;
  }

  _findOpenTag() {
    let best = null;
    for (const tag of THINK_TAGS) {
      const openTag = `<${tag}>`;
      const idx = this.buffer.indexOf(openTag);
      if (idx !== -1 && (best === null || idx < best.idx)) {
        best = { tag, idx, openTag };
      }
    }
    return best;
  }

  _maxTrailingPrefix() {
    let max = 0;
    for (const tag of THINK_TAGS) {
      const len = trailingPrefixLen(this.buffer, `<${tag}>`);
      if (len > max) max = len;
    }
    return max;
  }

  _drain(emit) {
    while (this.buffer.length > 0) {
      // think 刚结束时裁掉前导换行
      if (this._justEnded && !this.inThink) {
        this.buffer = this.buffer.replace(/^\n+/, "");
        this._justEnded = false;
        if (!this.buffer.length) break;
      }

      if (!this.inThink) {
        const found = this._findOpenTag();
        if (found) {
          const before = this.buffer.slice(0, found.idx);
          if (before) emit({ type: "text", data: before });
          emit({ type: "think_start" });
          this.inThink = true;
          this._currentTag = found.tag;
          this.buffer = this.buffer.slice(found.idx + found.openTag.length);
          continue;
        }
        // buffer 末尾可能是某个开始标签的前缀
        const holdLen = this._maxTrailingPrefix();
        if (holdLen > 0) {
          const safe = this.buffer.slice(0, -holdLen);
          if (safe) emit({ type: "text", data: safe });
          this.buffer = this.buffer.slice(-holdLen);
          break;
        }
        emit({ type: "text", data: this.buffer });
        this.buffer = "";
      } else {
        const closeTag = `</${this._currentTag}>`;
        const idx = this.buffer.indexOf(closeTag);
        if (idx !== -1) {
          const content = this.buffer.slice(0, idx);
          if (content) emit({ type: "think_text", data: content });
          emit({ type: "think_end" });
          this.inThink = false;
          this._justEnded = true;
          this._currentTag = null;
          this.buffer = this.buffer.slice(idx + closeTag.length);
          continue;
        }
        const holdLen = trailingPrefixLen(this.buffer, closeTag);
        if (holdLen > 0) {
          const safe = this.buffer.slice(0, -holdLen);
          if (safe) emit({ type: "think_text", data: safe });
          this.buffer = this.buffer.slice(-holdLen);
          break;
        }
        emit({ type: "think_text", data: this.buffer });
        this.buffer = "";
      }
    }
  }
}

/**
 * CardParser — 从 streaming text 中解析 <card ...>...</card> 标签
 *
 * 链在 MoodParser 的 text 输出之后，输出事件流：
 *   card_start { attrs: { type?, plugin, route, title? } }
 *   card_text { data }
 *   card_end
 *   text { data } — 非 card 内容透传
 */
const CARD_ATTR_RE = /(\w+)="([^"]*)"/g;

export class CardParser {
  constructor() {
    this.inCard = false;
    this.buffer = "";
    this._attrs = null;
  }

  feed(delta, emit) {
    this.buffer += delta;
    this._drain(emit);
  }

  flush(emit) {
    if (this.buffer) {
      if (this.inCard) {
        emit({ type: "card_text", data: this.buffer });
      } else {
        emit({ type: "text", data: this.buffer });
      }
      this.buffer = "";
    }
    if (this.inCard) {
      emit({ type: "card_end" });
      this.inCard = false;
      this._attrs = null;
    }
  }

  reset() {
    this.inCard = false;
    this.buffer = "";
    this._attrs = null;
  }

  _parseAttrs(tag) {
    const attrs = {};
    let m;
    CARD_ATTR_RE.lastIndex = 0;
    while ((m = CARD_ATTR_RE.exec(tag)) !== null) {
      attrs[m[1]] = m[2];
    }
    return attrs;
  }

  _findCardOpen() {
    // Find <card followed by space or > (word boundary — excludes <cardiac etc.)
    let searchFrom = 0;
    while (searchFrom < this.buffer.length) {
      const idx = this.buffer.indexOf("<card", searchFrom);
      if (idx === -1) return -1;
      const after = this.buffer[idx + 5];
      if (after === undefined || after === " " || after === ">" || after === "\n" || after === "\t") return idx;
      searchFrom = idx + 1;
    }
    return -1;
  }

  _drain(emit) {
    while (this.buffer.length > 0) {
      if (!this.inCard) {
        // Look for complete opening tag <card ... > (with word boundary)
        const openIdx = this._findCardOpen();
        if (openIdx !== -1) {
          // Check if the full opening tag is present (find closing >)
          const closeAngle = this.buffer.indexOf(">", openIdx);
          if (closeAngle !== -1) {
            const before = this.buffer.slice(0, openIdx);
            if (before) emit({ type: "text", data: before });
            const openTag = this.buffer.slice(openIdx, closeAngle + 1);
            this._attrs = this._parseAttrs(openTag);
            emit({ type: "card_start", attrs: this._attrs });
            this.inCard = true;
            this.buffer = this.buffer.slice(closeAngle + 1);
            continue;
          }
          // Have <card but no > yet — hold from <card onward
          const before = this.buffer.slice(0, openIdx);
          if (before) emit({ type: "text", data: before });
          this.buffer = this.buffer.slice(openIdx);
          break;
        }
        // Check trailing prefix for partial <card
        const holdLen = trailingPrefixLen(this.buffer, "<card");
        if (holdLen > 0) {
          const safe = this.buffer.slice(0, -holdLen);
          if (safe) emit({ type: "text", data: safe });
          this.buffer = this.buffer.slice(-holdLen);
          break;
        }
        emit({ type: "text", data: this.buffer });
        this.buffer = "";
      } else {
        // Inside card — look for </card>
        const closeTag = "</card>";
        const idx = this.buffer.indexOf(closeTag);
        if (idx !== -1) {
          const content = this.buffer.slice(0, idx);
          if (content) emit({ type: "card_text", data: content });
          emit({ type: "card_end" });
          this.inCard = false;
          this._attrs = null;
          this.buffer = this.buffer.slice(idx + closeTag.length);
          continue;
        }
        const holdLen = trailingPrefixLen(this.buffer, closeTag);
        if (holdLen > 0) {
          const safe = this.buffer.slice(0, -holdLen);
          if (safe) emit({ type: "card_text", data: safe });
          this.buffer = this.buffer.slice(-holdLen);
          break;
        }
        emit({ type: "card_text", data: this.buffer });
        this.buffer = "";
      }
    }
  }
}
