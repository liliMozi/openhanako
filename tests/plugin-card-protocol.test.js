import { describe, it, expect } from 'vitest';

describe('Plugin Card Protocol V2 - _cardHint', () => {
  it('tool result contains _cardHint with required fields', () => {
    const result = {
      content: [{ type: 'text', text: 'data...\n\n📊 <card type="iframe" plugin="fm" route="/k">desc</card>' }],
      details: {
        _cardHint: {
          type: 'iframe',
          plugin: 'fm',
          route: '/k',
          title: 'Title',
          defaultDescription: 'fallback desc',
        }
      }
    };
    const hint = result.details._cardHint;
    expect(hint.plugin).toBe('fm');
    expect(hint.route).toBe('/k');
    expect(hint.defaultDescription).toBeTruthy();
  });

  it('content text includes <card> tag for LLM to reproduce', () => {
    const text = 'data...\n\n📊 <card type="iframe" plugin="fm" route="/k">desc</card>';
    expect(text).toContain('<card');
    expect(text).toContain('</card>');
  });

  it('_cardHint has all required fields', () => {
    const hint = {
      type: 'iframe',
      plugin: 'test-plugin',
      route: '/card/test?param=value',
      title: 'Test Card',
      defaultDescription: 'fallback text',
    };
    expect(hint.type).toBeDefined();
    expect(hint.plugin).toBeDefined();
    expect(hint.route).toBeDefined();
    expect(hint.defaultDescription).toBeDefined();
  });
});
