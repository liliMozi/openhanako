import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('preview artifact fallback', () => {
  it('PreviewPanel 通过共享 selector 读取 artifact，支持无 session 的 Desk 预览', () => {
    const source = read('components/PreviewPanel.tsx');

    expect(source).toMatch(/selectArtifacts/);
    expect(source).not.toMatch(/currentSessionPath\s*\?\s*\(s\.artifactsBySession\[s\.currentSessionPath\][\s\S]*:\s*EMPTY_ARTIFACTS/);
  });

  it('TabBar 通过共享 selector 解析 tab 标题，避免回退到 file-* id', () => {
    const source = read('components/preview/TabBar.tsx');

    expect(source).toMatch(/selectArtifacts/);
    expect(source).not.toMatch(/currentSessionPath\s*\?\s*\(s\.artifactsBySession\[s\.currentSessionPath\][\s\S]*:\s*EMPTY_ARTIFACTS/);
  });

  it('InputArea 的当前文档推导也复用同一份 artifact 选择逻辑', () => {
    const source = read('components/InputArea.tsx');

    expect(source).toMatch(/selectArtifacts/);
    expect(source).not.toMatch(/currentSessionPath\s*\?\s*\(s\.artifactsBySession\[s\.currentSessionPath\][\s\S]*:\s*EMPTY_ARTIFACTS/);
  });
});
