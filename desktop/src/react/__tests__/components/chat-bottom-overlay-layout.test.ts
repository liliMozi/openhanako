import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('chat bottom overlay layout', () => {
  it('session panel stays pinned to the bottom edge', () => {
    const styleSource = read('components/chat/Chat.module.css');

    expect(styleSource).toMatch(/\.sessionPanel\s*\{[\s\S]*bottom:\s*0;/);
  });

  it('session footer uses input height as transparent scroll padding', () => {
    const styleSource = read('components/chat/Chat.module.css');

    expect(styleSource).toMatch(
      /\.sessionFooter\s*\{[\s\S]*height:\s*max\(12rem,\s*calc\(var\(--input-area-h,\s*0px\)\s*\+\s*2rem\)\);/,
    );
  });
});
