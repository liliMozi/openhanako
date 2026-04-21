import { beforeAll, describe, expect, it, vi } from 'vitest';

const t = (key: string) => key;

let buildSlashCommands: typeof import('../../components/input/slash-commands').buildSlashCommands;
let resolveSlashSubmitSelection: typeof import('../../components/input/slash-commands').resolveSlashSubmitSelection;

beforeAll(async () => {
  vi.stubGlobal('window', { i18n: { locale: 'zh' } });
  ({ buildSlashCommands, resolveSlashSubmitSelection } = await import('../../components/input/slash-commands'));
});

function makeCommands() {
  return buildSlashCommands(
    t,
    async () => {},
    async () => {},
    async () => {},
  );
}

describe('resolveSlashSubmitSelection', () => {
  it('returns the matching slash command for an unfinished slash input', () => {
    const commands = makeCommands();

    const result = resolveSlashSubmitSelection({
      text: '/compa',
      skills: [],
      commands,
      selectedIndex: 0,
      dismissedText: null,
    });

    expect(result?.name).toBe('compact');
  });

  it('does not auto-select when the current slash text was explicitly dismissed', () => {
    const commands = makeCommands();

    const result = resolveSlashSubmitSelection({
      text: '/compa',
      skills: [],
      commands,
      selectedIndex: 0,
      dismissedText: '/compa',
    });

    expect(result).toBeNull();
  });
});
