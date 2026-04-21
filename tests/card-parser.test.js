import { describe, it, expect } from 'vitest';
import { CardParser } from '../core/events.js';

function collect(parser, input) {
  const events = [];
  if (typeof input === 'string') {
    parser.feed(input, (e) => events.push(e));
  } else {
    for (const chunk of input) {
      parser.feed(chunk, (e) => events.push(e));
    }
  }
  parser.flush((e) => events.push(e));
  return events;
}

describe('CardParser', () => {
  it('passes plain text through', () => {
    const p = new CardParser();
    const evts = collect(p, 'Hello world');
    expect(evts).toEqual([{ type: 'text', data: 'Hello world' }]);
  });

  it('parses a complete card tag', () => {
    const p = new CardParser();
    const evts = collect(p, 'Before <card type="iframe" plugin="fm" route="/k?s=1" title="T">desc</card> After');
    expect(evts[0]).toEqual({ type: 'text', data: 'Before ' });
    expect(evts[1]).toEqual({ type: 'card_start', attrs: { type: 'iframe', plugin: 'fm', route: '/k?s=1', title: 'T' } });
    expect(evts[2]).toEqual({ type: 'card_text', data: 'desc' });
    expect(evts[3]).toEqual({ type: 'card_end' });
    expect(evts[4]).toEqual({ type: 'text', data: ' After' });
  });

  it('handles streaming chunks across tag boundary', () => {
    const p = new CardParser();
    const evts = collect(p, ['text <ca', 'rd type="iframe" plugin="x" route="/r">', 'body', '</car', 'd> end']);
    const types = evts.map(e => e.type);
    expect(types).toContain('card_start');
    expect(types).toContain('card_text');
    expect(types).toContain('card_end');
    const start = evts.find(e => e.type === 'card_start');
    expect(start.attrs.plugin).toBe('x');
    expect(start.attrs.route).toBe('/r');
  });

  it('handles card without type attribute (defaults later)', () => {
    const p = new CardParser();
    const evts = collect(p, '<card plugin="fm" route="/r">d</card>');
    const start = evts.find(e => e.type === 'card_start');
    expect(start.attrs.plugin).toBe('fm');
    expect(start.attrs.type).toBeUndefined();
  });

  it('handles multiple cards in one message', () => {
    const p = new CardParser();
    const evts = collect(p, '<card plugin="a" route="/1">x</card> mid <card plugin="b" route="/2">y</card>');
    const starts = evts.filter(e => e.type === 'card_start');
    expect(starts).toHaveLength(2);
    expect(starts[0].attrs.plugin).toBe('a');
    expect(starts[1].attrs.plugin).toBe('b');
  });

  it('holds partial opening tag at buffer end', () => {
    const p = new CardParser();
    const evts = [];
    p.feed('hello <car', (e) => evts.push(e));
    expect(evts).toEqual([{ type: 'text', data: 'hello ' }]);
    p.feed('d plugin="x" route="/r">body</card>', (e) => evts.push(e));
    p.flush((e) => evts.push(e));
    const types = evts.map(e => e.type);
    expect(types).toContain('card_start');
    expect(types).toContain('card_end');
  });

  it('flushes unclosed card as text on stream end', () => {
    const p = new CardParser();
    const evts = collect(p, '<card plugin="x" route="/r">partial');
    const types = evts.map(e => e.type);
    expect(types).toContain('card_start');
    expect(types).toContain('card_text');
    expect(types).toContain('card_end');
  });

  it('does not match non-card tags like <cardiac>', () => {
    const p = new CardParser();
    const evts = collect(p, 'this is <cardiac> not a card');
    expect(evts).toEqual([{ type: 'text', data: 'this is <cardiac> not a card' }]);
  });

  it('handles route with special chars (& = %)', () => {
    const p = new CardParser();
    const evts = collect(p, '<card plugin="fm" route="/k?symbol=sh600519&period=daily">d</card>');
    const start = evts.find(e => e.type === 'card_start');
    expect(start.attrs.route).toBe('/k?symbol=sh600519&period=daily');
  });
});
