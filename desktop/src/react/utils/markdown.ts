/**
 * Markdown 渲染器
 *
 * 包装全局 markdown-it 实例。Phase 1 直接复用 app.js 配置好的 window.markdownit，
 * Phase 3 迁移 chat-render 时会把 md 实例收归此处独立管理。
 */

interface MarkdownIt {
  render(src: string): string;
  core: { ruler: { after: (name: string, ruleName: string, fn: (state: unknown) => void) => void } };
}

let _md: MarkdownIt | null = null;

export function getMd(): MarkdownIt {
  if (_md) return _md;
  _md = window.markdownit({
    html: false,
    breaks: true,
    linkify: true,
    typographer: true,
  });
  return _md;
}

export function renderMarkdown(src: string): string {
  return getMd().render(src);
}
