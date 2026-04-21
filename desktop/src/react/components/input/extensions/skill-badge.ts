import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { SkillBadgeView } from '../SkillBadgeView';

export const SkillBadge = Node.create({
  name: 'skillBadge',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      name: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-skill]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, {
      class: 'skill-badge',
      'data-skill': HTMLAttributes.name,
    })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(SkillBadgeView);
  },
});
