import { describe, expect, it } from 'vitest';
import { inferKindByExt, isMediaKind, EXT_TO_KIND, buildFileRefId } from '../../utils/file-kind';

describe('inferKindByExt', () => {
  it.each([
    ['png', 'image'], ['jpg', 'image'], ['jpeg', 'image'],
    ['gif', 'image'], ['webp', 'image'], ['bmp', 'image'], ['avif', 'image'],
    ['svg', 'svg'],
    ['mp4', 'video'], ['webm', 'video'], ['mov', 'video'], ['m4v', 'video'], ['mkv', 'video'],
    ['mp3', 'audio'], ['wav', 'audio'], ['ogg', 'audio'], ['flac', 'audio'], ['m4a', 'audio'],
    ['pdf', 'pdf'],
    ['docx', 'doc'], ['xlsx', 'doc'], ['xls', 'doc'],
    ['md', 'markdown'], ['markdown', 'markdown'],
    ['js', 'code'], ['ts', 'code'], ['py', 'code'], ['json', 'code'],
    ['html', 'code'], ['csv', 'code'],
  ])('ext %s → kind %s', (ext, kind) => {
    expect(inferKindByExt(ext)).toBe(kind);
  });

  it('大小写混合应正常识别', () => {
    expect(inferKindByExt('PNG')).toBe('image');
    expect(inferKindByExt('Mp4')).toBe('video');
  });

  it('未知/空值 → other', () => {
    expect(inferKindByExt('xyz')).toBe('other');
    expect(inferKindByExt('')).toBe('other');
    expect(inferKindByExt(undefined)).toBe('other');
  });
});

describe('isMediaKind', () => {
  it('image / svg / video → true', () => {
    expect(isMediaKind('image')).toBe(true);
    expect(isMediaKind('svg')).toBe(true);
    expect(isMediaKind('video')).toBe(true);
  });

  it('audio / pdf / doc / code / markdown / other → false', () => {
    expect(isMediaKind('audio')).toBe(false);
    expect(isMediaKind('pdf')).toBe(false);
    expect(isMediaKind('doc')).toBe(false);
    expect(isMediaKind('code')).toBe(false);
    expect(isMediaKind('markdown')).toBe(false);
    expect(isMediaKind('other')).toBe(false);
  });
});

describe('buildFileRefId', () => {
  it('desk 源：desk:<path>', () => {
    expect(buildFileRefId({ source: 'desk', path: '/home/u/a.png' }))
      .toBe('desk:/home/u/a.png');
  });

  it('session-attachment 源：sess:<sessionPath>:<messageId>:att:<path>', () => {
    expect(buildFileRefId({
      source: 'session-attachment',
      sessionPath: '/s/1',
      messageId: 'm1',
      path: '/u/pic.png',
    })).toBe('sess:/s/1:m1:att:/u/pic.png');
  });

  it('session-block-file 源：sess:<sessionPath>:<messageId>:block:<blockIdx>:<path>', () => {
    expect(buildFileRefId({
      source: 'session-block-file',
      sessionPath: '/s/1',
      messageId: 'm2',
      blockIdx: 3,
      path: '/out/diagram.svg',
    })).toBe('sess:/s/1:m2:block:3:/out/diagram.svg');
  });

  it('session-block-screenshot 源：path 忽略（为空也 OK）', () => {
    expect(buildFileRefId({
      source: 'session-block-screenshot',
      sessionPath: '/s/1',
      messageId: 'm3',
      blockIdx: 0,
      path: '',
    })).toBe('sess:/s/1:m3:block:0:screenshot');
  });

  it('selector 与调用方用同一函数生成的 id 必须一致', () => {
    const parts = {
      source: 'session-attachment' as const,
      sessionPath: '/x', messageId: 'mid', path: '/p.png',
    };
    // 同样参数调两次 → 相同 id
    expect(buildFileRefId(parts)).toBe(buildFileRefId(parts));
  });
});
