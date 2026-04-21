/**
 * Markdown 渲染器
 *
 * 通过 npm import 使用 markdown-it，不依赖全局 window.markdownit。
 */

import markdownit from 'markdown-it';
import mk from '@traptitech/markdown-it-katex';
import taskLists from 'markdown-it-task-lists';
import 'katex/dist/katex.min.css';

type MarkdownIt = ReturnType<typeof markdownit>;

let _md: MarkdownIt | null = null;

/** 获取默认 md 实例（html: false, katex 插件） */
export function getMd(): MarkdownIt {
  if (_md) return _md;
  _md = markdownit({
    html: false,
    breaks: true,
    linkify: true,
    typographer: true,
  });
  _md.use(mk);
  _md.use(taskLists, { enabled: false, label: true });
  return _md;
}

const _cache = new Map<string, MarkdownIt>();

/** 获取自定义选项的 md 实例（缓存复用） */
export function getMdWithOpts(opts: Parameters<typeof markdownit>[0]): MarkdownIt {
  const key = JSON.stringify(opts);
  let inst = _cache.get(key);
  if (!inst) {
    inst = markdownit(opts);
    _cache.set(key, inst);
  }
  return inst;
}

export function renderMarkdown(src: string): string {
  return getMd().render(src);
}
