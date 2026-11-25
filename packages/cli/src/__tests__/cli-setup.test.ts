import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import React from 'react';
import { render } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentProfileDTO,
  ProviderId,
  ProviderModelInfo,
  ProviderStatus,
  RoutingRuleDTO,
  SettingsDTO,
} from '@dalang/shared';
import type { RoomApiClient } from '../tui/client.js';
import { ConfigScreen } from '../tui/ConfigScreen.js';
import { ModelPicker } from '../tui/ModelPicker.js';
import {
  activeLeadModel,
  describeModel,
  describeRunningAgents,
  modelOptions,
  type ModelChoice,
} from '../tui/models.js';
import { stripMouse, wheelDelta } from '../tui/mouse.js';
import {
  effortsFor,
  isCrossProvider,
  planTeamChanges,
  roleFallback,
  roleProfiles,
  roleValue,
  usableProviderIds,
} from '../tui/team.js';
import { clipMiddle } from '../tui/ui.js';
import { resolveUserPath, Wizard } from '../tui/Wizard.js';

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const model = (
  value: string,
  displayName: string,
  efforts: ProviderModelInfo['supportedEffortLevels'] = [],
  defaultEffort: ProviderModelInfo['defaultEffort'] = null,
): ProviderModelInfo => ({
  id: value,
  value,
  resolvedModel: null,
  displayName,
  description: '',
  supportedEffortLevels: efforts,
  defaultEffort,
  supportsFastMode: false,
  supportsThinking: false,
  variants: [],
});

const provider = (id: ProviderId, over: Partial<ProviderStatus> = {}): ProviderStatus =>
  ({
    id,
    displayName: id,
    binary: id,
    binaryPath: `/usr/bin/${id}`,
    installed: true,
    version: '1.0.0',
    loggedIn: true,
    authSummary: 'signed in',
    sandboxReady: true,
    sandboxEngine: 'bwrap',
    models: [],
    usage: { available: true, windows: [] },
    checkedAt: '2026-11-24T00:00:00.000Z',
    ...over,
  }) as ProviderStatus;

const claude = provider('claude-code', {
  models: [model('sonnet', 'Sonnet', ['low', 'medium', 'high'], 'medium'), model('haiku', 'Haiku')],
});
const codex = provider('codex', { models: [model('gpt-5', 'GPT-5', ['low', 'high'], 'high')] });
const agyMissing = provider('antigravity', { installed: false, loggedIn: false, models: [] });

const profile = (name: string, providerId: ProviderId, over: Partial<AgentProfileDTO> = {}): AgentProfileDTO => ({
  id: `profile-${name}`,
  name,
  provider: providerId,
  model: '',
  effort: 'medium',
  rolePrompt: '',
  permissionMode: 'workspace-write',
  timeoutMs: 1_800_000,
  idleTimeoutMs: 180_000,
  maxParallel: 1,
  maxReviewRounds: 2,
  fallback: null,
  configDir: null,
  isDefault: false,
  createdAt: '2026-11-24T00:00:00.000Z',
  ...over,
});

const teamProfiles = (): AgentProfileDTO[] =>
  ['lead', 'coder-small', 'coder-medium', 'coder-heavy', 'qa', 'reviewer'].map((n) => profile(n, 'claude-code'));

const rule = (
  id: string,
  role: RoutingRuleDTO['role'],
  complexity: RoutingRuleDTO['complexity'],
  profileId: string,
): RoutingRuleDTO => ({ id, sortOrder: 0, role, complexity, profileId, fallback: null }) as RoutingRuleDTO;

const rules = (): RoutingRuleDTO[] => [
  rule('r-lead', 'lead', null, 'profile-lead'),
  rule('r-low', 'engineer', 'low', 'profile-coder-small'),
  rule('r-reviewer', 'reviewer', null, 'profile-reviewer'),
];

// ---------------------------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------------------------

describe('team setup logic', () => {
  it('preserves and disables configured fallbacks for individual roles', () => {
    const profiles = teamProfiles();
    const fallback = { provider: 'codex' as const, model: 'gpt-5', effort: 'low' as const, configDir: '/tmp/second-account' };
    profiles.find((p) => p.name === 'reviewer')!.fallback = fallback;
    const input = { profiles, rules: rules(), providers: [claude, codex], usable: usableProviderIds([claude, codex], false), suggestFallbacks: false };
    const kept = planTeamChanges({ ...input, edits: {} });
    expect(kept.profileUpdates).toEqual([]);
    expect(kept.ruleUpdates.find((u) => u.id === 'r-reviewer')?.body.fallback).toEqual(fallback);
    const disabled = planTeamChanges({ ...input, edits: { 'profile-reviewer': { fallback: null } } });
    expect(disabled.profileUpdates.find((u) => u.id === 'profile-reviewer')?.body.fallback).toBeNull();
    const offline = planTeamChanges({ ...input, usable: new Set<ProviderId>(['codex']), edits: {} });
    expect(offline.profileUpdates).toEqual([]);
  });

  it('counts a provider as usable only when installed and signed in, and Antigravity also needs the keyring', () => {
    const agy = provider('antigravity');
    expect([...usableProviderIds([claude, codex, agyMissing], false)]).toEqual(['claude-code', 'codex']);
    expect(usableProviderIds([claude, agy], false).has('antigravity')).toBe(false);
    expect(usableProviderIds([claude, agy], true).has('antigravity')).toBe(true);
    expect(usableProviderIds([provider('codex', { loggedIn: false })], false).size).toBe(0);
  });

  it('moves a role off a provider that is not ready and keeps the model only on the same provider', () => {
    const usable = usableProviderIds([codex], false); // claude is not ready
    const lead = profile('lead', 'claude-code', { model: 'sonnet', effort: 'high' });
    expect(roleValue(lead, undefined, usable, [claude, codex])).toEqual({
      provider: 'codex',
      model: '',
      effort: 'high',
    });
    // an effort the model does not accept falls back to its first allowed level
    const picked = roleValue(lead, { provider: 'codex', model: 'gpt-5', effort: 'medium' }, usable, [claude, codex]);
    expect(picked).toEqual({ provider: 'codex', model: 'gpt-5', effort: 'low' });
    expect(effortsFor([claude, codex], 'codex', 'gpt-5')).toEqual(['low', 'high']);
  });

  it('keeps a saved backup that is usable and differs from the primary, else suggests another ready CLI', () => {
    const usable = usableProviderIds([claude, codex], false);
    const saved = { provider: 'codex' as const, model: 'gpt-5', effort: 'low' as const, configDir: null };
    const withSaved = profile('lead', 'claude-code', { fallback: saved });
    expect(roleFallback(withSaved, 'claude-code', usable, [])).toEqual(saved);
    // the saved backup is the new primary: another ready CLI is suggested instead
    expect(roleFallback(withSaved, 'codex', usable, [])).toEqual({
      provider: 'claude-code',
      model: '',
      effort: 'high',
      configDir: null,
    });
    // one ready CLI only: no backup
    expect(roleFallback(profile('lead', 'claude-code'), 'claude-code', usableProviderIds([claude], false), [])).toBeNull();
  });

  it('plans profile and routing writes for an edited reviewer, and nothing when nothing changes', () => {
    const usable = usableProviderIds([claude, codex], false);
    const profiles = teamProfiles();
    const reviewer = roleProfiles(profiles).reviewer!;
    const plan = planTeamChanges({
      profiles,
      rules: rules(),
      providers: [claude, codex],
      usable,
      edits: { [reviewer.id]: { provider: 'codex', model: 'gpt-5', effort: 'high' } },
    });
    const reviewerUpdate = plan.profileUpdates.find((u) => u.id === reviewer.id)!;
    expect(reviewerUpdate.body).toMatchObject({ provider: 'codex', model: 'gpt-5', effort: 'high' });
    // the reviewer's backup moved off Codex to the other ready CLI
    expect(reviewerUpdate.body.fallback).toMatchObject({ provider: 'claude-code' });
    const reviewerRule = plan.ruleUpdates.find((u) => u.id === 'r-reviewer')!;
    expect(reviewerRule.body).toMatchObject({ profileId: reviewer.id, fallback: { provider: 'claude-code' } });

    // Apply the plan to the fixtures, then plan again: no changes left.
    const applied = profiles.map((p) => {
      const u = plan.profileUpdates.find((x) => x.id === p.id);
      return u ? ({ ...p, ...u.body } as AgentProfileDTO) : p;
    });
    const appliedRules = rules().map((r) => {
      const u = plan.ruleUpdates.find((x) => x.id === r.id);
      return u ? ({ ...r, ...u.body } as RoutingRuleDTO) : r;
    });
    const again = planTeamChanges({ profiles: applied, rules: appliedRules, providers: [claude, codex], usable, edits: {} });
    expect(again).toEqual({ profileUpdates: [], ruleUpdates: [] });
    expect(isCrossProvider(applied, [claude, codex], usable, {})).toBe(true);
    expect(isCrossProvider(profiles, [claude, codex], usable, {})).toBe(false);
  });
});

describe('model choice logic', () => {
  it('lists every model of every connected provider, with a CLI default first', () => {
    const usable = usableProviderIds([claude, codex, agyMissing], false);
    const options = modelOptions([claude, codex, agyMissing], usable);
    expect(options.map((o) => o.label)).toEqual([
      'Claude · CLI default',
      'Claude · Sonnet',
      'Claude · Haiku',
      'Codex · CLI default',
      'Codex · GPT-5',
    ]);
    expect(options.find((o) => o.model === 'sonnet')).toMatchObject({ efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' });
    expect(modelOptions([claude, codex], new Set(['codex']))).toHaveLength(2);
  });

  it('picks the active Lead model from the choice, then the session, then the Lead profile', () => {
    const leadProfile = { provider: 'claude-code' as const, model: 'sonnet', effort: 'high' as const };
    const choice: ModelChoice = { provider: 'codex', model: 'gpt-5', effort: null };
    expect(activeLeadModel({ choice, session: { provider: 'claude-code', model: 'haiku' }, leadProfile })).toEqual({
      provider: 'codex',
      model: 'gpt-5',
      effort: null, // the Lead's effort is sent only on the Lead's own CLI
      source: 'chosen',
    });
    expect(activeLeadModel({ choice: null, session: { provider: 'codex', model: null }, leadProfile })?.effort).toBeNull();
    expect(activeLeadModel({ choice: null, session: { provider: 'claude-code', model: null }, leadProfile })).toEqual({
      provider: 'claude-code',
      model: '',
      effort: 'high',
      source: 'session',
    });
    expect(activeLeadModel({ choice: null, session: null, leadProfile })?.source).toBe('profile');
    expect(activeLeadModel({ choice: null, session: null, leadProfile: null })).toBeNull();
    expect(describeModel({ provider: 'claude-code', model: '', effort: 'high' })).toBe('Claude · CLI default · high');
    const providers = [{ id: 'claude-code', models: [
      { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', variants: [] },
      { value: 'claude-fable-5-2', resolvedModel: 'claude-fable-5-2', displayName: 'Fable', variants: [{ id: '1m', label: '1M context', value: 'claude-fable-5-2[1m]' }] },
    ] }] as unknown as ProviderStatus[];
    expect(describeModel({ provider: 'claude-code', model: 'opus', effort: 'high' }, providers)).toBe('Claude · Claude Opus 5.5 · high');
    expect(describeModel({ provider: 'claude-code', model: 'claude-fable-5-2[1m]' }, providers)).toBe('Claude · Claude Fable 5.2');
    expect(describeModel({ provider: 'claude-code', model: 'claude-sonnet-5-5' })).toBe('Claude · Claude Sonnet 5.5');
    expect(describeModel({ provider: 'codex', model: 'gpt-x' }, providers)).toBe('Codex · gpt-x');
  });

  it('names the agents that are running now with their models', () => {
    expect(
      describeRunningAgents([
        { status: 'running', profileName: 'coder-small', provider: 'antigravity', model: 'gemini-4-hydrogen', kind: 'execute' },
        { status: 'completed', profileName: 'lead', provider: 'claude-code', model: 'sonnet', kind: 'execute' },
        { status: 'running', profileName: 'reviewer', provider: 'codex', model: null, kind: 'review' },
      ]),
    ).toEqual(['@coder-small Antigravity · gemini-4-hydrogen', '@reviewer Codex · CLI default']);
  });
});

describe('mouse and path helpers', () => {
  it('reads wheel turns from SGR mouse reports and strips every report from typed input', () => {
    expect(wheelDelta('\x1b[<64;10;5M')).toBe(1);
    expect(wheelDelta('\x1b[<65;10;5M')).toBe(-1);
    expect(wheelDelta('\x1b[<64;1;1M\x1b[<64;1;1M\x1b[<65;1;1M')).toBe(1);
    expect(wheelDelta('\x1b[<0;10;5M\x1b[<0;10;5m')).toBe(0); // clicks do not scroll
    expect(stripMouse('[<64;10;5M')).toBe(''); // Ink may hand it over without the escape
    expect(stripMouse('ab\x1b[<65;3;4Mcd')).toBe('abcd');
    expect(stripMouse('plain text')).toBe('plain text');
  });

  it('shortens a long value in the middle and leaves a short one alone', () => {
    const long = '/home/me/projects/client/very/deep/folder/repo';
    const clipped = clipMiddle(long, 24);
    expect(Array.from(clipped)).toHaveLength(24);
    expect(clipped.startsWith('/home/')).toBe(true);
    expect(clipped.endsWith('/repo')).toBe(true);
    expect(clipped).toContain('…');
    expect(clipMiddle('/short', 24)).toBe('/short');
    expect(clipMiddle('', 24)).toBe('');
  });

  it('turns a typed folder into an absolute path', () => {
    expect(resolveUserPath('~/work/app', '/srv')).toBe(path.join(os.homedir(), 'work/app'));
    expect(resolveUserPath('~', '/srv')).toBe(os.homedir());
    expect(resolveUserPath('app', '/srv/work')).toBe('/srv/work/app');
    expect(resolveUserPath(' /abs/path ', '/srv')).toBe('/abs/path');
  });
});

// ---------------------------------------------------------------------------------------------
// Ink flows
// ---------------------------------------------------------------------------------------------

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const DOWN = '\x1b[B';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mount(element: React.ReactElement) {
  const stdout = new PassThrough();
  Object.assign(stdout, { columns: 110, rows: 36, isTTY: true });
  let screen = '';
  stdout.on('data', (chunk) => {
    screen += chunk.toString('utf8');
  });
  const stdin = new PassThrough();
  Object.assign(stdin, { isTTY: true, setRawMode: () => {} });
  const inst = render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  cleanups.push(() => {
    inst.unmount();
    stdout.end();
    stdin.end();
  });
  return {
    screen: () => screen,
    reset: () => {
      screen = '';
    },
    waitFor: async (needle: string, timeoutMs = 6000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (screen.includes(needle)) return;
        await sleep(30);
      }
      throw new Error(`Timed out waiting for "${needle}". Last screen tail:\n${screen.slice(-1500)}`);
    },
    /** Send keys one at a time so Ink never merges two escape sequences into one chunk. */
    press: async (...keys: string[]) => {
      for (const k of keys) {
        stdin.write(k);
        await sleep(45);
      }
    },
  };
}

function stubClient(over: Record<string, unknown> = {}) {
  const calls = {
    updateProfile: [] as Array<[string, unknown]>,
    updateRoutingRule: [] as Array<[string, unknown]>,
    updateSettings: [] as unknown[],
    createOrOpenProject: [] as unknown[],
  };
  const settings: SettingsDTO = {
    antigravityKeyringAccess: false,
    language: 'en',
    checkForUpdates: true,
    usageRefreshMinutes: 5,
  };
  const client = {
    getProvidersStatus: async () => [claude, codex, agyMissing],
    refreshProvidersStatus: async () => [claude, codex, agyMissing],
    getSettings: async () => settings,
    listProfiles: async () => teamProfiles(),
    listRoutingRules: async () => rules(),
    updateSettings: async (body: Partial<SettingsDTO>) => {
      calls.updateSettings.push(body);
      Object.assign(settings, body);
      return settings;
    },
    updateProfile: async (id: string, body: unknown) => {
      calls.updateProfile.push([id, body]);
      return {};
    },
    updateRoutingRule: async (id: string, body: unknown) => {
      calls.updateRoutingRule.push([id, body]);
      return {};
    },
    createOrOpenProject: async (body: unknown) => {
      calls.createOrOpenProject.push(body);
      return { id: 'proj-1', name: 'demo', path: '/work/demo' };
    },
    ...over,
  };
  return { client: client as unknown as RoomApiClient, calls };
}

describe('setup wizard (Ink)', () => {
  it('walks the four steps, edits the reviewer, applies the team, and creates the first project', async () => {
    const { client, calls } = stubClient();
    const completed: Array<[unknown, string]> = [];
    const ui = mount(
      React.createElement(Wizard, {
        client,
        cwd: '/work/demo',
        width: 110,
        height: 36,
        onSkip: () => {},
        onComplete: (project, goal) => completed.push([project, goal]),
      }),
    );

    // Step 1: how Dalang works
    await ui.waitFor('Step 1 of 4');
    await ui.waitFor('Semar');
    await ui.waitFor('Discuss & Agree (Gate 1)');
    await ui.press('\r');

    // Step 2: agent CLIs. Claude and Codex are ready, Antigravity is missing.
    await ui.waitFor('Step 2 of 4');
    await ui.waitFor('Check your agent CLIs');
    await ui.waitFor('Sandbox ready: bwrap');
    await ui.waitFor('MISSING');
    await ui.waitFor('Fix: https://antigravity.google/cli');
    await ui.press(DOWN, '\r'); // Re-check CLIs -> Next

    // Step 3: team. Everything starts on Claude, so the review is not cross-provider yet.
    await ui.waitFor('Step 3 of 4');
    await ui.waitFor('Coder and reviewer use the same provider');
    // Reviewer is the 6th role: open it, change Provider to Codex, then Model to GPT-5.
    await ui.press(DOWN, DOWN, DOWN, DOWN, DOWN, '\r');
    await ui.waitFor('Reviewer (Arjuna)');
    await ui.press('\r'); // Provider
    await ui.press(DOWN, '\r'); // Claude -> Codex
    await ui.waitFor('Codex · CLI default');
    await ui.press(DOWN, '\r'); // Model
    await ui.waitFor('GPT-5');
    await ui.press(DOWN, '\r'); // CLI default -> GPT-5
    await ui.waitFor('Codex · GPT-5');
    await ui.press(DOWN, DOWN, DOWN, DOWN, '\r'); // Done
    await ui.waitFor('Cross-provider review active');
    await ui.press(DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, '\r'); // Accept team & continue

    // Step 4: first project
    await ui.waitFor('Step 4 of 4');
    await ui.waitFor('Create your first project');
    expect(calls.updateProfile.some(([id, body]) => id === 'profile-reviewer' && JSON.stringify(body).includes('"provider":"codex"'))).toBe(true);
    expect(calls.updateRoutingRule.some(([id]) => id === 'r-reviewer')).toBe(true);

    await ui.press(DOWN, DOWN, DOWN, DOWN, '\r'); // Goal
    await ui.press('add a health check\r');
    await ui.waitFor('add a health check');
    await ui.press(DOWN, DOWN, DOWN, DOWN, DOWN, '\r'); // Open repo & continue

    await sleep(200);
    expect(calls.createOrOpenProject).toEqual([
      {
        mode: 'open',
        name: undefined,
        path: '/work/demo',
        stackHint: undefined,
        initGitIfMissing: true,
        leadProvider: 'claude-code',
      },
    ]);
    expect(completed).toEqual([[{ id: 'proj-1', name: 'demo', path: '/work/demo' }, 'add a health check']]);
  });

  it('will not leave step 2 until one CLI is ready, and Skip leaves the wizard', async () => {
    const { client } = stubClient({
      getProvidersStatus: async () => [provider('claude-code', { loggedIn: false }), codex, agyMissing].map((p) =>
        p.id === 'codex' ? { ...p, loggedIn: false } : p,
      ),
    });
    let skipped = 0;
    const ui = mount(
      React.createElement(Wizard, {
        client,
        cwd: '/work/demo',
        width: 110,
        height: 36,
        onSkip: () => {
          skipped += 1;
        },
        onComplete: () => {},
      }),
    );
    await ui.waitFor('Step 1 of 4');
    await ui.press('\r');
    await ui.waitFor('LOGIN NEEDED');
    await ui.waitFor('Fix: claude auth login');
    await ui.waitFor('needs one ready CLI');
    // Next is disabled: Re-check, then Next (disabled), Back, Skip
    await ui.press(DOWN, '\r');
    await sleep(120);
    expect(ui.screen()).toContain('Step 2 of 4');
    await ui.press(DOWN, DOWN, '\r'); // Skip wizard
    await sleep(120);
    expect(skipped).toBe(1);
  });
});

describe('/model picker (Ink)', () => {
  const usable = usableProviderIds([claude, codex, agyMissing], false);
  const active = { provider: 'claude-code' as const, model: 'sonnet', effort: 'high' as const, source: 'session' as const };

  it('shows the active model and every connected provider, then asks for effort', async () => {
    const chosen: Array<ModelChoice | null> = [];
    const ui = mount(
      React.createElement(ModelPicker, {
        providers: [claude, codex, agyMissing],
        usable,
        active,
        width: 110,
        height: 30,
        onChoose: (c) => chosen.push(c),
        onCancel: () => {},
      }),
    );
    await ui.waitFor("Choose the Lead's model");
    await ui.waitFor('Active now: Claude · Sonnet · high (this session)');
    await ui.waitFor('Codex · GPT-5');
    expect(ui.screen()).not.toContain('Antigravity ·');
    await ui.waitFor('(active)');

    // The highlight starts on the active model: Enter opens its effort list, preselecting the model default.
    await ui.press('\r');
    await ui.waitFor('Reasoning effort for Claude · Sonnet');
    await ui.press(DOWN, '\r'); // medium -> high
    await sleep(100);
    expect(chosen).toEqual([{ provider: 'claude-code', model: 'sonnet', effort: 'high' }]);
  });

  it('asks for effort even for a model that reports no levels (every level is offered), and can go back to the Lead setting', async () => {
    const chosen: Array<ModelChoice | null> = [];
    const ui = mount(
      React.createElement(ModelPicker, {
        providers: [claude, codex, agyMissing],
        usable,
        active: null,
        width: 110,
        height: 30,
        onChoose: (c) => chosen.push(c),
        onCancel: () => {},
      }),
    );
    await ui.waitFor('No model is set yet.');
    // default(0), Claude CLI default(1), Sonnet(2), Haiku(3)
    await ui.press(DOWN, DOWN, DOWN, '\r');
    await ui.waitFor('Reasoning effort for Claude · Haiku');
    await ui.waitFor('xhigh'); // the CLI named no levels, so all five are offered
    await ui.press('\r'); // "Lead's usual effort"
    await sleep(100);
    expect(chosen).toEqual([{ provider: 'claude-code', model: 'haiku', effort: null }]);

    // The first row forgets the choice made here.
    const again: Array<ModelChoice | null> = [];
    const ui2 = mount(
      React.createElement(ModelPicker, {
        providers: [claude, codex, agyMissing],
        usable,
        active: null,
        width: 110,
        height: 30,
        onChoose: (c) => again.push(c),
        onCancel: () => {},
      }),
    );
    await ui2.waitFor('Use the Lead');
    await ui2.press('\r');
    await sleep(100);
    expect(again).toEqual([null]);
  });
});

describe('/config (Ink)', () => {
  it('sets a reviewer fallback and saves it to the profile and routing rule', async () => {
    const { client, calls } = stubClient();
    const ui = mount(React.createElement(ConfigScreen, {
      client, width: 110, height: 36, onClose: () => {}, onWizard: () => {},
    }));
    await ui.waitFor('Agent team');
    await ui.press(DOWN, DOWN, DOWN, DOWN, '\r');
    await ui.waitFor('Reviewer (Arjuna)');
    await ui.press(DOWN, DOWN, DOWN, DOWN, DOWN, '\r');
    await ui.waitFor('Reasoning effort');
    await ui.press(DOWN, DOWN, DOWN, '\r');
    await ui.waitFor('Fallback provider');
    await ui.press('\r');
    await ui.waitFor('No fallback');
    await ui.press(DOWN, DOWN, '\r');
    await ui.waitFor('Fallback model');
    await ui.press(DOWN, '\r');
    await ui.waitFor('GPT-5');
    await ui.press(DOWN, '\r');
    await ui.waitFor('Fallback reasoning effort');
    await ui.press(DOWN, DOWN, DOWN, DOWN, '\r');
    await ui.waitFor('Reviewer (Arjuna)');
    await ui.press(DOWN, DOWN, DOWN, DOWN, '\r');
    await ui.waitFor('Save team');
    await ui.press(DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, '\r');
    await sleep(200);
    expect(calls.updateProfile).toContainEqual(['profile-reviewer', expect.objectContaining({
      fallback: { provider: 'codex', model: 'gpt-5', effort: 'low', configDir: null },
    })]);
    expect(calls.updateRoutingRule).toContainEqual(['r-reviewer', expect.objectContaining({
      fallback: { provider: 'codex', model: 'gpt-5', effort: 'low', configDir: null },
    })]);
  });

  it('changes the language and the limits refresh interval through the settings API', async () => {
    const { client, calls } = stubClient();
    const ui = mount(
      React.createElement(ConfigScreen, {
        client,
        width: 110,
        height: 30,
        onClose: () => {},
        onWizard: () => {},
      }),
    );
    await ui.waitFor('Language');
    await ui.waitFor('Provider limits refresh');
    await ui.press('\r'); // Language
    await ui.waitFor('Config · Language');
    await ui.press(DOWN, '\r'); // English -> Indonesian
    await sleep(200);
    expect(calls.updateSettings).toEqual([{ language: 'id' }]);

    await ui.waitFor('Indonesian');
    await ui.press(DOWN, '\r'); // Provider limits refresh
    await ui.waitFor('Config · Provider limits refresh');
    await ui.press(DOWN, '\r'); // 5 -> 10
    await sleep(200);
    expect(calls.updateSettings).toEqual([{ language: 'id' }, { usageRefreshMinutes: 10 }]);
  });

  it('opens the wizard from the menu', async () => {
    const { client } = stubClient();
    let wizard = 0;
    const ui = mount(
      React.createElement(ConfigScreen, {
        client,
        width: 110,
        height: 30,
        onClose: () => {},
        onWizard: () => {
          wizard += 1;
        },
      }),
    );
    await ui.waitFor('Setup wizard');
    // Language, refresh, updates, CLIs, team, wizard
    await ui.press(DOWN, DOWN, DOWN, DOWN, DOWN, '\r');
    await sleep(100);
    expect(wizard).toBe(1);
  });
});
