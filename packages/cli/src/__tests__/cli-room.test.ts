import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import React from 'react';
import { render } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliRunner, RunCommandOptions, RunCommandResult } from '@dalang/core';
import { startDalangServer } from '@dalang/server';
import { resolveCliCommand } from '../cli.js';
import { RoomApiClient, probeServerHealth } from '../tui/client.js';
import { KAYON_ICON } from '../tui/icon.js';
import {
  applyComposerCompletion,
  getComposerCompletions,
  parseSlashCommand,
  popupWindowStart,
  relativeTime,
  resolveComposerSubmit,
  resumableSessions,
  SLASH_COMMANDS,
} from '../tui/commands.js';
import {
  detectPendingGate,
  extractActivityPreview,
  formatProviderStats,
  formatRoomMessage,
  providerStatChips,
  stripControl,
  wrapTimelineLine,
} from '../tui/format.js';
import { RoomApp } from '../tui/RoomApp.js';

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!().catch(() => undefined);
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('CLI command routing (v0.12)', () => {
  it('opens terminal room on bare `dalang` in a TTY and falls back to web when non-TTY', () => {
    expect(resolveCliCommand([], { isTTY: true, envPort: '4173' })).toEqual({
      kind: 'room',
      port: 4173,
    });
    expect(resolveCliCommand([], { isTTY: false, envPort: '4173' })).toEqual({
      kind: 'web',
      port: 4173,
      shouldOpen: true,
      deprecated: false,
    });
  });

  it('handles `dalang web` and deprecated bare web flags', () => {
    expect(resolveCliCommand(['web', '--port', '4390', '--no-open'], { isTTY: true })).toEqual({
      kind: 'web',
      port: 4390,
      shouldOpen: false,
      deprecated: false,
    });
    expect(resolveCliCommand(['--port', '4390'], { isTTY: true })).toEqual({
      kind: 'web',
      port: 4390,
      shouldOpen: true,
      deprecated: true,
    });
    expect(resolveCliCommand(['--no-open'], { isTTY: true })).toEqual({
      kind: 'web',
      port: 4173,
      shouldOpen: false,
      deprecated: true,
    });
  });
});

describe('TUI commands, completions, and formatting', () => {
  it('parses slash commands and provides @profile and /command completions', () => {
    expect(parseSlashCommand('/mode quick')).toEqual({
      name: 'mode',
      args: ['quick'],
      rawArgs: 'quick',
    });
    expect(parseSlashCommand('/reject T-001 fix edge case --requeue')).toEqual({
      name: 'reject',
      args: ['T-001', 'fix', 'edge', 'case', '--requeue'],
      rawArgs: 'T-001 fix edge case --requeue',
    });
    expect(parseSlashCommand('hello lead')).toBeNull();

    const profiles = [
      {
        id: 'profile-lead',
        name: 'lead',
        provider: 'claude-code' as const,
        model: '',
        effort: 'high' as const,
        rolePrompt: '',
        permissionMode: 'workspace-write' as const,
        timeoutMs: 1000,
        idleTimeoutMs: 1000,
        maxParallel: 1,
        maxReviewRounds: 2,
        fallback: null,
        configDir: null,
        isDefault: true,
        createdAt: '',
      },
      {
        id: 'profile-reviewer',
        name: 'reviewer',
        provider: 'codex' as const,
        model: '',
        effort: 'high' as const,
        rolePrompt: '',
        permissionMode: 'read-only' as const,
        timeoutMs: 1000,
        idleTimeoutMs: 1000,
        maxParallel: 1,
        maxReviewRounds: 2,
        fallback: null,
        configDir: null,
        isDefault: true,
        createdAt: '',
      },
      {
        id: 'profile-coder-small',
        name: 'coder-small',
        provider: 'claude-code' as const,
        model: '',
        effort: 'low' as const,
        rolePrompt: '',
        permissionMode: 'workspace-write' as const,
        timeoutMs: 1000,
        idleTimeoutMs: 1000,
        maxParallel: 1,
        maxReviewRounds: 2,
        fallback: null,
        configDir: null,
        isDefault: true,
        createdAt: '',
      },
    ];

    const slashMatches = getComposerCompletions('/m', profiles, new Set());
    expect(slashMatches.map((c) => c.value)).toEqual(['/mode', '/model', '/merge']);
    expect(applyComposerCompletion('/m', '/mode')).toBe('/mode ');

    const mentionMatches = getComposerCompletions('@cod', profiles, new Set(['coder-small']));
    expect(mentionMatches.map((c) => c.value)).toEqual(['@coder', '@coder-small']);
    expect(mentionMatches[1]?.detail).toContain('steer');
    expect(applyComposerCompletion('@cod', '@coder-small')).toBe('@coder-small ');

    const revMatches = getComposerCompletions('@rev', profiles, new Set());
    expect(revMatches[0]?.value).toBe('@reviewer');
    expect(revMatches[0]?.detail).toContain('idle');
  });

  it('formats room report messages and extracts concise activity previews', () => {
    const formatted = formatRoomMessage({
      id: 'm1',
      sessionId: 's1',
      role: 'agent',
      type: 'report',
      kind: 'report',
      authorProfileId: 'profile-coder-small',
      authorProfileName: 'coder-small',
      content: {
        event: 'task_finished',
        summary: 'Finished [T-001]: Added greeting',
        diffStats: { filesChanged: 1, insertions: 3, deletions: 0 },
      },
      createdAt: '2026-11-24T07:00:00.000Z',
    });
    expect(formatted.author).toBe('@coder-small');
    expect(formatted.badge).toBe('TASK FINISHED');
    expect(formatted.lines.join('\n')).toContain('+3 -0');

    expect(extractActivityPreview('[dalang] Running verify command: pnpm test')).toBe(
      'Running verification',
    );
    expect(
      extractActivityPreview(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Read' }] },
        }),
      ),
    ).toBe('Reading files');
    expect(extractActivityPreview('{"type":"item.started","item":{"type":"command_execution","command":"private"}}'))
      .toBe('Running a command');
    expect(extractActivityPreview('{"event":"step_update","step_update":{"step_type":"tool","state":"ACTIVE","tool_name":"grep_search"}}'))
      .toBe('Searching files');
    expect(extractActivityPreview('{"type":"item.completed","item":{"type":"reasoning","text":"private"}}'))
      .toBe('Thinking');
    expect(detectPendingGate(null, null)).toBeNull();
  });

  it('acts on the highlighted item when Enter is pressed with the popup open', () => {
    const slash = getComposerCompletions('/', [], new Set());
    const exitIdx = slash.findIndex((c) => c.value === '/exit');
    expect(exitIdx).toBeGreaterThanOrEqual(0);
    expect(resolveComposerSubmit('/', slash, exitIdx)).toEqual({ action: 'run', text: '/exit' });
    expect(resolveComposerSubmit('/', slash, 1)).toEqual({ action: 'run', text: slash[1].value });
    // A command with arguments, or plain text, is sent as typed.
    expect(resolveComposerSubmit('/project open .', [], 0)).toEqual({ action: 'send', text: '/project open .' });
    expect(resolveComposerSubmit('fix the bug', [], 0)).toEqual({ action: 'send', text: 'fix the bug' });
    // A mention only fills in: it still needs a message.
    const profiles = [{ id: 'profile-reviewer', name: 'reviewer', provider: 'codex' }] as never;
    const mention = getComposerCompletions('@', profiles, new Set());
    expect(resolveComposerSubmit('@', mention, 0)).toEqual({ action: 'fill', text: '@reviewer ' });
  });

  it('lists earlier sessions for /resume and runs the highlighted one on Enter', () => {
    const base = { projectId: 'p', phase: 'idle', provider: 'claude-code', model: null } as const;
    const mk = (id: string, title: string, updatedAt: string, extra: object = {}) =>
      ({ ...base, id, title, mode: 'quick', workState: 'idle', archivedAt: null, updatedAt, ...extra }) as never;
    const sessions = [
      mk('aaa111', 'Old fix', '2026-11-20T10:00:00.000Z'),
      mk('bbb222', 'Newest chat', '2026-11-24T10:00:00.000Z', { workState: 'working' }),
      mk('ccc333', 'Archived one', '2026-11-25T10:00:00.000Z', { archivedAt: '2026-11-25T11:00:00.000Z' }),
    ];
    expect(resumableSessions(sessions).map((x) => x.id)).toEqual(['bbb222', 'aaa111']);

    const all = getComposerCompletions('/resume ', [], new Set(), sessions);
    expect(all.map((c) => c.value)).toEqual(['/resume bbb222', '/resume aaa111']);
    expect(all[0].label).toBe('1. Newest chat');
    expect(all[0].detail).toContain('working');
    expect(getComposerCompletions('/resume old', [], new Set(), sessions).map((c) => c.value)).toEqual([
      '/resume aaa111',
    ]);
    expect(getComposerCompletions('/resume 2', [], new Set(), sessions).map((c) => c.value)).toEqual([
      '/resume aaa111',
    ]);
    expect(getComposerCompletions('/resume zzz', [], new Set(), sessions)).toEqual([]);

    // Enter on the highlighted session runs the full command; with no match the text is sent as typed.
    expect(resolveComposerSubmit('/resume ', all, 1)).toEqual({ action: 'run', text: '/resume aaa111' });
    expect(resolveComposerSubmit('/resume zzz', [], 0)).toEqual({ action: 'send', text: '/resume zzz' });
    expect(SLASH_COMMANDS.map((c) => c.name)).toEqual(expect.arrayContaining(['new', 'resume']));
    expect(SLASH_COMMANDS.map((c) => c.name)).not.toContain('sessions');
  });

  it('formats relative times', () => {
    const now = Date.parse('2026-11-24T12:00:00.000Z');
    expect(relativeTime('2026-11-24T11:59:40.000Z', now)).toBe('just now');
    expect(relativeTime('2026-11-24T11:25:00.000Z', now)).toBe('35m ago');
    expect(relativeTime('2026-11-24T09:00:00.000Z', now)).toBe('3h ago');
    expect(relativeTime('2026-11-22T12:00:00.000Z', now)).toBe('2d ago');
  });

  it('builds provider quick stats like the web usage bar', () => {
    const win = (window: string, remainingPercent: number | null, usedPercent: number | null, group = 'all') => ({
      group,
      window,
      label: window,
      usedPercent,
      remainingPercent,
      resetsAt: null,
    });
    const status = (id: string, over: object) =>
      ({
        id,
        displayName: id,
        installed: true,
        loggedIn: true,
        usage: { available: true, windows: [] },
        ...over,
      }) as never;
    const chips = providerStatChips([
      status('claude-code', {
        usage: {
          available: true,
          // the tightest window of each kind wins; used percent is turned into percent left
          windows: [win('5h', 80, null, 'a'), win('5h', 62, null, 'b'), win('weekly', null, 55)],
        },
      }),
      status('codex', { loggedIn: false }),
      status('antigravity', { usage: { available: false, windows: [] } }),
      status('other', { installed: false }),
    ]);
    expect(chips.map((c) => [c.name, c.state, c.fiveHour, c.weekly])).toEqual([
      ['claude', 'ok', 62, 45],
      ['codex', 'login', null, null],
      ['agy', 'unavailable', null, null],
    ]);
    expect(formatProviderStats(chips)).toBe('claude 5h 62% wk 45%  ·  codex login needed  ·  agy limits n/a');
  });

  it('removes terminal control codes from server and agent text', () => {
    const evil = 'ok\x1b[2J\x1b[31mred\x1b]0;title\x07 end\x00\x1b[?1049h';
    expect(stripControl(evil)).toBe('okred end');
    expect(stripControl('a\tb\nc')).toBe('a\tb\nc');
    expect(extractActivityPreview('[dalang] run \x1b[2Jdone')).toBeNull();
    const msg = formatRoomMessage({
      id: 'm',
      sessionId: 's',
      role: 'agent',
      type: 'report',
      authorProfileName: 'bad\x1b[1mname',
      content: { event: 'task_finished', summary: 'x\x1b[2Jy' },
      createdAt: '2026-11-24T07:00:00.000Z',
    } as never);
    expect(msg.author).toBe('@badname');
    expect(msg.lines.join('')).not.toContain('\x1b');
  });

  it('has /exit and no /quit', () => {
    expect(SLASH_COMMANDS.map((c) => c.name)).toContain('exit');
    expect(SLASH_COMMANDS.map((c) => c.name)).not.toContain('quit');
  });

  it('keeps the selected completion inside the visible popup window', () => {
    expect(popupWindowStart(0, 12, 6)).toBe(0);
    expect(popupWindowStart(5, 12, 6)).toBe(0);
    expect(popupWindowStart(6, 12, 6)).toBe(1);
    expect(popupWindowStart(11, 12, 6)).toBe(6);
    expect(popupWindowStart(3, 4, 6)).toBe(0);
    expect(getComposerCompletions('/ex', [], new Set()).map((c) => c.value)).toEqual(['/exit']);
    expect(parseSlashCommand('/exit')?.name).toBe('exit');
    for (let sel = 0; sel < 12; sel++) {
      const start = popupWindowStart(sel, 12, 6);
      expect(sel >= start && sel < start + 6).toBe(true);
    }
  });

  it('wraps long timeline lines into rows instead of cutting them off', () => {
    const long = '  ' + 'word '.repeat(30).trim();
    const rows = wrapTimelineLine(long, 40);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((r) => Array.from(r).length <= 40)).toBe(true);
    expect(rows.every((r) => r.startsWith('  '))).toBe(true);
    expect(rows.map((r) => r.trim()).join(' ')).toBe(long.trim());

    const unbroken = 'x'.repeat(95);
    const hard = wrapTimelineLine(unbroken, 40);
    expect(hard.join('')).toBe(unbroken);
    expect(wrapTimelineLine('short', 40)).toEqual(['short']);
  });
});

describe('Ink terminal room E2E (Quick task from plan to merge with no browser)', () => {
  it('runs a Quick task end-to-end inside RoomApp and merges into main', async () => {
    const dbDir = mkTmp('dalang-tui-db-');
    const repoDir = mkTmp('dalang-tui-repo-');

    const runner: CliRunner = {
      async which(binary: string) {
        if (['claude', 'codex', 'agy', 'bwrap'].includes(binary)) return `/usr/bin/${binary}`;
        return null;
      },
      async run(command: string, args: string[], opts: RunCommandOptions): Promise<RunCommandResult> {
        if (command === '/bin/sh' || command.endsWith('/sh') || args.includes('/bin/sh')) {
          return { exitCode: 0, stdout: 'verified\n', stderr: '', timedOut: false, idleTimedOut: false };
        }
        const invoked =
          command === '/usr/bin/bwrap'
            ? (args.find((a) => /\/(claude|codex|agy)$/.test(a)) ?? command)
            : command;
        const prompt = [opts.stdinData ?? '', ...args].join('\n');
        const emit = (stdout: string): RunCommandResult => {
          if (opts.onStdoutLine) {
            for (const line of stdout.split('\n')) {
              if (line.trim()) opts.onStdoutLine(line);
            }
          }
          return { exitCode: 0, stdout, stderr: '', timedOut: false, idleTimedOut: false };
        };

        // Quick plan
        const quickMatch = prompt.match(/Write ONLY the JSON contract to "([^"]+)"/);
        if (quickMatch) {
          const target = path.join(opts.cwd, quickMatch[1]);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(
            target,
            JSON.stringify({
              verdict: 'ready',
              summary: 'Add greet.txt',
              task: {
                id: 'T-001',
                title: 'Add greet.txt',
                milestone: 'Quick',
                role: 'engineer',
                complexity: 'low',
                depends_on: [],
                goal: 'Write greet.txt',
                files_allowed: ['greet.txt'],
                files_reference: [],
                acceptance_criteria: ['greet.txt exists'],
                verify: 'test -f greet.txt',
                needs_split: false,
              },
            }),
          );
          return emit(JSON.stringify({ type: 'result', session_id: 'lead-1', result: 'ok' }));
        }

        // Reviewer
        if (invoked.endsWith('codex') || args.includes('plan')) {
          const reviewJson = JSON.stringify({
            task_id: 'T-001',
            status: 'pass',
            verify_exit_code: 0,
            summary: 'Clean change',
            findings: [],
          });
          return emit(
            invoked.endsWith('codex')
              ? [
                  JSON.stringify({ type: 'thread.started', thread_id: 'rev-1' }),
                  JSON.stringify({
                    type: 'item.completed',
                    item: { type: 'agent_message', text: reviewJson },
                  }),
                ].join('\n')
              : JSON.stringify({ type: 'result', session_id: 'rev-1', result: reviewJson }),
          );
        }

        // Coder
        const resultMatch =
          prompt.match(/write\s+the\s+JSON\s+result\s+to\s+"([^"]+)"/i) ??
          prompt.match(/(\.dalang\/[^\s"]+result\.json)/);
        if (resultMatch) {
          fs.writeFileSync(path.join(opts.cwd, 'greet.txt'), 'hello from terminal room\n');
          const target = path.join(opts.cwd, resultMatch[1]);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(
            target,
            JSON.stringify({
              task_id: 'T-001',
              status: 'completed',
              changed_files: ['greet.txt'],
              summary: 'Created greet.txt',
              notes: [],
              blockers: [],
            }),
          );
          return emit(JSON.stringify({ type: 'result', session_id: 'coder-1', result: 'ok' }));
        }

        return emit('');
      },
    };

    const server = await startDalangServer({
      port: 0,
      dbPath: path.join(dbDir, 'dalang.db'),
      runner,
      enableScheduler: false,
    });
    cleanups.push(server.close);

    const port = Number(new URL(server.url).port);
    expect(port).toBeGreaterThan(0);

    // Verify health probe attaches cleanly
    const health = await probeServerHealth(port);
    expect(health?.ok).toBe(true);

    const client = new RoomApiClient(port);
    // Configure profiles on server so coder=claude-code, reviewer=codex
    await fetch(`${client.baseUrl}/api/profiles/profile-coder-small`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'claude-code', model: '' }),
    });
    await fetch(`${client.baseUrl}/api/profiles/profile-reviewer`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'codex', model: '' }),
    });
    await client.createOrOpenProject({
      mode: 'create',
      name: 'tui-demo',
      path: repoDir,
      initGitIfMissing: true,
      leadProvider: 'claude-code',
    });

    // Mount Ink RoomApp on virtual TTY streams
    const stdout = new PassThrough();
    Object.assign(stdout, { columns: 110, rows: 32, isTTY: true });
    let screen = '';
    stdout.on('data', (chunk) => {
      screen += chunk.toString('utf8');
    });

    const stdin = new PassThrough();
    Object.assign(stdin, { isTTY: true, setRawMode: () => {} });

    const openedUrls: string[] = [];
    const pagerCalls: string[] = [];

    const inst = render(
      React.createElement(RoomApp, {
        client,
        embedded: false,
        cwd: repoDir,
        openBrowser: (u) => openedUrls.push(u),
        onOpenPager: async (content) => {
          pagerCalls.push(content);
          return { ok: true };
        },
      }),
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
    cleanups.push(async () => {
      inst.unmount();
      stdout.end();
      stdin.end();
      await new Promise((r) => setTimeout(r, 80));
    });

    const waitForText = async (needle: string, timeoutMs = 8000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (screen.includes(needle)) return;
        await new Promise((r) => setTimeout(r, 40));
      }
      throw new Error(`Timed out waiting for "${needle}". Last screen tail:\n${screen.slice(-1200)}`);
    };

    const sendLine = async (line: string) => {
      stdin.write(line);
      await new Promise((r) => setTimeout(r, 30));
      stdin.write('\r');
    };

    await waitForText('tui-demo');

    // Switch to Quick mode, sent as one chunk with its Enter (paste or fast typing)
    stdin.write('/mode quick\r');
    await waitForText('[QUICK]');

    // Ask Lead for a Quick mini-plan
    await sendLine('Add greet.txt');
    await waitForText('Run Quick task [T-001]');

    // Answer y/n gate to run the Quick task
    await sendLine('y');
    await waitForText('Merge [T-001]');

    // Inspect diff via /diff (opens $PAGER callback)
    await sendLine('/diff');
    await waitForText('Closed diff for [T-001]');
    expect(pagerCalls.length).toBe(1);
    expect(pagerCalls[0]).toContain('greet.txt');

    // Pick /web from the popup with arrow keys and Enter, without typing the full name
    const webIdx = SLASH_COMMANDS.findIndex((c) => c.name === 'web');
    stdin.write('/');
    await new Promise((r) => setTimeout(r, 60));
    for (let i = 0; i < webIdx; i++) {
      stdin.write('\x1b[B');
      await new Promise((r) => setTimeout(r, 30));
    }
    stdin.write('\r');
    await waitForText('Opened web UI');
    expect(openedUrls[0]).toContain(`http://127.0.0.1:${port}/?project=`);

    // `n` declines for now and keeps the task waiting (no reject)
    await sendLine('n');
    await waitForText('stays waiting for merge');
    expect(fs.existsSync(path.join(repoDir, 'greet.txt'))).toBe(false);

    // Answer y/n gate to merge into main
    await sendLine('y');
    await waitForText('Merged [T-001]');

    // Verify merged file exists on main branch!
    expect(fs.existsSync(path.join(repoDir, 'greet.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(repoDir, 'greet.txt'), 'utf8')).toContain('hello from terminal room');

    // A second room on the same server opens on a NEW session, not the one just finished.
    const stdout2 = new PassThrough();
    Object.assign(stdout2, { columns: 110, rows: 32, isTTY: true });
    let screen2 = '';
    stdout2.on('data', (chunk) => {
      screen2 += chunk.toString('utf8');
    });
    const stdin2 = new PassThrough();
    Object.assign(stdin2, { isTTY: true, setRawMode: () => {} });
    const inst2 = render(
      React.createElement(RoomApp, {
        client,
        embedded: false,
        cwd: repoDir,
        openBrowser: () => {},
        onOpenPager: async () => ({ ok: true }),
      }),
      {
        stdout: stdout2 as unknown as NodeJS.WriteStream,
        stdin: stdin2 as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
    cleanups.push(async () => {
      inst2.unmount();
      stdout2.end();
      stdin2.end();
      await new Promise((r) => setTimeout(r, 80));
    });
    const waitFor2 = async (needle: string, timeoutMs = 8000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (screen2.includes(needle)) return;
        await new Promise((r) => setTimeout(r, 40));
      }
      throw new Error(`Timed out waiting for "${needle}". Last screen tail:\n${screen2.slice(-1200)}`);
    };

    await waitFor2('new chat');
    await waitFor2('New session.');
    await waitFor2('/resume continues one of 1 earlier session(s)');
    for (const row of KAYON_ICON) expect(screen2).toContain(row); // the Gunungan in the header
    expect(screen2).not.toContain('Add greet.txt');

    // /resume opens the picker; Enter on the highlighted session brings it back.
    stdin2.write('/resume\r');
    await waitFor2('1. ');
    stdin2.write('\r');
    await waitFor2('Resumed');
    await waitFor2('Add greet.txt');
  });
});
