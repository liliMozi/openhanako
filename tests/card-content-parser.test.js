import { describe, it, expect } from 'vitest';
import { parseCardFromContent } from '../desktop/src/react/utils/message-parser.ts';

describe('parseCardFromContent', () => {
  it('returns empty for text without cards', () => {
    const result = parseCardFromContent('Hello world');
    expect(result.cards).toEqual([]);
    expect(result.text).toBe('Hello world');
  });

  it('extracts a single card', () => {
    const input = 'Before\n<card type="iframe" plugin="fm" route="/k?s=1" title="T">desc text</card>\nAfter';
    const result = parseCardFromContent(input);
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]).toEqual({
      type: 'iframe',
      pluginId: 'fm',
      route: '/k?s=1',
      title: 'T',
      description: 'desc text',
    });
    expect(result.text).toBe('Before\n\nAfter');
  });

  it('extracts multiple cards', () => {
    const input = '<card plugin="a" route="/1">d1</card> mid <card plugin="b" route="/2">d2</card>';
    const result = parseCardFromContent(input);
    expect(result.cards).toHaveLength(2);
    expect(result.cards[0].pluginId).toBe('a');
    expect(result.cards[1].pluginId).toBe('b');
  });

  it('defaults type to iframe when missing', () => {
    const input = '<card plugin="fm" route="/r">d</card>';
    const result = parseCardFromContent(input);
    expect(result.cards[0].type).toBe('iframe');
  });

  it('handles route with special chars', () => {
    const input = '<card plugin="fm" route="/k?symbol=sh600519&period=daily">d</card>';
    const result = parseCardFromContent(input);
    expect(result.cards[0].route).toBe('/k?symbol=sh600519&period=daily');
  });

  it('handles empty/null input', () => {
    expect(parseCardFromContent('').cards).toEqual([]);
    expect(parseCardFromContent(null).cards).toEqual([]);
  });

  it('trims remaining text', () => {
    const input = '\n<card plugin="fm" route="/r">d</card>\n';
    const result = parseCardFromContent(input);
    expect(result.text).toBe('');
    expect(result.cards).toHaveLength(1);
  });
});
