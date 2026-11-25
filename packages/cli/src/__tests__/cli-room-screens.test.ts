import { PassThrough } from 'node:stream';
import React from 'react';
import { render } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentProfileDTO, ProviderModelInfo, ProviderStatus } from '@dalang/shared';
import type { RoomApiClient, ServerEvent } from '../tui/client.js';
import { RoomApp } from '../tui/RoomApp.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const DOWN = '\x1b[B';
const UP = '\x1b[A';
const PAGE_UP = '\x1b[5~';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

const claude = {
  id: 'claude-code',
  displayName: 'Claude Code',
  binary: 'claude',
  binaryPath: '/usr/bin/claude',
  installed: true,
  version: '2.1.0',
  loggedIn: true,
  authSummary: 'signed in',
  sandboxReady: true,
  sandboxEngine: 'bwrap',
  models: [model('sonnet', 'Sonnet', ['low', 'medium', 'high'], 'medium')],
  usage: {
    available: true,
    windows: [
      { group: 'all', window: '5h', label: '5h', usedPercent: 20, remainingPercent: 80, resetsAt: null },
      { group: 'all', window: 'weekly', label: 'weekly', usedPercent: null, remainingPercent: 15, resetsAt: null },
    ],
  },
  checkedAt: '2026-11-24T00:00:00.000Z',
} as unknown as ProviderStatus;

const leadProfile = {
  id: 'profile-lead',
  name: 'lead',
  provider: 'claude-code',
  model: '',
  effort: 'medium',
} as unknown as AgentProfileDTO;

const project = { id: 'p1', name: 'demo', path: '/work/demo', workingSessionId: null, leadProvider: 'claude-code', leadModel: null };
const session = {
  id: 's1',
  projectId: 'p1',
  title: 'Earlier chat',
  mode: 'ask',
  workState: 'idle',
  archivedAt: null,
  provider: 'claude-code',
  model: null,
  updatedAt: '2026-11-24T10:00:00.000Z',
};

function roomClient(over: Record<string, unknown> = {}) {
  const sent: unknown[] = [];
  const client = {
    baseUrl: 'http://127.0.0.1:1',
    authStatus: async () => ({ enabled: false, authenticated: true, language: null }),
    listProjects: async () => [project],
    listProfiles: async () => [leadProfile],
    listRoutingRules: async () => [],
    listSessions: async () => ({ sessions: [session], workingSessionId: null }),
    getExecutionState: async () => ({ runs: [], activeRuns: [] }),
    getGuardState: async () => ({ tasks: [], mainBranch: 'main' }),
    getSessionDetail: async () => ({ session, messages: [], briefs: [], plan: null }),
    connectEvents: () => () => {},
    getProvidersStatus: async () => [claude],
    refreshProvidersStatus: async () => [claude],
    getSettings: async () => ({
      antigravityKeyringAccess: false,
      language: 'en',
      checkForUpdates: true,
      usageRefreshMinutes: 5,
    }),
    sendChatMessage: async (_projectId: string, body: unknown) => {
      sent.push(body);
      return { session, mode: 'ask', messages: [] };
    },
    ...over,
  };
  return { client: client as unknown as RoomApiClient, sent };
}

function mountRoom(client: RoomApiClient, extra: Record<string, unknown> = {}) {
  const stdout = new PassThrough();
  Object.assign(stdout, { columns: 110, rows: 36, isTTY: true });
  let screen = '';
  stdout.on('data', (chunk) => {
    screen += chunk.toString('utf8');
  });
  const stdin = new PassThrough();
  Object.assign(stdin, { isTTY: true, setRawMode: () => {} });
  const inst = render(
    React.createElement(RoomApp, {
      client,
      embedded: false,
      cwd: '/work/demo',
      openBrowser: () => {},
      onOpenPager: async () => ({ ok: true }),
      ...extra,
    }),
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  cleanups.push(() => {
    inst.unmount();
    stdout.end();
    stdin.end();
  });
  return {
    screen: () => screen,
    mark: () => screen.length,
    since: (mark: number) => screen.slice(mark),
    waitFor: async (needle: string, from = 0, timeoutMs = 6000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (screen.slice(from).includes(needle)) return;
        await sleep(30);
      }
      throw new Error(`Timed out waiting for "${needle}". Last screen tail:\n${screen.slice(-1500)}`);
    },
    press: async (...keys: string[]) => {
      for (const k of keys) {
        stdin.write(k);
        await sleep(45);
      }
    },
  };
}

describe('room screens (Ink, stub server)', () => {
  it('recalls prior prompts with Up and restores the draft with Down', async () => {
    const messages = ['older question', 'recent question'].map((content, index) => ({
      id: `prompt-${index}`, sessionId: 's1', role: 'user', type: 'text', content,
      createdAt: session.updatedAt,
    }));
    const { client, sent } = roomClient({
      getSessionDetail: async () => ({ session, messages, briefs: [], plan: null }),
    });
    const ui = mountRoom(client);
    await ui.waitFor('Lead Claude');
    await ui.press('/resume 1', '\r');
    await ui.waitFor('Resumed');
    await ui.press('draft');
    const mark = ui.mark();
    await ui.press(UP, UP, DOWN, DOWN);
    expect(ui.since(mark)).toContain('[ask] > older question');
    expect(ui.since(mark)).toContain('[ask] > recent question');
    expect(ui.since(mark)).toContain('[ask] > draft');
    expect(sent).toEqual([]);
  });

  it('shows elapsed work and safe activity, then renders the finished reply as Markdown', async () => {
    let emit!: (event: ServerEvent) => void;
    let turn: { phase: string; provider: string; startedAt: string } | null = null;
    const { client } = roomClient({
      connectEvents: (listener: typeof emit) => {
        emit = listener;
        return () => {};
      },
      listSessions: async () => ({ sessions: [{ ...session, turn }] }),
      getSessionDetail: async () => ({
        session: { ...session, turn },
        messages: turn ? [] : [{
          id: 'reply', sessionId: 's1', role: 'lead', type: 'ask', createdAt: session.updatedAt,
          content: { text: '### Result\n\n- **Ready** in `src`\n- [README](file:///work/demo/README.md)\n\n```sh\n  echo done\n```' },
        }],
        briefs: [],
        plan: null,
      }),
    });
    const ui = mountRoom(client);
    await ui.waitFor('Lead Claude');
    turn = { phase: 'ask', provider: 'claude-code', startedAt: new Date(Date.now() - 65_000).toISOString() };
    await ui.press('/resume 1', '\r');
    await ui.waitFor('1:05 · @lead (Claude) · Working');
    const working = ui.mark();
    emit({ type: 'lead.log', projectId: 'p1', sessionId: 'other', line: '{"type":"item.started","item":{"type":"web_search"}}' });
    emit({ type: 'lead.log', projectId: 'p1', sessionId: 's1', line: '{"type":"item.started","item":{"type":"command_execution","command":"private command"}}' });
    await ui.waitFor('1:06 · @lead (Claude) · Running a command', working);
    const frames = ui.since(working).match(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?= 1:0[56] · @lead)/g);
    expect(new Set(frames).size).toBeGreaterThan(1);
    expect(ui.since(working)).not.toMatch(/private command|Searching the web/);

    const finished = ui.mark();
    turn = null;
    emit({ type: 'lead.turn_finished', projectId: 'p1', sessionId: 's1' });
    await ui.waitFor('• Ready in src', finished);
    await ui.waitFor('• README', finished);
    await ui.waitFor('│   echo done', finished);
    expect(ui.since(finished)).not.toMatch(/### Result|\*\*Ready\*\*|file:\/\/\/|Running a command/);
  });

  it('streams the reply while it is written, then hands over to the saved message', async () => {
    let emit!: (event: ServerEvent) => void;
    let turn: { phase: string; provider: string; startedAt: string } | null = null;
    const { client } = roomClient({
      connectEvents: (listener: typeof emit) => {
        emit = listener;
        return () => {};
      },
      listSessions: async () => ({ sessions: [{ ...session, turn }] }),
      getSessionDetail: async () => ({
        session: { ...session, turn },
        messages: turn ? [] : [{
          id: 'reply', sessionId: 's1', role: 'lead', type: 'ask', createdAt: session.updatedAt,
          content: { text: 'Saved final answer' },
        }],
        briefs: [],
        plan: null,
      }),
    });
    const ui = mountRoom(client);
    await ui.waitFor('Lead Claude');
    turn = { phase: 'ask', provider: 'claude-code', startedAt: new Date().toISOString() };
    await ui.press('/resume 1', '\r');
    await ui.waitFor('@lead (Claude) · Working');

    // A JSON reply shows only its answer, decoded as it arrives; a terminal escape never gets through.
    const streaming = ui.mark();
    emit({ type: 'lead.text', projectId: 'p1', sessionId: 's1', phase: 'ask', text: '{"answer": "First **par', reset: true });
    await ui.waitFor('writing...', streaming);
    emit({ type: 'lead.text', projectId: 'p1', sessionId: 's1', phase: 'ask', text: 't**\\n\\nSecond \\u001b[2Jline' });
    await ui.waitFor('Second line', streaming);
    await ui.waitFor('@lead (Claude) · Writing a response', streaming);
    expect(ui.since(streaming)).toContain('First part');
    expect(ui.since(streaming)).not.toMatch(/"answer"|Second \x1b/);

    // A new attempt starts its text over.
    const retried = ui.mark();
    emit({ type: 'lead.text', projectId: 'p1', sessionId: 's1', phase: 'ask', text: 'Plain retry text', reset: true });
    await ui.waitFor('Plain retry text', retried);
    expect(ui.since(retried).split('Plain retry text').at(-1)).not.toContain('First part');

    const finished = ui.mark();
    turn = null;
    emit({ type: 'lead.turn_finished', projectId: 'p1', sessionId: 's1' });
    await ui.waitFor('Saved final answer', finished);
    await sleep(150);
    const lastFrame = ui.screen().slice(ui.screen().lastIndexOf('Saved final answer') - 200);
    expect(lastFrame.split('Saved final answer').at(-1)).not.toContain('writing...');
  });

  it('keeps showing work when one of two parallel runs finishes', async () => {
    let emit!: (event: ServerEvent) => void;
    const coder = { id: 'r1', status: 'running', kind: 'execute', profileName: 'coder-small', provider: 'codex', taskExternalId: 'T-001', startedAt: new Date(Date.now() - 30_000).toISOString() };
    const reviewer = { ...coder, id: 'r2', kind: 'review', profileName: 'reviewer', taskExternalId: 'T-002' };
    let runs = [reviewer, coder];
    const { client } = roomClient({
      connectEvents: (listener: typeof emit) => {
        emit = listener;
        return () => {};
      },
      getExecutionState: async (projectId: string, sessionId?: string) => ({ projectId, sessionId, activeRuns: runs, runs }),
    });
    const ui = mountRoom(client);
    await ui.waitFor('Lead Claude');
    await ui.press('/resume 1', '\r');
    await ui.waitFor('@coder-small (Codex) +1 · Working on T-001');

    const beforeFinish = ui.mark();
    emit({ type: 'run.log', projectId: 'p1', runId: 'r1', line: '[dalang] Running verify command: pnpm test' });
    await ui.waitFor('@coder-small (Codex) +1 · Running verification', beforeFinish);
    runs = [reviewer];
    const afterFinish = ui.mark();
    emit({ type: 'run.finished', projectId: 'p1', sessionId: 's1', runId: 'r1' });
    await ui.waitFor('@reviewer (Codex) · Working on T-002', afterFinish);
  });

  it('opens the setup wizard on its own when no project exists yet', async () => {
    const { client } = roomClient({
      listProjects: async () => [],
      listSessions: async () => ({ sessions: [], workingSessionId: null }),
    });
    const ui = mountRoom(client);
    await ui.waitFor('Welcome to DALANG');
    await ui.waitFor('Step 1 of 4');
    await ui.waitFor('How DALANG works');
    // The "no projects" hint belongs to a skipped wizard, not to every first run.
    expect(ui.screen()).not.toContain('No DALANG projects registered yet');
    await ui.press(DOWN, '\r'); // Skip wizard
    await ui.waitFor('No DALANG projects registered yet');
    await ui.waitFor('/wizard');
  });

  it('shows the active model and the provider limits in the header, and /model changes what is sent', async () => {
    const { client, sent } = roomClient();
    const ui = mountRoom(client);
    await ui.waitFor('claude 5h 80% wk 15%'); // quick stats, 15% in red
    await ui.waitFor('Lead Claude · CLI default · medium');
    await ui.waitFor('(Lead profile)');
    await ui.waitFor('~/../work/demo'.slice(0, 0) + '/work/demo'); // project path on the last header row

    await ui.press('/model', '\r');
    await ui.waitFor("Choose the Lead's model");
    await ui.waitFor('Active now: Claude · CLI default · medium (Lead profile)');
    await ui.press(DOWN, '\r'); // Claude · Sonnet
    await ui.waitFor('Reasoning effort for Claude · sonnet');
    await ui.press(DOWN, '\r'); // medium (model default) -> high

    await ui.waitFor('Lead model set to Claude · sonnet · high');
    await ui.waitFor('(chosen with /model)');

    await ui.press('hello', '\r');
    await sleep(150);
    expect(sent).toEqual([
      { sessionId: undefined, mode: 'ask', message: 'hello', provider: 'claude-code', model: 'sonnet', effort: 'high' },
    ]);
  });

  it('opens /config and /wizard from the composer and comes back with Esc', async () => {
    const { client } = roomClient();
    const ui = mountRoom(client);
    await ui.waitFor('Lead Claude');
    await ui.press('/config', '\r');
    await ui.waitFor('Provider limits refresh');
    await ui.waitFor('Setup wizard');
    await ui.press('\x1b'); // Esc closes the config screen
    await ui.waitFor('@profile tag/steer');

    const mark = ui.mark();
    await ui.press('/wizard', '\r');
    await ui.waitFor('Welcome to DALANG', mark);
  });

  it('scrolls older messages with the mouse wheel and PageUp, and a click never types into the composer', async () => {
    const many = Array.from({ length: 70 }, (_, i) => ({
      id: `m${i}`,
      sessionId: 's1',
      role: i % 2 === 0 ? 'user' : 'lead',
      type: 'text',
      content: `message number ${String(i).padStart(2, '0')}`,
      // one minute apart, a day before the test runs, so the notices the room adds sort after them
      createdAt: new Date(Date.UTC(2026, 10, 23, 10, i)).toISOString(),
    }));
    const { client } = roomClient({
      getSessionDetail: async () => ({ session, messages: many, briefs: [], plan: null }),
    });
    const ui = mountRoom(client, { enableMouse: true });
    await ui.waitFor('Lead Claude');
    await ui.press('/resume', '\r');
    await ui.waitFor('1. Earlier chat');
    await ui.press('\r');
    await ui.waitFor('Resumed');
    await ui.waitFor('message number 69'); // the end of the conversation
    await ui.waitFor('above · wheel or PgUp'); // there is more above

    // Two wheel notches up: 3 rows each.
    let mark = ui.mark();
    await ui.press('\x1b[<64;20;10M');
    await ui.press('\x1b[<64;20;10M');
    await ui.waitFor('↓6 below', mark);
    // A click is not typed into the composer.
    await ui.press('\x1b[<0;20;10M', '\x1b[<0;20;10m');
    expect(ui.since(mark)).not.toContain('<0;20;10');
    expect(ui.since(mark)).not.toContain('<64;');

    // Wheel down returns to the end.
    mark = ui.mark();
    await ui.press('\x1b[<65;20;10M', '\x1b[<65;20;10M', '\x1b[<65;20;10M', '\x1b[<65;20;10M');
    await ui.waitFor('above · wheel or PgUp', mark);

    // A burst of 60 notches in one chunk stops at the top; one notch down then moves exactly 3 rows.
    const below = (text: string): number | null => {
      const all = [...text.matchAll(/↓(\d+) below/g)];
      return all.length > 0 ? Number(all[all.length - 1][1]) : null;
    };
    mark = ui.mark();
    await ui.press('\x1b[<64;20;10M'.repeat(60));
    await ui.waitFor('message number 00', mark);
    const top = below(ui.since(mark));
    expect(top).toBeGreaterThan(40);
    mark = ui.mark();
    await ui.press('\x1b[<65;20;10M');
    await ui.waitFor('below', mark);
    expect(below(ui.since(mark))).toBe((top as number) - 3);

    // PageDown comes back from the top without extra presses to undo an overshoot.
    for (let i = 0; i < 30; i++) await ui.press(PAGE_UP);
    mark = ui.mark();
    await ui.press('\x1b[6~');
    await ui.waitFor('below', mark);
    expect(below(ui.since(mark))).toBe((top as number) - 6);
  });
});
