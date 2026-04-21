import { describe, expect, it } from 'vitest';
import { pathToFileUrl } from '../../../shared/path-to-file-url.cjs';

describe('pathToFileUrl', () => {
  it('empty string → empty', () => {
    expect(pathToFileUrl('')).toBe('');
  });

  it('non-string → empty', () => {
    expect(pathToFileUrl(null)).toBe('');
    expect(pathToFileUrl(undefined)).toBe('');
    expect(pathToFileUrl(42)).toBe('');
  });

  it('POSIX 简单路径', () => {
    expect(pathToFileUrl('/home/u/a.mp4')).toBe('file:///home/u/a.mp4');
  });

  it('POSIX 含空格 → 编码', () => {
    expect(pathToFileUrl('/a b/c.mp4')).toBe('file:///a%20b/c.mp4');
  });

  it('POSIX 含 # → 编码（避免被识别为 fragment）', () => {
    expect(pathToFileUrl('/a#b.mp4')).toBe('file:///a%23b.mp4');
  });

  it('POSIX 含 ? → 编码（避免被识别为 query）', () => {
    expect(pathToFileUrl('/a?b.mp4')).toBe('file:///a%3Fb.mp4');
  });

  it('Windows 盘符 + 反斜杠', () => {
    expect(pathToFileUrl('C:\\Users\\foo.mp4')).toBe('file:///C:/Users/foo.mp4');
  });

  it('Windows 盘符 + 空格', () => {
    expect(pathToFileUrl('C:\\Users\\foo bar.mp4')).toBe('file:///C:/Users/foo%20bar.mp4');
  });

  it('Windows 盘符（小写）', () => {
    expect(pathToFileUrl('d:\\tmp\\a.mp4')).toBe('file:///d:/tmp/a.mp4');
  });

  it('Windows UNC 路径 → file://host/share/...（RFC 8089）', () => {
    expect(pathToFileUrl('\\\\server\\share\\a.mp4')).toBe('file://server/share/a.mp4');
  });

  it('Windows UNC 含空格', () => {
    expect(pathToFileUrl('\\\\srv\\share\\a b.mp4')).toBe('file://srv/share/a%20b.mp4');
  });

  it('保留 /，不被重复编码', () => {
    // encodeURI 不会对 / 编码
    expect(pathToFileUrl('/deep/nested/path/file.png')).toBe('file:///deep/nested/path/file.png');
  });
});
