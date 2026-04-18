import type { JSONContent } from '@tiptap/core';

/**
 * Walk TipTap JSON document, extract skill badge names and plain text.
 */
export function serializeEditor(json: JSONContent): { text: string; skills: string[] } {
  const skills: string[] = [];
  const textParts: string[] = [];

  function walk(node: JSONContent) {
    if (node.type === 'skillBadge' && node.attrs?.name) {
      skills.push(node.attrs.name as string);
      return;
    }
    if (node.type === 'text' && node.text) {
      textParts.push(node.text);
      return;
    }
    if (node.type === 'hardBreak') {
      textParts.push('\n');
      return;
    }
    if (node.content) {
      for (const child of node.content) walk(child);
    }
    if (node.type === 'paragraph' && textParts.length > 0) {
      textParts.push('\n');
    }
  }

  walk(json);

  const text = textParts.join('').replace(/\n+$/, '').trim();

  return { text, skills };
}
