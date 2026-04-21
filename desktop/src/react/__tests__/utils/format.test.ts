import { describe, it, expect, beforeEach, vi } from 'vitest';
import { toSlash, baseName, parseCSV, isImageFile, parseMoodFromContent } from '../../utils/format';

describe('toSlash', () => {
  it('反斜杠转正斜杠', () => {
    expect(toSlash('C:\\Users\\test\\file.txt')).toBe('C:/Users/test/file.txt');
  });

  it('已是正斜杠不变', () => {
    expect(toSlash('/usr/local/bin')).toBe('/usr/local/bin');
  });

  it('空字符串返回空', () => {
    expect(toSlash('')).toBe('');
  });
});

describe('baseName', () => {
  it('提取文件名（正斜杠）', () => {
    expect(baseName('/path/to/file.txt')).toBe('file.txt');
  });

  it('提取文件名（反斜杠）', () => {
    expect(baseName('C:\\path\\to\\file.txt')).toBe('file.txt');
  });

  it('无路径分隔符返回原文', () => {
    expect(baseName('file.txt')).toBe('file.txt');
  });
});

describe('parseCSV', () => {
  it('解析简单 CSV', () => {
    const result = parseCSV('a,b,c\n1,2,3');
    expect(result).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });

  it('处理带引号的字段', () => {
    const result = parseCSV('"hello, world",b\n1,2');
    expect(result[0][0]).toBe('hello, world');
  });

  it('处理引号内的转义引号', () => {
    const result = parseCSV('"say ""hi""",b');
    expect(result[0][0]).toBe('say "hi"');
  });

  it('空输入返回空数组', () => {
    expect(parseCSV('')).toEqual([]);
  });

  it('跳过空行', () => {
    const result = parseCSV('a,b\n\nc,d');
    expect(result).toEqual([['a', 'b'], ['c', 'd']]);
  });
});

describe('isImageFile', () => {
  it('常见图片格式返回 true', () => {
    expect(isImageFile('photo.png')).toBe(true);
    expect(isImageFile('photo.jpg')).toBe(true);
    expect(isImageFile('photo.jpeg')).toBe(true);
    expect(isImageFile('photo.gif')).toBe(true);
    expect(isImageFile('photo.webp')).toBe(true);
    expect(isImageFile('photo.svg')).toBe(true);
  });

  it('非图片格式返回 false', () => {
    expect(isImageFile('doc.pdf')).toBe(false);
    expect(isImageFile('code.ts')).toBe(false);
    expect(isImageFile('data.json')).toBe(false);
  });

  it('大小写不敏感', () => {
    expect(isImageFile('PHOTO.PNG')).toBe(true);
    expect(isImageFile('Photo.Jpg')).toBe(true);
  });
});

describe('parseMoodFromContent (format.ts)', () => {
  it('解析 mood 标签', () => {
    const result = parseMoodFromContent('<mood>content</mood>\nText.');
    expect(result.mood).toBe('content');
    expect(result.text).toBe('Text.');
  });

  it('无 mood 标签', () => {
    const result = parseMoodFromContent('plain text');
    expect(result.mood).toBeNull();
    expect(result.text).toBe('plain text');
  });
});
