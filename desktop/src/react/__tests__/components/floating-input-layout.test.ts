import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = fs.readFileSync(
  path.join(process.cwd(), 'desktop/src/react/components/floating-input/FloatingInput.module.css'),
  'utf8',
);

function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`))?.groups?.body || '';
}

describe('floating input layout', () => {
  it('keeps single-line text optically centered and gives the left edge chat-input breathing room', () => {
    const form = block('.floating-input-form');
    const input = block('.floating-input-box');

    expect(form).toMatch(/align-items:\s*center/);
    expect(form).toMatch(/border-radius:\s*var\(--radius-md\)/);
    expect(form).toMatch(/padding:\s*var\(--space-sm\)\s+var\(--space-sm\)\s+var\(--space-sm\)\s+var\(--space-md\)/);
    expect(input).toMatch(/line-height:\s*1\.45/);
  });
});
