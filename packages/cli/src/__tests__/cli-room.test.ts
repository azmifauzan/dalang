import { markdownRows } from '../tui/markdown.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import React from 'react';
import { render } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliRunner, RunCommandOptions, RunCommandResult } from '@dalang/core';
import { liveReplyText, parseLiveReply } from '@dalang/shared';
import { createDalangServer, startDalangServer } from '@dalang/server';
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
  gateContextLimit,
  gateContextRows,
  providerStatChips,
  stripControl,
  wrapTimelineLine,
} from '../tui/format.js';
import { RoomApp } from '../tui/RoomApp.js';
import { ROLE_LABEL } from '../tui/team.js';
import { waitingForReply } from '../tui/title.js';
import type { DiscussMessageDTO } from '@dalang/shared';

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
  it('detects structured and conversational questions until the user replies', () => {
    const question = { role: 'lead', type: 'questions', content: { questions: [{ question: 'Which one?' }] } };
    const report = { role: 'system', type: 'text', content: 'Status updated' };
    const answer = { role: 'user', type: 'text', content: 'The first one' };
    expect(waitingForReply([question, report] as DiscussMessageDTO[])).toBe(true);
    expect(waitingForReply([question, answer] as DiscussMessageDTO[])).toBe(false);
    expect(waitingForReply([{ role: 'agent', type: 'ask', content: { text: 'Which file?' } }] as DiscussMessageDTO[])).toBe(true);
    expect(waitingForReply([{ role: 'lead', type: 'ask', content: { text: 'Done.' } }] as DiscussMessageDTO[])).toBe(false);
  });

  it('reads the answer out of a JSON reply that is still being written', () => {
    expect(liveReplyText('Plain **text**')).toBe('Plain **text**');
    expect(liveReplyText('```json\n{\"answer\": \"Halo\\nsemua')).toBe('Halo\nsemua');
    expect(liveReplyText('```js')).toBe('');
    expect(liveReplyText('{"suggested_mode": null, "ans')).toBe('');
    expect(liveReplyText('{"answer": "Line one\\nLine \\"two\\" \\u00e9')).toBe('Line one\nLine "two" é');
    // An escape cut off at the end of a batch waits for the next one.
    expect(liveReplyText('{"answer": "a\\')).toBe('a');
    expect(liveReplyText('{"answer": "a\\u00')).toBe('a');
    expect(liveReplyText('{"answer": "done", "suggested_mode": "quick"}')).toBe('done');
  });

  it('separates progress from plain and fenced JSON replies (R8/B7)', () => {
    // Regression: progress before plain JSON must not cause liveReplyText to dump raw JSON.
    const plainJsonIncomplete = 'Saya cek dulu isi repositori.\n\n{"suggested_mode": null, "ans';
    expect(parseLiveReply(plainJsonIncomplete)).toEqual({
      progress: 'Saya cek dulu isi repositori.',
      answer: '',
    });
    expect(liveReplyText(plainJsonIncomplete)).toBe('');

    const plainJsonStreaming =
      'Saya cek dulu isi repositori.\n\n{"auto_plan": {"summary": "Ignore \\"answer\\": \\"fake\\""}, "answer": "Baris **satu**\\nBaris \\"dua\\" \\u00e9';
    expect(parseLiveReply(plainJsonStreaming)).toEqual({
      progress: 'Saya cek dulu isi repositori.',
      answer: 'Baris **satu**\nBaris "dua" é',
    });
    expect(liveReplyText(plainJsonStreaming)).toBe('Baris **satu**\nBaris "dua" é');

    // Same-line progress before plain JSON.
    expect(parseLiveReply('Checking files... {"answer": "All good"}')).toEqual({
      progress: 'Checking files...',
      answer: 'All good',
    });
    expect(liveReplyText('Checking files... {"answer": "All good"}')).toBe('All good');

    // Regression: progress before fenced JSON (incomplete fence markers and incomplete JSON stay hidden).
    for (const prefix of ['```', '```j', '```js', '```json', '```json\n', '```json\n{', '```json\n{"suggested_mode": null, "ans']) {
      const sample = `Membaca berkas...\n\n${prefix}`;
      expect(parseLiveReply(sample)).toEqual({
        progress: 'Membaca berkas...',
        answer: '',
      });
      expect(liveReplyText(sample)).toBe('');
    }

    const fencedJsonComplete =
      'Membaca berkas...\n\n```json\n{"answer": "Selesai **cek**\\n```ts\\nconst ok = true;\\n```", "suggested_mode": "quick"}\n```';
    expect(parseLiveReply(fencedJsonComplete)).toEqual({
      progress: 'Membaca berkas...',
      answer: 'Selesai **cek**\n```ts\nconst ok = true;\n```',
    });
    expect(liveReplyText(fencedJsonComplete)).toBe('Selesai **cek**\n```ts\nconst ok = true;\n```');

    // Bare fence after progress.
    expect(parseLiveReply('Membaca berkas...\n```\n{"answer": "Siap"}\n```')).toEqual({
      progress: 'Membaca berkas...',
      answer: 'Siap',
    });

    // Plain Markdown and escapes stay untouched when there is no reply JSON contract.
    const markdownWithEscapes =
      'Ringkasan \\*penting\\* dan \\\\backslash\\\\\n\nGunakan `{"answer": "inline"}` atau:\n```ts\nconst sample = {"answer": "not a reply"};\n```';
    expect(parseLiveReply(markdownWithEscapes)).toEqual({
      progress: '',
      answer: markdownWithEscapes,
    });
    expect(liveReplyText(markdownWithEscapes)).toBe(markdownWithEscapes);

    // A complete non-contract JSON snippet in Markdown is preserved as plain Markdown.
    const markdownJsonSnippet = 'Contoh package.json:\n\n```json\n{"name": "dalang"}\n```\n\nSelesai.';
    expect(parseLiveReply(markdownJsonSnippet)).toEqual({
      progress: '',
      answer: markdownJsonSnippet,
    });

    // Incremental streaming fixture: incomplete JSON never leaks into `answer`.
    const chunks = [
      'Cek repo...\n\n',
      '```j',
      'son\n',
      '{"auto_plan": ',
      'null, "ans',
      'wer": "Halo\\',
      'n**dunia**',
      ' \\u00e9',
      '"}\n```',
    ];
    let joined = '';
    const snapshots = chunks.map((chunk) => {
      joined += chunk;
      return parseLiveReply(joined);
    });
    expect(snapshots[0]).toEqual({ progress: '', answer: 'Cek repo...\n\n' });
    expect(snapshots[1]).toEqual({ progress: 'Cek repo...', answer: '' });
    expect(snapshots[2]).toEqual({ progress: 'Cek repo...', answer: '' });
    expect(snapshots[3]).toEqual({ progress: 'Cek repo...', answer: '' });
    expect(snapshots[4]).toEqual({ progress: 'Cek repo...', answer: '' });
    expect(snapshots[5]).toEqual({ progress: 'Cek repo...', answer: 'Halo' });
    expect(snapshots[6]).toEqual({ progress: 'Cek repo...', answer: 'Halo\n**dunia**' });
    expect(snapshots[7]).toEqual({ progress: 'Cek repo...', answer: 'Halo\n**dunia** é' });
    expect(snapshots[8]).toEqual({ progress: 'Cek repo...', answer: 'Halo\n**dunia** é' });
  });

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
        name: 'executor-light',
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
    expect(slashMatches.map((c) => c.value)).toEqual(['/mouse', '/mode', '/model', '/merge']);
    expect(applyComposerCompletion('/m', '/mode')).toBe('/mode ');

    const mentionMatches = getComposerCompletions('@exec', profiles, new Set(['executor-light']));
    expect(mentionMatches.map((c) => c.value)).toEqual(['@executor', '@executor-light']);
    expect(mentionMatches[1]?.detail).toContain('steer');
    expect(applyComposerCompletion('@exec', '@executor-light')).toBe('@executor-light ');

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
      authorProfileName: 'executor-light',
      content: {
        event: 'task_finished',
        summary: 'Finished [T-001]: Added greeting',
        diffStats: { filesChanged: 1, insertions: 3, deletions: 0 },
      },
      createdAt: '2026-11-24T07:00:00.000Z',
    });
    expect(formatted.author).toBe('@executor-light');
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

  it('expands tabs and splits multi-line report summaries into timeline rows', () => {
    const msg = formatRoomMessage({
      id: 'm',
      sessionId: 's',
      role: 'system',
      type: 'report',
      content: { event: 'run_stopped', summary: 'Run stopped: 1 of 2 task(s) done.\n\tWaiting: b.' },
      createdAt: '2026-11-26T07:00:00.000Z',
    } as never);
    expect(msg.badge).toBe('RUN STOPPED');
    const question = formatRoomMessage({
      id: 'q', sessionId: 's', role: 'lead', type: 'ask',
      content: { text: 'Replace the plan? Reply yes or no.', suggestion: null, pendingAutoWork: {} },
      createdAt: '2026-11-26T07:00:00.000Z',
    } as never);
    expect(question.badge).toBe('QUESTION');
    expect(msg.lines).toEqual(['Run stopped: 1 of 2 task(s) done.', '    Waiting: b.']);
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
    // The merge gate says what it needs, why the task is ready, and what each key does.
    await waitForText('NEEDS YOUR APPROVAL');
    await waitForText('Review round 1 passed');
    await waitForText('+ Enter: merge');

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

  it('uses Executor/Checker labels, supports /accept and @executor/@checker, and formats answer tasks & skipped verify', () => {
    for (const label of Object.values(ROLE_LABEL)) {
      expect(label).not.toMatch(/\b(Coder|QA)\b/);
    }
    expect(ROLE_LABEL.coderLight).toContain('Executor');
    expect(ROLE_LABEL.qa).toBe('Checker (Srikandi)');
    expect(SLASH_COMMANDS.some((c) => c.name === 'accept')).toBe(true);

    const profiles = [
      { id: 'profile-coder-small', name: 'executor-light', provider: 'codex' },
      { id: 'profile-qa', name: 'qa', provider: 'claude-code' },
    ] as never;
    expect(getComposerCompletions('@ex', profiles, new Set(['executor-light'])).map((c) => c.value)).toContain('@executor');
    expect(getComposerCompletions('@ch', profiles, new Set()).map((c) => c.value)).toContain('@checker');

    const gate = detectPendingGate(
      {
        session: { id: 's1', mode: 'quick', workState: 'working', phase: 'run' },
        messages: [],
        currentRound: 0,
        briefs: [],
        plan: null,
      } as never,
      {
        projectId: 'p1',
        sessionId: 's1',
        mainBranch: 'main',
        integrationCommand: null,
        detectedIntegrationCommand: null,
        gitRemote: null,
        pushAfterMerge: false,
        createPrAfterMerge: false,
        ghAvailable: false,
        sandboxReady: true,
        sandboxEngine: 'bwrap',
        platform: 'linux',
        tasks: [
          {
            task: {
              id: 't1',
              planId: 'p1',
              externalId: 'T-001',
              title: 'Summarize notes',
              milestone: 'M1',
              role: 'engineer',
              complexity: 'low',
              output: 'answer',
              status: 'awaiting_merge',
              position: 0,
              goal: 'Summarize',
              filesAllowed: [],
              filesReference: [],
              acceptanceCriteria: ['Clear'],
              verify: null,
              needsSplit: false,
              splitDepth: 0,
              parentTaskId: null,
              delegatedByRunId: null,
              delegationDepth: 0,
              mergeTargetBranch: null,
              profileOverride: null,
              reviewRounds: 1,
              branchName: null,
              mergeCommitSha: null,
              rejectionNote: null,
              prUrl: null,
              pushedAt: null,
              dependsOn: [],
              createdAt: '',
              updatedAt: '',
            },
            reviews: [],
            latestReview: null,
            latestRun: null,
            canApproveMerge: true,
            canReject: true,
            diffAvailable: true,
            answer: '# Summary\nAll good.',
            answerPath: '.dalang/tasks/T-001/answer.md',
          },
        ],
        integrationRuns: [],
      },
    );
    expect(gate?.kind).toBe('approve_merge');
    if (gate?.kind === 'approve_merge') {
      expect(gate.output).toBe('answer');
    }
    expect(gate?.prompt).toContain('Accept answer [T-001]');
    expect(gate?.prompt).not.toContain('Merge [T-001]');
    expect(gate?.yes).toBe('accept');
    expect(gate?.no).toContain('/diff T-001');
    expect(gate?.context).toBeUndefined();
    expect(gate?.alsoWaiting).toBe(0);

    // The finding count comes from the room's verdict report when the review file is not readable.
    const counted = detectPendingGate(
      {
        session: { id: 's1', mode: 'auto' },
        messages: [{
          id: 'r', sessionId: 's1', role: 'agent', type: 'report', createdAt: '',
          content: { event: 'review_verdict', taskId: 't1', reviewRound: 2, findingsCount: 1, summary: '' },
        }],
        briefs: [],
        plan: null,
      } as never,
      {
        mainBranch: 'main',
        tasks: [{
          task: { id: 't1', externalId: 'T-001', title: 'Fix', status: 'awaiting_merge', output: 'files' },
          latestReview: {
            round: 2, status: 'pass', reviewerProfileName: 'reviewer', verifyExitCode: 0, scopeWarnings: [],
            contract: { findings: [] },
          },
          canApproveMerge: true,
        }],
      } as never,
    );
    expect(counted?.context).toBe('Review round 2 passed (1 finding(s), reviewer) · verify passed');

    // An Auto plan of two or more tasks is listed with order and executors, and waits for approval.
    const proposed = formatRoomMessage({
      id: 'p', sessionId: 's1', role: 'lead', type: 'plan', createdAt: '',
      content: {
        version: 2, taskCount: 2, awaitingApproval: true,
        tasks: [
          { id: 'a', title: 'First', role: 'engineer', complexity: 'low', dependsOn: [], executor: 'executor-light · antigravity · gemini-4-hydrogen' },
          { id: 'b', title: 'Second', role: 'engineer', complexity: 'high', dependsOn: ['a'], executor: 'executor-heavy · claude-code · opus' },
        ],
      },
    } as never);
    expect(proposed.lines).toEqual([
      'Proposed plan: 2 task(s). Nothing runs until you approve it.',
      '  [a] First (executor · low)',
      '      executor: executor-light · antigravity · gemini-4-hydrogen',
      '  [b] Second (executor · high)',
      '      executor: executor-heavy · claude-code · opus',
      '      after: a',
    ]);
    const planGate = detectPendingGate(
      {
        session: { id: 's1', mode: 'auto' },
        messages: [],
        briefs: [],
        plan: { version: 2, status: 'draft', tasks: [{ needsSplit: false }, { needsSplit: false }] },
      } as never,
      null,
    );
    expect(planGate?.kind).toBe('approve_plan');
    expect(planGate?.prompt).toBe('Approve Plan v2 (2 task(s)) and start work?');
    expect(planGate?.no).toContain('send a message to change it');

    // A multi-line finding becomes one entry per row (B26): the room sizes the screen by these entries.
    const multiline = formatRoomMessage({
      id: 'ml', sessionId: 's1', role: 'agent', type: 'report', createdAt: '',
      content: {
        event: 'review_verdict', summary: 'Review round 1: FAIL\n**Earlier findings:**',
        findings: [{ severity: 'major', file: 'a.php', note: '**Problem:** one range.\r\n\n**When it happens:**\n\tevery load' }],
      },
    } as never);
    expect(multiline.lines.filter((line) => /[\r\n\t]/.test(line))).toEqual([]);
    expect(multiline.lines).toContain('**When it happens:**');

    // A question's context is drawn as counted rows: line breaks split, long text wraps, the rest is cut with a note.
    expect(gateContextRows('one\n\ntwo', 80)).toEqual(['one', 'two']);
    const long = gateContextRows(`Command: ${'word '.repeat(300)}\nWarning: secrets`, 80);
    expect(long).toHaveLength(8);
    expect(long.at(-1)).toMatch(/more line\(s\)/);
    expect(long.every((row) => !row.includes('\n') && row.length <= 80)).toBe(true);
    // On a short terminal the question gets only what the screen has left, so the composer stays whole.
    expect(gateContextLimit(23, 0)).toBe(2);
    expect(gateContextLimit(35, 0)).toBe(8);
    expect(gateContextLimit(12, 4)).toBe(1);

    // An undecided worktree setup is asked before the plan is approved (U11).
    const setupGate = detectPendingGate(
      { session: { id: 's1', mode: 'auto' }, messages: [], briefs: [], plan: { version: 1, status: 'draft', tasks: [{ needsSplit: false }] } } as never,
      null,
      { approved: null, needsApproval: true, warnings: [], hasSnapshot: false, proposal: { command: 'composer install', maintenanceCommand: null, source: 'composer.lock', files: ['.env'], warnings: ['.env may hold secrets'] } },
    );
    expect(setupGate).toMatchObject({ kind: 'workspace_setup', command: 'composer install', files: ['.env'] });
    expect(setupGate?.context).toContain('Warning: .env may hold secrets');

    // Antigravity's own events name what the agent is doing, instead of the last DALANG line.
    expect(extractActivityPreview('{"sessionUpdate":"tool_call","name":"run_command","args":{"CommandLine":"php artisan migrate --force"}}')).toBe('Running: php artisan migrate --force');
    expect(extractActivityPreview('{"sessionUpdate":"tool_call_update","name":"read_file","args":{"Path":"/w/app/Http/Index.php"}}')).toBe('Reading files: Http/Index.php');
    expect(extractActivityPreview('{"sessionUpdate":"agent_thought_chunk"}')).toBe('Thinking');

    // A task that failed its last review can continue on its work; one waiting on it cannot yet (U7).
    const stuck = (id: string, status: string, dependsOn: string[]) =>
      ({ id, externalId: id, status, dependsOn, delegationDepth: 0, branchName: `dalang/${id}`, rejectionNote: 'One finding left', needsSplit: false });
    const continueGate = detectPendingGate(
      {
        session: { id: 's1', mode: 'auto' },
        messages: [],
        briefs: [],
        plan: { version: 1, status: 'approved', tasks: [stuck('T-002', 'stopped', ['T-001']), stuck('T-001', 'review_failed', [])] },
      } as never,
      null,
    );
    expect(continueGate).toMatchObject({ kind: 'continue_task', taskId: 'T-001', context: 'One finding left', alsoWaiting: 0 });

    // It is not asked while its files overlap a running task: answering would fail and ask again.
    const overlapping = {
      session: { id: 's1', mode: 'auto' }, messages: [], briefs: [],
      plan: { version: 1, status: 'approved', tasks: [stuck('T-001', 'stopped', []), stuck('T-003', 'running', [])] },
    } as never;
    const previews = { dispatchPreviews: [{ taskId: 'T-001', overlappingTasks: ['T-003'] }] } as never;
    expect(detectPendingGate(overlapping, null, null, previews)).toBeNull();
    expect(detectPendingGate(overlapping, null, null, { dispatchPreviews: [{ taskId: 'T-001', overlappingTasks: [] }] } as never)?.kind).toBe('continue_task');

    // A reviewer's Markdown is rendered, and its single line breaks stay; command reports stay as typed.
    const verdict = formatRoomMessage({ id: 'v', sessionId: 's1', role: 'agent', type: 'report', createdAt: '', content: { event: 'review_verdict', summary: '**Fix:** done\n- one `a`\nplain line' } } as never);
    expect(verdict).toMatchObject({ markdown: true, keepBreaks: true });
    const rows = markdownRows(verdict.lines.join('\n'), 80, true).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    expect(rows).not.toContain('**');
    expect(rows).toContain('Fix: done');
    expect(markdownRows('first line\nsecond line', 80, true)).toHaveLength(2);
    expect(formatRoomMessage({ id: 'c', sessionId: 's1', role: 'agent', type: 'report', createdAt: '', content: { event: 'verify_result', summary: 'pnpm test src/**/*.ts' } } as never).markdown).toBe(false);

    // A failed task that asked for files outside its scope gets an Allow gate.
    const scopeGate = detectPendingGate(
      {
        session: { id: 's1', mode: 'auto' },
        messages: [{
          id: 'sr', sessionId: 's1', role: 'agent', type: 'report', createdAt: '',
          content: { event: 'scope_request', taskId: 't9', needsFiles: ['lib/runner.ts'], summary: '[T-009] needs files outside its scope: lib/runner.ts.' },
        }],
        briefs: [],
        plan: { version: 1, status: 'approved', tasks: [{ id: 't9', externalId: 'T-009', status: 'failed', needsSplit: false }] },
      } as never,
      null,
    );
    expect(scopeGate?.kind).toBe('scope_request');
    expect(scopeGate?.prompt).toBe('Allow [T-009] to also change lib/runner.ts?');
    expect(scopeGate?.yes).toBe('allow and continue the task');

    // The Lead's own yes/no question about replacing this chat's plan gets the same gate box.
    const leadQuestion = detectPendingGate(
      {
        session: { id: 's1', mode: 'auto' },
        messages: [{
          id: 'q', sessionId: 's1', role: 'lead', type: 'ask', createdAt: '',
          content: { text: 'This chat already has a plan...', suggestion: null, pendingAutoWork: { sessionId: 's1' } },
        }],
        briefs: [],
        plan: null,
      } as never,
      null,
    );
    expect(leadQuestion?.kind).toBe('auto_work');
    expect(leadQuestion?.yes).toBe('replace and start');
    expect(leadQuestion?.no).toBe('keep the current work');

    const skippedMsg = formatRoomMessage({
      id: 'm-skip',
      sessionId: 's1',
      role: 'agent',
      type: 'report',
      kind: 'report',
      authorProfileId: 'profile-reviewer',
      authorProfileName: 'reviewer',
      content: {
        event: 'verify_result',
        externalId: 'T-001',
        verifyCommand: null,
        verifyExitCode: null,
        verifySkipped: true,
        summary: 'Verify skipped (no command)',
      },
      createdAt: '2026-11-25T07:00:00.000Z',
    });
    expect(skippedMsg.lines.join('\n')).toContain('skipped');

    const acceptedMsg = formatRoomMessage({
      id: 'm-acc',
      sessionId: 's1',
      role: 'system',
      type: 'report',
      kind: 'report',
      authorProfileId: null,
      authorProfileName: null,
      content: {
        event: 'task_accepted',
        externalId: 'T-001',
        taskTitle: 'Summarize notes',
        output: 'answer',
        answerPath: '.dalang/answers/task-1.md',
        answer: '# Summary\nAll good.',
        summary: 'Accepted answer [T-001] Summarize notes -> .dalang/answers/task-1.md',
      },
      createdAt: '2026-11-25T07:00:00.000Z',
    });
    expect(acceptedMsg.badge).toBe('TASK ACCEPTED');
    expect(acceptedMsg.lines.join('\n')).toContain('All good.');
  });
});

describe('WebSocket reconnect and cleanup (R7)', () => {
  it('uses bounded exponential backoff, resets after open, stops on 4401, and cleans up listeners on unsubscribe', () => {
    const origWebSocket = globalThis.WebSocket;
    const origSetTimeout = globalThis.setTimeout;
    const origClearTimeout = globalThis.clearTimeout;

    type Listener = (ev?: unknown) => void;
    class FakeWebSocket {
      static instances: FakeWebSocket[] = [];
      readonly listeners = new Map<string, Set<Listener>>();
      closed = false;

      constructor(_url: string, _opts?: unknown) {
        FakeWebSocket.instances.push(this);
      }

      addEventListener(type: string, fn: Listener) {
        let set = this.listeners.get(type);
        if (!set) {
          set = new Set();
          this.listeners.set(type, set);
        }
        set.add(fn);
      }

      removeEventListener(type: string, fn: Listener) {
        this.listeners.get(type)?.delete(fn);
      }

      emit(type: string, ev: unknown = {}) {
        for (const fn of Array.from(this.listeners.get(type) ?? [])) {
          fn(ev);
        }
      }

      listenerCount(): number {
        let total = 0;
        for (const set of this.listeners.values()) total += set.size;
        return total;
      }

      close() {
        this.closed = true;
      }
    }

    const scheduledDelays: number[] = [];
    const pendingTimers = new Map<number, () => void>();
    let nextTimerId = 1;

    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.setTimeout = ((fn: () => void, delay?: number) => {
      const id = nextTimerId++;
      scheduledDelays.push(Number(delay ?? 0));
      pendingTimers.set(id, fn);
      return { id, unref() {} } as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout> | undefined) => {
      const id = (handle as unknown as { id?: number } | undefined)?.id;
      if (id !== undefined) pendingTimers.delete(id);
    }) as typeof clearTimeout;

    const flushNextTimer = () => {
      const first = pendingTimers.entries().next().value as [number, () => void] | undefined;
      if (!first) throw new Error('Expected a scheduled reconnect timer');
      pendingTimers.delete(first[0]);
      first[1]();
    };

    try {
      const client = new RoomApiClient(4173);
      const statuses: boolean[] = [];
      const events: string[] = [];

      const unsubscribe = client.connectEvents(
        (ev) => events.push(ev.type),
        (ok) => statuses.push(ok),
        { baseDelayMs: 40, maxDelayMs: 120 },
      );

      // Repeated disconnects increase backoff exponentially and cap at maxDelayMs.
      for (let i = 0; i < 4; i++) {
        const ws = FakeWebSocket.instances[i];
        expect(ws.listenerCount()).toBe(4);
        ws.emit('close', { code: 1006 });
        expect(ws.listenerCount()).toBe(0);
        flushNextTimer();
      }
      expect(scheduledDelays).toEqual([40, 80, 120, 120]);

      // Opening resets backoff back to baseDelayMs.
      const openedWs = FakeWebSocket.instances[4];
      openedWs.emit('open');
      openedWs.emit('message', { data: JSON.stringify({ type: 'plan.updated' }) });
      expect(events).toEqual(['plan.updated']);
      expect(statuses.at(-1)).toBe(true);

      openedWs.emit('close', { code: 1001 });
      expect(scheduledDelays.at(-1)).toBe(40);
      expect(pendingTimers.size).toBe(1);

      // Unsubscribe cancels pending timer, detaches listeners, and prevents further callbacks.
      unsubscribe();
      expect(pendingTimers.size).toBe(0);
      const statusCountAfterUnsub = statuses.length;
      openedWs.emit('message', { data: JSON.stringify({ type: 'ignored' }) });
      openedWs.emit('close', { code: 1006 });
      expect(events).toEqual(['plan.updated']);
      expect(statuses.length).toBe(statusCountAfterUnsub);

      // Access revocation (4401) stops reconnect scheduling and notifies onAuthRequired.
      FakeWebSocket.instances = [];
      scheduledDelays.length = 0;
      let authRequiredCount = 0;
      const unsubAuth = client.connectEvents(() => {}, (ok) => statuses.push(ok), {
        baseDelayMs: 40,
        maxDelayMs: 120,
        onAuthRequired: () => {
          authRequiredCount += 1;
        },
      });
      const authWs = FakeWebSocket.instances[0];
      authWs.emit('open');
      authWs.emit('close', { code: 4401 });
      expect(authWs.listenerCount()).toBe(0);
      expect(pendingTimers.size).toBe(0);
      expect(scheduledDelays).toEqual([]);
      expect(authRequiredCount).toBe(1);
      unsubAuth();
    } finally {
      globalThis.WebSocket = origWebSocket;
      globalThis.setTimeout = origSetTimeout;
      globalThis.clearTimeout = origClearTimeout;
    }
  });

  it('reconnects RoomApiClient and RoomApp after a local server restart, reloads active state, and cleans up on unmount', async () => {
    const dbDir = mkTmp('dalang-tui-reconnect-db-');
    const dbPath = path.join(dbDir, 'dalang.db');
    const repoDir = mkTmp('dalang-tui-reconnect-repo-');

    const server1 = await createDalangServer({
      dbPath,
      enableScheduler: false,
      wsHeartbeatIntervalMs: 1000,
    });
    let server1Closed = false;
    cleanups.push(async () => {
      if (!server1Closed) await server1.close();
    });

    const createdProj = await server1.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { mode: 'create', name: 'reconnect-demo', path: repoDir, initGitIfMissing: true },
    });
    expect(createdProj.statusCode).toBe(201);
    const projectId = createdProj.json().project.id as string;

    const createdSess = await server1.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/sessions`,
      payload: { mode: 'ask', title: 'Room Before Restart' },
    });
    expect(createdSess.statusCode).toBe(201);
    const sessionId = createdSess.json().session.id as string;

    await server1.app.listen({ host: '127.0.0.1', port: 0 });
    const addr = server1.app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const client = new RoomApiClient(port);

    // Also attach a direct connectEvents subscriber to verify live events before & after restart.
    const statusLog: boolean[] = [];
    const receivedEvents: string[] = [];
    const unsubDirect = client.connectEvents(
      (ev) => receivedEvents.push(ev.type),
      (connected) => statusLog.push(connected),
      { baseDelayMs: 40, maxDelayMs: 120 },
    );
    cleanups.push(async () => unsubDirect());

    const waitUntil = async (predicate: () => boolean, timeoutMs = 8000, label = 'condition') => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, 30));
      }
      throw new Error(`Timed out waiting for ${label}`);
    };

    await waitUntil(() => statusLog.at(-1) === true, 5000, 'direct client initial connect');
    server1.events.emitEvent({ type: 'sessions.updated', projectId });
    await waitUntil(() => receivedEvents.includes('sessions.updated'), 5000, 'event before restart');

    // Mount RoomApp on the existing session.
    const stdout = new PassThrough();
    Object.assign(stdout, { columns: 110, rows: 32, isTTY: true });
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
        cwd: repoDir,
        initialRoom: { projectId, sessionId, mode: 'quick', modelChoice: null },
        openBrowser: () => {},
        onOpenPager: async () => ({ ok: true }),
      }),
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
    let unmounted = false;
    cleanups.push(async () => {
      if (!unmounted) {
        inst.unmount();
        unmounted = true;
      }
      stdout.end();
      stdin.end();
      await new Promise((r) => setTimeout(r, 50));
    });

    const wsClientCount = (app: unknown) =>
      (app as { websocketServer: { clients: Set<unknown> } }).websocketServer.clients.size;

    await waitUntil(
      () =>
        screen.includes('Room Before Restart') &&
        screen.includes('· live') &&
        wsClientCount(server1.app) === 2,
      8000,
      'RoomApp initial load and live socket',
    );

    // Shut down server #1 -> clients observe disconnect.
    server1Closed = true;
    await server1.close();
    await waitUntil(() => statusLog.at(-1) === false, 5000, 'disconnect status');

    // Restart server #2 on the same port and DB. Rename the session BEFORE listen so no WS event
    // is broadcast for it: RoomApp must reload active state on reconnect to display the new title.
    const server2 = await createDalangServer({
      dbPath,
      enableScheduler: false,
      wsHeartbeatIntervalMs: 1000,
    });
    cleanups.push(server2.close);

    const renamed = await server2.app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/sessions/${sessionId}`,
      payload: { title: 'Room After Reconnect' },
    });
    expect(renamed.statusCode).toBe(200);

    await server2.app.listen({ host: '127.0.0.1', port });

    await waitUntil(
      () =>
        statusLog.at(-1) === true &&
        wsClientCount(server2.app) === 2 &&
        screen.includes('Room After Reconnect'),
      10_000,
      'RoomApp reconnect and active-state reload',
    );

    // Confirm live events work again after reconnect.
    server2.events.emitEvent({ type: 'plan.updated', projectId });
    await waitUntil(() => receivedEvents.includes('plan.updated'), 5000, 'event after reconnect');

    // Unsubscribing direct client and unmounting RoomApp closes all sockets cleanly.
    unsubDirect();
    inst.unmount();
    unmounted = true;

    await waitUntil(() => wsClientCount(server2.app) === 0, 5000, 'clean disconnect after unmount');
    const eventCountAfterCleanup = receivedEvents.length;
    const statusCountAfterCleanup = statusLog.length;
    server2.events.emitEvent({ type: 'sessions.updated', projectId });
    await new Promise((r) => setTimeout(r, 60));
    expect(receivedEvents.length).toBe(eventCountAfterCleanup);
    expect(statusLog.length).toBe(statusCountAfterCleanup);
  });

  it('prompts for login in RoomApp when access is revoked (4401) and restores the live subscription after sign-in', async () => {
    const dbDir = mkTmp('dalang-tui-auth-db-');
    const dbPath = path.join(dbDir, 'dalang.db');
    const repoDir = mkTmp('dalang-tui-auth-repo-');
    const password = 'a long local password';

    const server = await createDalangServer({
      dbPath,
      enableScheduler: false,
      wsHeartbeatIntervalMs: 1000,
    });
    cleanups.push(server.close);

    const createdProj = await server.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { mode: 'create', name: 'auth-room-demo', path: repoDir, initGitIfMissing: true },
    });
    expect(createdProj.statusCode).toBe(201);
    const projectId = createdProj.json().project.id as string;

    const createdSess = await server.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/sessions`,
      payload: { mode: 'ask', title: 'Auth Recovery Session' },
    });
    expect(createdSess.statusCode).toBe(201);
    const sessionId = createdSess.json().session.id as string;

    await server.app.listen({ host: '127.0.0.1', port: 0 });
    const addr = server.app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const client = new RoomApiClient(port);
    const wsClientCount = () =>
      (server.app as unknown as { websocketServer: { clients: Set<unknown> } }).websocketServer.clients.size;

    const stdout = new PassThrough();
    Object.assign(stdout, { columns: 110, rows: 32, isTTY: true });
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
        cwd: repoDir,
        initialRoom: { projectId, sessionId, mode: 'quick', modelChoice: null },
        openBrowser: () => {},
        onOpenPager: async () => ({ ok: true }),
      }),
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
    let unmounted = false;
    cleanups.push(async () => {
      if (!unmounted) {
        inst.unmount();
        unmounted = true;
      }
      stdout.end();
      stdin.end();
      await new Promise((r) => setTimeout(r, 50));
    });

    const waitUntil = async (predicate: () => boolean, timeoutMs = 8000, label = 'condition') => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, 30));
      }
      throw new Error(`Timed out waiting for ${label}. Last screen tail:\n${screen.slice(-1000)}`);
    };

    await waitUntil(
      () =>
        screen.includes('Auth Recovery Session') &&
        screen.includes('[QUICK]') &&
        screen.includes('· live') &&
        wsClientCount() === 1,
      8000,
      'initial authenticated RoomApp session with restored initialRoom mode',
    );

    // Enable login from another view -> server revokes the open room socket with 4401.
    const enabled = await server.app.inject({
      method: 'PUT',
      url: '/api/auth/settings',
      payload: { enabled: true, password },
    });
    expect(enabled.statusCode).toBe(200);
    const adminCookie = String(enabled.headers['set-cookie']).split(';')[0];

    await waitUntil(
      () => wsClientCount() === 0 && screen.includes('sign in required'),
      8000,
      'RoomApp login prompt after 4401 revocation',
    );

    // Sign in through the RoomApp password prompt and verify the live subscription is restored.
    stdin.write(`${password}\r`);

    await waitUntil(
      () => wsClientCount() === 1,
      8000,
      'restored authenticated WebSocket after sign-in',
    );

    // Emit a live update after sign-in to prove the restored subscription receives events.
    const renamed = await server.app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/sessions/${sessionId}`,
      headers: { cookie: adminCookie },
      payload: { title: 'Live After Reauth' },
    });
    expect(renamed.statusCode).toBe(200);
    server.events.emitEvent({ type: 'sessions.updated', projectId });

    await waitUntil(
      () => screen.includes('Live After Reauth'),
      8000,
      'live session update received after RoomApp re-authentication',
    );

    inst.unmount();
    unmounted = true;
    await waitUntil(() => wsClientCount() === 0, 5000, 'WS closed after RoomApp unmount');
  });
});
