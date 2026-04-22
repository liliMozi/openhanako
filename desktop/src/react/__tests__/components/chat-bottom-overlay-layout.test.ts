import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('chat bottom overlay layout', () => {
  it('session panel cuts off at input card midline while preserving the input area bottom inset', () => {
    const styleSource = read('components/chat/Chat.module.css');

    expect(styleSource).toMatch(
      /\.sessionPanel\s*\{[\s\S]*bottom:\s*calc\(var\(--input-card-h,\s*0px\)\s*\/\s*2\s*\+\s*var\(--space-lg\)\);/,
    );
  });

  it('session footer leaves one extra line of breathing room above the input top edge', () => {
    const styleSource = read('components/chat/Chat.module.css');

    expect(styleSource).toMatch(
      /\.sessionFooter\s*\{[\s\S]*height:\s*calc\(var\(--input-card-h,\s*0px\)\s*\/\s*2\s*\+\s*var\(--space-lg\)\s*\+\s*8rem\);/,
    );
  });

  it('measures the stable input card instead of the whole input area container', () => {
    const appSource = read('App.tsx');
    const inputSource = read('components/InputArea.tsx');

    expect(appSource).toContain("parent.style.setProperty('--input-card-h'");
    expect(appSource).toContain('<InputArea key={currentSessionPath || \'__new\'} cardRef={inputCardRef} />');
    expect(inputSource).toContain("<div className={styles['input-wrapper']} ref={cardRef}>");
  });
});
