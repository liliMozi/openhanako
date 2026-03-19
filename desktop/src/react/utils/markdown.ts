/**
 * Markdown 渲染器
 *
 * 包装全局 markdown-it 实例（由 lib/markdown-it.min.js 提供 window.markdownit）。
 * 此处独立创建并管理 md 实例。
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
