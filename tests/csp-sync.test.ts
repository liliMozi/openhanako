import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * CSP 双源同步检查：
 * 确保 vite.config.ts 中的 CSP_PROFILES 与 HTML 源文件中的 meta tag 保持一致。
 * 如果测试失败，说明有人改了 CSP_PROFILES 但忘了同步 HTML 源文件（或反之）。
 */

// 从 vite.config.ts 源码中提取 CSP_PROFILES（不 import，避免引入 Vite 依赖）
function extractCspProfiles(): Record<string, string> {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'vite.config.ts'), 'utf-8');
  const profiles: Record<string, string> = {};

  // 匹配 'filename.html': "csp-value" 或 'filename.html':\n    "csp-value"
  const re = /'([^']+\.html)':\s*\n?\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    profiles[m[1]] = m[2];
  }
  return profiles;
}

// 从 HTML 文件中提取 CSP content 属性值
function extractHtmlCsp(htmlPath: string): string | null {
  const html = fs.readFileSync(htmlPath, 'utf-8');
  const m = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/s);
  return m ? m[1] : null;
}

// 标准化 CSP：去除末尾分号，排序指令
function normalizeCsp(csp: string): string {
  return csp
    .split(';')
    .map(d => d.trim())
    .filter(Boolean)
    .sort()
    .join('; ');
}

describe('CSP sync', () => {
  const profiles = extractCspProfiles();
  const htmlDir = path.resolve(__dirname, '..', 'desktop', 'src');

  it('should have extracted all 6 profiles', () => {
    expect(Object.keys(profiles)).toHaveLength(6);
  });

  for (const [filename, profileCsp] of Object.entries(profiles)) {
    it(`${filename}: HTML source matches CSP_PROFILES`, () => {
      const htmlPath = path.join(htmlDir, filename);
      const htmlCsp = extractHtmlCsp(htmlPath);
      expect(htmlCsp).not.toBeNull();
      expect(normalizeCsp(htmlCsp!)).toBe(normalizeCsp(profileCsp));
    });
  }
});
