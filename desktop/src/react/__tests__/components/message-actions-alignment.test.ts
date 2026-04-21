import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('message actions alignment', () => {
  it('UserMessage 把操作按钮组显式放到左侧', () => {
    const userSource = read('components/chat/UserMessage.tsx');

    expect(userSource).toMatch(/<MessageActions[\s\S]*align="left"/);
  });

  it('MessageActions 支持 left 对齐变体', () => {
    const actionsSource = read('components/chat/MessageActions.tsx');
    const styleSource = read('components/chat/Chat.module.css');

    expect(actionsSource).toMatch(/align\?:\s*'left'\s*\|\s*'right'/);
    expect(actionsSource).toMatch(/styles\.msgActionsLeft/);
    expect(styleSource).toMatch(/\.msgActionsLeft\s*\{/);
    expect(styleSource).toMatch(/left:\s*4px;/);
  });
});
