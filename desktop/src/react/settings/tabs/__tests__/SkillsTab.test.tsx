/**
 * Tests for SkillsTab — Stage 11 safety net for the Stage 4 state migration.
 *
 * Two behaviors are protected here:
 *
 *   1. Sticky `skillsViewAgentId`: once initialized from `currentAgentId`, it
 *      must NOT auto-sync when the chat focus agent changes externally. The
 *      only sync mechanism is the user's manual AgentSelect interaction. The
 *      early return at line `if (skillsViewAgentId) return;` is what makes
 *      this work — if a future refactor removes it, Test 2 fails.
 *
 *   2. Race guard in `toggleSkill`: if the user switches the selector while a
 *      PUT is in flight, the stale `snapshotAgentId` mismatch must skip the
 *      actual PUT. If a future refactor removes the guard, Test 4 fails.
 *
 * Both behaviors are the #419-class UX bug surface. Without these tests they
 * regress silently.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

// `hanaFetch` is the single I/O seam for SkillsTab. Spy on it per test.
const fetchMock = vi.fn();
vi.mock('../../api', () => ({
  hanaFetch: (...args: unknown[]) => fetchMock(...args),
}));

// `helpers.ts` reads `window.platform` at module eval time (line 8). Full mock
// to avoid the jsdom bootstrap crash that AgentToolsSection.test.tsx also hit.
vi.mock('../../helpers', () => ({
  t: (key: string) => key,
  autoSaveConfig: vi.fn(),
}));

// AgentSelect: minimal <select> stub that forwards user-driven changes. The
// exposed options are the three agents the tests use below.
vi.mock('../bridge/AgentSelect', () => ({
  AgentSelect: ({
    value,
    onChange,
  }: {
    value: string | null;
    onChange: (id: string) => void;
  }) => (
    <select
      data-testid="agent-select"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">(none)</option>
      <option value="agent-a">Agent A</option>
      <option value="agent-b">Agent B</option>
      <option value="agent-c">Agent C</option>
    </select>
  ),
}));

// SkillRow: tiny stub that exposes the skill's name/enabled as data-* attrs
// and a toggle button the tests can click.
// SkillRow mock: mirrors production's conditional rendering — toggle/delete
// are only rendered when their respective callbacks are provided. This is
// critical post-refactor because the same skill can appear in two sections
// (Section 1 with onDelete only, Section 3 with onToggle only); an
// unconditional render would produce duplicate testids.
vi.mock('../skills/SkillRow', () => ({
  SkillRow: ({
    skill,
    onToggle,
    onDelete,
  }: {
    skill: { name: string; enabled: boolean };
    onToggle?: (name: string, enabled: boolean) => void;
    onDelete?: (name: string) => void;
  }) => (
    <div data-skill-name={skill.name} data-enabled={String(skill.enabled)}>
      {onToggle && (
        <button
          data-testid={`skill-toggle-${skill.name}`}
          onClick={() => onToggle(skill.name, !skill.enabled)}
        >
          toggle
        </button>
      )}
      {onDelete && (
        <button
          data-testid={`skill-delete-${skill.name}`}
          onClick={() => onDelete(skill.name)}
        >
          delete
        </button>
      )}
    </div>
  ),
}));

// Noop stubs for the other skill sub-components — they don't participate in
// the behaviors under test.
vi.mock('../skills/SkillCapabilities', () => ({
  SkillCapabilities: () => <div data-testid="skill-capabilities" />,
}));
vi.mock('../skills/CompatPathDrawer', () => ({
  CompatPathDrawer: () => <div data-testid="compat-path-drawer" />,
}));
vi.mock('../skills/LearnedSkillsBlock', () => ({
  LearnedSkillsBlock: ({
    learnedSkills,
  }: {
    learnedSkills: Array<{ name: string }>;
  }) => (
    <div data-testid="learned-skills-block" data-count={learnedSkills.length} />
  ),
}));

// ─── Real imports (after mocks so the mocked modules win) ─────────────────────

import { SkillsTab } from '../SkillsTab';
import { useSettingsStore, type SettingsState } from '../../store';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Controllable async promise for simulating fetch-in-flight races. */
function defer<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve: resolve! };
}

/** Minimal Response-like object so `await res.json()` works in mocks. */
function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

/** Seed a clean store state, matching the real SettingsState shape. */
function seedStore(partial: Partial<SettingsState> = {}) {
  const base: Partial<SettingsState> = {
    serverPort: null,
    serverToken: null,
    agents: [],
    currentAgentId: null,
    settingsAgentId: null,
    agentName: 'Hanako',
    userName: 'User',
    agentYuan: 'hanako',
    agentAvatarUrl: null,
    userAvatarUrl: null,
    settingsConfig: { capabilities: { learn_skills: {} } },
    globalModelsConfig: null,
    homeFolder: null,
    activeTab: 'skills',
    ready: true,
    currentPins: [],
    providersSummary: {},
    selectedProviderId: null,
    pluginAllowFullAccess: false,
    pluginUserDir: '',
    toastMessage: '',
    toastType: '',
    toastVisible: false,
  };
  useSettingsStore.setState({ ...base, ...partial });
}

/** Flush queued microtasks so chained promise .then() callbacks settle. */
async function flushMicrotasks(ticks = 3) {
  await act(async () => {
    for (let i = 0; i < ticks; i++) {
      await Promise.resolve();
    }
  });
}

/** Default fetch routing for tests that don't need agent-specific responses. */
function defaultFetchMock() {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/api/skills/external-paths')) {
      return Promise.resolve(jsonResponse({ configured: [], discovered: [] }));
    }
    if (url.includes('/api/skills')) {
      return Promise.resolve(jsonResponse({ skills: [] }));
    }
    return Promise.resolve(jsonResponse({}));
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  fetchMock.mockReset();
  // Force locale=en so the nameHints translate effect is skipped and no spurious
  // POST /api/skills/translate appears in fetchMock call log.
  (window as unknown as { i18n: { locale: string } }).i18n = { locale: 'en' };
  // `platform?.notifyMainWindow` is optional-chained in SkillsTab; leave undefined.
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { i18n?: unknown }).i18n;
});

describe('SkillsTab — sticky skillsViewAgentId & toggleSkill race guard', () => {
  // ── Test 1: initial mount syncs from currentAgentId ─────────────────────────
  it('initial mount sets skillsViewAgentId from currentAgentId and loads that agent', async () => {
    seedStore({ currentAgentId: 'agent-a' });

    // Default mock: resolve any GET with an empty skill list.
    defaultFetchMock();

    render(<SkillsTab />);
    await flushMicrotasks();

    // Selector reflects the store's currentAgentId.
    const sel = screen.getByTestId('agent-select') as HTMLSelectElement;
    expect(sel.value).toBe('agent-a');

    // hanaFetch was called with agentId=agent-a for the initial skills load.
    const skillsCalls = fetchMock.mock.calls.filter((c) =>
      typeof c[0] === 'string' && c[0].includes('/api/skills?agentId='),
    );
    expect(skillsCalls.length).toBeGreaterThanOrEqual(1);
    expect(skillsCalls[0][0]).toContain('agentId=agent-a');
  });

  // ── Test 2: sticky — external currentAgentId change does NOT resync ─────────
  it('external currentAgentId change does NOT resync skillsViewAgentId (sticky)', async () => {
    seedStore({ currentAgentId: 'agent-a' });

    defaultFetchMock();

    render(<SkillsTab />);
    await flushMicrotasks();

    // Baseline: selector is on agent-a, and agent-a's GET happened once.
    expect((screen.getByTestId('agent-select') as HTMLSelectElement).value).toBe('agent-a');
    const callsBefore = fetchMock.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('agentId='),
    ).length;
    const agentBCallsBefore = fetchMock.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('agentId=agent-b'),
    ).length;
    expect(agentBCallsBefore).toBe(0);

    // Simulate the chat focus agent changing externally (NOT via the selector).
    act(() => {
      seedStore({ currentAgentId: 'agent-b' });
    });
    await flushMicrotasks();

    // Selector MUST stay on agent-a — this is the sticky guarantee.
    expect((screen.getByTestId('agent-select') as HTMLSelectElement).value).toBe('agent-a');

    // And crucially: no new skills GET fired for agent-b, because
    // skillsViewAgentId didn't change, so the loadSkills effect didn't re-run.
    const agentBCallsAfter = fetchMock.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('agentId=agent-b'),
    ).length;
    expect(agentBCallsAfter).toBe(0);

    // Overall agentId-param call count should be stable (no extra loads).
    const callsAfter = fetchMock.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('agentId='),
    ).length;
    expect(callsAfter).toBe(callsBefore);
  });

  // ── Test 3: user-driven selector change DOES re-fire loadSkills ─────────────
  it('user changing AgentSelect re-fires loadSkills with the new agentId', async () => {
    seedStore({ currentAgentId: 'agent-a' });

    defaultFetchMock();

    render(<SkillsTab />);
    await flushMicrotasks();

    // Simulate the user selecting agent-c via the mocked <select>.
    await act(async () => {
      fireEvent.change(screen.getByTestId('agent-select'), {
        target: { value: 'agent-c' },
      });
    });
    await flushMicrotasks();

    // Selector now shows agent-c.
    expect((screen.getByTestId('agent-select') as HTMLSelectElement).value).toBe('agent-c');

    // And loadSkills re-fired with agentId=agent-c.
    const callsForAgentC = fetchMock.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('agentId=agent-c'),
    );
    expect(callsForAgentC.length).toBeGreaterThanOrEqual(1);
  });

  // ── Test 4: toggleSkill race guard — stale GET must not trigger PUT ─────────
  it('toggleSkill race guard: switching selector mid-flight skips the PUT', async () => {
    seedStore({ currentAgentId: 'agent-a' });

    // Initial load: agent-a has one skill; external-paths empty.
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/skills/external-paths')) {
        return Promise.resolve(jsonResponse({ configured: [], discovered: [] }));
      }
      if (url.includes('/api/skills?agentId=agent-a')) {
        return Promise.resolve(
          jsonResponse({
            skills: [
              { name: 'test-skill', enabled: false, source: 'user' },
            ],
          }),
        );
      }
      if (url.includes('/api/skills?agentId=agent-b')) {
        return Promise.resolve(jsonResponse({ skills: [] }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    render(<SkillsTab />);
    await flushMicrotasks();

    // Confirm the skill rendered (SkillRow stub exposes data-skill-name).
    expect(
      document.querySelector('[data-skill-name="test-skill"]'),
    ).toBeTruthy();

    // ── Arm the race ──────────────────────────────────────────────────────────
    // From here on, the first GET to /api/skills?agentId=agent-a (the "fresh
    // read" inside toggleSkill) is DEFERRED — we control when it resolves.
    const pendingFreshGet = defer<Response>();
    let freshGetConsumed = false;

    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (url.includes('/api/skills/external-paths')) {
        return Promise.resolve(jsonResponse({ configured: [], discovered: [] }));
      }
      // The PUT that the race guard should prevent.
      if (
        url.includes('/api/agents/agent-a/skills') &&
        opts?.method === 'PUT'
      ) {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (url.includes('/api/skills?agentId=agent-a')) {
        if (!freshGetConsumed) {
          freshGetConsumed = true;
          return pendingFreshGet.promise;
        }
        return Promise.resolve(
          jsonResponse({
            skills: [{ name: 'test-skill', enabled: false, source: 'user' }],
          }),
        );
      }
      if (url.includes('/api/skills?agentId=agent-b')) {
        return Promise.resolve(jsonResponse({ skills: [] }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    // Click the toggle — starts toggleSkill('test-skill', true).
    // This kicks off the deferred GET; the function is now parked awaiting it.
    await act(async () => {
      fireEvent.click(screen.getByTestId('skill-toggle-test-skill'));
    });

    // Before resolving the deferred GET, switch the selector to agent-b.
    // This synchronously updates skillsViewAgentId → ref updates on re-render →
    // when the GET finally resolves inside toggleSkill,
    // skillsViewAgentIdRef.current !== snapshotAgentId ('agent-a'), and the
    // race guard MUST early-return before the PUT.
    await act(async () => {
      fireEvent.change(screen.getByTestId('agent-select'), {
        target: { value: 'agent-b' },
      });
    });
    await flushMicrotasks();

    // Now resolve the stale GET from agent-a.
    await act(async () => {
      pendingFreshGet.resolve(
        jsonResponse({
          skills: [{ name: 'test-skill', enabled: false, source: 'user' }],
        }),
      );
    });
    // toggleSkill's await chain is 3 deep (await hanaFetch → await res.json →
    // race-guard check → potential PUT → await res.json). Flush 6 ticks so the
    // entire chain settles before we assert the PUT never fired.
    await flushMicrotasks(6);

    // ── Assertion ────────────────────────────────────────────────────────────
    // The race guard must have prevented the PUT to /api/agents/agent-a/skills.
    const putCallsToAgentA = fetchMock.mock.calls.filter(
      (c) =>
        typeof c[0] === 'string' &&
        c[0].includes('/api/agents/agent-a/skills') &&
        (c[1] as RequestInit | undefined)?.method === 'PUT',
    );
    expect(putCallsToAgentA.length).toBe(0);

    // Sanity: toast state remained at the seed baseline, proving the guard
    // skipped past the showToast branch.
    expect(useSettingsStore.getState().toastMessage).toBe('');
  });

  // ── Test 5: null → value transition DOES sync (initial seed semantics) ──────
  // Substitute for the spec's "agent-created event" test: the current code
  // doesn't subscribe to such an event. Instead we verify the effect-based
  // initial sync still works when currentAgentId arrives AFTER mount.
  it('null → value transition syncs skillsViewAgentId (first-agent-created flow)', async () => {
    // Mount with no agent selected yet.
    seedStore({ currentAgentId: null });

    defaultFetchMock();

    render(<SkillsTab />);
    await flushMicrotasks();

    // Selector starts empty and no agent-keyed GET happened yet.
    expect((screen.getByTestId('agent-select') as HTMLSelectElement).value).toBe('');
    const agentCallsBefore = fetchMock.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('agentId='),
    );
    expect(agentCallsBefore.length).toBe(0);

    // Simulate "first agent created" → currentAgentId flips from null to 'agent-a'.
    act(() => {
      seedStore({ currentAgentId: 'agent-a' });
    });
    await flushMicrotasks();

    // Because skillsViewAgentId was null, the early return doesn't fire, and
    // the effect syncs it to 'agent-a'.
    expect((screen.getByTestId('agent-select') as HTMLSelectElement).value).toBe('agent-a');

    // And loadSkills DID fire for agent-a after the sync.
    const agentCallsAfter = fetchMock.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('agentId=agent-a'),
    );
    expect(agentCallsAfter.length).toBeGreaterThanOrEqual(1);
  });
});
