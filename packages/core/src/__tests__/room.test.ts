import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RoomReportContent } from '@dalang/shared';
import { openDatabase, type DbConnection } from '../db/client.js';
import { ProviderRegistry } from '../adapters/registry.js';
import type { CliRunner, RunCommandOptions, RunCommandResult } from '../adapters/types.js';
import { DalangEventBus } from '../services/events.js';
import { ExecutionService } from '../services/executor.js';
import { LeadService } from '../services/lead.js';
import { ProfileService } from '../services/profiles.js';
import { ProjectService } from '../services/project.js';
import { parseLeadingMention, resolveMentionTarget } from '../services/room-routing.js';

const tmpDirs: string[] = [];
const conns: DbConnection[] = [];

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (conns.length > 0) conns.pop()!.close();
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function createRoomRunner(
  onCall: (command: string, args: string[], opts: RunCommandOptions, prompt: string) => RunCommandResult,
): CliRunner {
  return {
    async which(binary: string) {
      if (['claude', 'codex', 'agy', 'bwrap'].includes(binary)) return `/usr/bin/${binary}`;
      return null;
    },
    async run(command: string, args: string[], opts: RunCommandOptions): Promise<RunCommandResult> {
      if (command === '/bin/sh' || command.endsWith('/sh') || args.includes('/bin/sh')) {
        return { exitCode: 0, stdout: 'ok\n', stderr: '', timedOut: false, idleTimedOut: false };
      }
      const invoked =
        command === '/usr/bin/bwrap'
          ? (args.find((a) => /\/(claude|codex|agy)$/.test(a)) ?? command)
          : command;
      const prompt = [opts.stdinData ?? '', ...args].join('\n');
      const res = onCall(invoked, args, opts, prompt);
      if (opts.onStdoutLine && res.stdout) {
        for (const line of res.stdout.split('\n')) {
          if (line.trim()) opts.onStdoutLine(line);
        }
      }
      return res;
    },
  };
}

describe('Lead settings from Config', () => {
  it('starts a new chat with the Lead profile saved after the project was created', async () => {
    const conn = openDatabase(path.join(mkTmp('dalang-lead-cfg-'), 'dalang.db'));
    conns.push(conn);
    const calls: Array<{ bin: string; args: string[] }> = [];
    const runner = createRoomRunner((bin, args) => {
      calls.push({ bin, args });
      const text = JSON.stringify({ answer: 'ok' });
      return {
        exitCode: 0,
        stdout: [
          JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }),
        ].join('\n'),
        stderr: '',
        timedOut: false,
        idleTimedOut: false,
      };
    });
    const registry = new ProviderRegistry(runner);
    const lead = new LeadService(conn.db, registry);
    const projectService = new ProjectService(conn.db);
    const project = await projectService.createOrOpen({
      mode: 'create',
      name: 'lead-cfg',
      path: mkTmp('dalang-lead-cfg-repo-'),
      initGitIfMissing: true,
      leadProvider: 'claude-code',
    });

    // Changed in Config → Agents → Team after the project exists.
    new ProfileService(conn.db).updateProfile('profile-lead', { provider: 'codex', model: 'gpt-5-codex', effort: 'low' });
    expect(projectService.getProject(project.id)).toMatchObject({ leadProvider: 'codex', leadModel: 'gpt-5-codex' });

    const res = await lead.sendChatMessage(project.id, { mode: 'ask', message: 'hello' });
    expect(res.session).toMatchObject({ provider: 'codex', model: 'gpt-5-codex' });
    const argv = calls[0].args.join(' ');
    expect(calls[0].bin).toContain('codex');
    expect(argv).toContain('gpt-5-codex');
    expect(argv).toContain('model_reasoning_effort="low"');
  });
});

describe('team room mention routing and feed (v0.12)', () => {
  it('tries a configured alternate account after a Claude quota error and keeps the Ask transcript', async () => {
    const conn = openDatabase(path.join(mkTmp('dalang-ask-quota-'), 'dalang.db'));
    conns.push(conn);
    const calls: string[] = [];
    const limit = "You've hit your 5-hour limit · resets 6:10pm (Asia/Jakarta)";
    const runner = createRoomRunner((bin, _args, _opts, prompt) => {
      calls.push(bin);
      const codex = bin.endsWith('/codex');
      const first = calls.length === 1;
      if (codex) expect(prompt).toContain('First question');
      const output = codex
        ? { type: 'item.completed', item: { type: 'agent_message', text: 'Answered by the fallback' } }
        : { type: 'result', subtype: 'success', is_error: !first, session_id: 'claude-session', result: first ? 'First answer' : limit };
      return { exitCode: 0, stdout: JSON.stringify(output), stderr: '', timedOut: false, idleTimedOut: false };
    });
    const project = await new ProjectService(conn.db).createOrOpen({
      mode: 'create', path: mkTmp('dalang-ask-quota-repo-'), initGitIfMissing: true, leadProvider: 'claude-code',
    });
    const profiles = new ProfileService(conn.db);
    const registry = new ProviderRegistry(runner);
    const lead = new LeadService(conn.db, registry);
    profiles.updateProfile('profile-lead', { fallback: { provider: 'codex', model: '', effort: 'medium', configDir: null } });
    const first = await lead.sendChatMessage(project.id, { mode: 'ask', message: 'First question' });
    const sessionId = first.session.id;
    expect(first.session.cliSessionId).toBe('claude-session');

    const answer = await lead.sendChatMessage(project.id, { sessionId, mode: 'ask', message: 'Second question' });
    expect(answer.askReply?.text).toBe('Answered by the fallback');
    expect(answer.session.provider).toBe('claude-code');
    expect(answer.session.cliSessionId).toBeNull();
    expect(calls.map((bin) => path.basename(bin))).toEqual(['claude', 'claude', 'codex']);
    expect(answer.messages.filter((message) => message.content === 'Second question')).toHaveLength(1);

    profiles.updateProfile('profile-lead', { fallback: { provider: 'claude-code', model: 'opus', effort: 'medium', configDir: null } });
    await expect(lead.sendChatMessage(project.id, { sessionId, mode: 'ask', message: 'Third question' }))
      .rejects.toThrow('The Lead fallback uses the same CLI account');
    expect(calls).toHaveLength(4);
    expect(lead.getSessionDetail(project.id, sessionId).messages.at(-1)?.role).toBe('system');

    profiles.updateProfile('profile-lead', { fallback: { provider: 'codex', model: '', effort: 'medium', configDir: null } });
    registry.setUsageSnapshot('claude-code', {
      available: true,
      windows: [{ group: 'Claude', window: '5h', label: '5h', usedPercent: 100, remainingPercent: 0, resetsAt: null }],
    });
    const cached = await lead.sendChatMessage(project.id, { sessionId, mode: 'ask', message: 'Fourth question' });
    expect(cached.askReply?.text).toBe('Answered by the fallback');
    expect(calls.slice(4).map((bin) => path.basename(bin))).toEqual(['claude', 'codex']);
  });

  it('parses leading mentions and ignores non-mention tokens', () => {
    expect(parseLeadingMention('@reviewer check edge cases')).toEqual({
      mention: 'reviewer',
      body: 'check edge cases',
    });
    expect(parseLeadingMention('@coder-small: add unit test')).toEqual({
      mention: 'coder-small',
      body: 'add unit test',
    });
    expect(parseLeadingMention('plain message for lead')).toBeNull();
    expect(parseLeadingMention('@types/react is a scoped package')).toBeNull();
  });

  it('routes untagged to Lead, @reviewer while idle to Ask mode, and @coder while running to steering', async () => {
    const dbDir = mkTmp('dalang-room-db-');
    const repoDir = mkTmp('dalang-room-repo-');
    const conn = openDatabase(path.join(dbDir, 'dalang.db'));
    conns.push(conn);

    const calls: Array<{ bin: string; prompt: string; readOnly: boolean }> = [];
    const runner = createRoomRunner((bin, args, _opts, prompt) => {
      const readOnly = args.includes('plan') || args.includes('read-only') || args.some((a) => a.includes('read-only'));
      calls.push({ bin, prompt, readOnly });
      if (bin.endsWith('codex')) {
        return {
          exitCode: 0,
          stdout: [
            JSON.stringify({ type: 'thread.started', thread_id: 'rev-thread-1' }),
            JSON.stringify({
              type: 'item.completed',
              item: { type: 'agent_message', text: 'Reviewer reply: looks clean, check null guard.' },
            }),
          ].join('\n'),
          stderr: '',
          timedOut: false,
          idleTimedOut: false,
        };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          type: 'result',
          session_id: 'lead-sess-1',
          result: JSON.stringify({
            answer: 'Lead reply: repository has 1 entry file.',
            suggested_mode: null,
            suggestion_reason: null,
          }),
        }),
        stderr: '',
        timedOut: false,
        idleTimedOut: false,
      };
    });

    const registry = new ProviderRegistry(runner);
    const events = new DalangEventBus();
    const projectService = new ProjectService(conn.db);
    const profileService = new ProfileService(conn.db);
    const leadService = new LeadService(conn.db, registry, events);
    const textEvents: Array<{ phase: string; text: string; reset?: boolean }> = [];
    events.onEvent((event) => {
      if (event.type === 'lead.text') textEvents.push({ phase: event.phase, text: event.text, reset: event.reset });
    });

    // Point reviewer profile to codex so we can verify provider selection cleanly.
    profileService.updateProfile('profile-reviewer', { provider: 'codex', model: 'gpt-5-codex' });

    const project = await projectService.createOrOpen({
      mode: 'create',
      name: 'room-demo',
      path: repoDir,
      initGitIfMissing: true,
      leadProvider: 'claude-code',
    });

    // 1. Untagged message -> goes to Lead
    const leadRes = await leadService.sendChatMessage(project.id, {
      mode: 'ask',
      message: 'What is in this repository?',
    });
    expect(leadRes.routedTo?.kind).toBe('lead');
    expect(leadRes.routedTo?.profileName).toBe('lead');
    expect(leadRes.askReply?.text).toContain('Lead reply');
    expect(calls[0]?.bin).toContain('claude');

    const sessionId = leadRes.session.id;
    expect(leadRes.session.cliSessionId).toBe('lead-sess-1');

    // 2. @reviewer while idle -> Ask mode (read-only) using reviewer profile, keeping Lead cliSessionId intact
    const revRes = await leadService.sendChatMessage(project.id, {
      sessionId,
      mode: 'quick', // even if composer is in quick mode, @reviewer while idle runs read-only Ask!
      message: '@reviewer check null handling in auth',
    });
    expect(revRes.routedTo).toEqual({
      kind: 'ask',
      profileId: 'profile-reviewer',
      profileName: 'reviewer',
    });
    expect(revRes.mode).toBe('ask');
    expect(revRes.session.mode).toBe('ask'); // session mode NOT promoted
    expect(revRes.session.cliSessionId).toBe('lead-sess-1'); // Lead CLI session untouched
    expect(revRes.askReply?.text).toContain('Reviewer reply');
    // The reply text reached the room live, flushed before the turn returned.
    expect(textEvents).toEqual([
      { phase: 'ask:reviewer', text: 'Reviewer reply: looks clean, check null guard.', reset: true },
    ]);
    expect(calls[1]?.bin).toContain('codex');
    expect(calls[1]?.readOnly).toBe(true);
    expect(calls[1]?.prompt).toContain('match the language of the latest user question');

    const revMsg = revRes.messages[revRes.messages.length - 1];
    expect(revMsg.role).toBe('agent');
    expect(revMsg.kind).toBe('chat');
    expect(revMsg.authorProfileId).toBe('profile-reviewer');
    expect(revMsg.authorProfileName).toBe('reviewer');

    // 3. @coder while a coder task is running -> delivered as a steering message
    const steered: Array<{ projectId: string; taskId: string; runId: string; message: string }> = [];
    leadService.setExecutionRouter({
      listActiveRunsForSession(pid, sid) {
        if (pid === project.id && sid === sessionId) {
          return [
            {
              taskId: 'task-uuid-1',
              externalId: 'T-001',
              runId: 'run-uuid-1',
              profileId: 'profile-coder-small',
              profileName: 'coder-small',
              kind: 'execute',
              canSteer: true,
            },
          ];
        }
        return [];
      },
      async steerTask(pid, taskId, runId, message) {
        steered.push({ projectId: pid, taskId, runId, message });
      },
    });

    const steerRes = await leadService.sendChatMessage(project.id, {
      sessionId,
      mode: 'ask',
      message: '@coder please add a regression test for empty input',
    });
    expect(steerRes.routedTo).toEqual({
      kind: 'steer',
      profileId: 'profile-coder-small',
      profileName: 'coder-small',
      taskId: 'task-uuid-1',
      runId: 'run-uuid-1',
    });
    expect(steered).toEqual([
      {
        projectId: project.id,
        taskId: 'task-uuid-1',
        runId: 'run-uuid-1',
        message: 'please add a regression test for empty input',
      },
    ]);

    const steerMsg = steerRes.messages[steerRes.messages.length - 1];
    expect(steerMsg.type).toBe('report');
    expect(steerMsg.kind).toBe('status');
    expect(steerMsg.authorProfileId).toBe('profile-coder-small');
    expect(steerMsg.authorProfileName).toBe('coder-small');
    expect((steerMsg.content as RoomReportContent).event).toBe('task_steered');

    // 4. A running coder that cannot take steering refuses with 409 and writes nothing to the room
    const before = steerRes.messages.length;
    leadService.setExecutionRouter({
      listActiveRunsForSession: () => [
        {
          taskId: 'task-uuid-1',
          externalId: 'T-001',
          runId: 'run-uuid-1',
          profileId: 'profile-coder-small',
          profileName: 'coder-small',
          kind: 'execute',
          canSteer: false,
        },
      ],
      async steerTask() {
        throw new Error('should not be called');
      },
    });
    await expect(
      leadService.sendChatMessage(project.id, {
        sessionId,
        mode: 'ask',
        message: '@coder-small stop touching the config',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(leadService.getDiscussState(project.id, sessionId).messages.length).toBe(before);
  });

  it('resolveMentionTarget distinguishes exact running coder vs idle coder profile', () => {
    const dbDir = mkTmp('dalang-room-resolve-');
    const conn = openDatabase(path.join(dbDir, 'dalang.db'));
    conns.push(conn);
    const profiles = new ProfileService(conn.db).listProfiles();

    // Idle @coder -> Ask on coder-small
    const idleCoder = resolveMentionTarget('@coder explain index.ts', profiles, []);
    expect(idleCoder?.route).toBe('ask');
    if (idleCoder?.route === 'ask') {
      expect(idleCoder.profile.name).toBe('coder-small');
    }

    // Running @coder-heavy -> steer
    const active = [
      {
        taskId: 't1',
        externalId: 'T-001',
        runId: 'r1',
        profileId: 'profile-coder-heavy',
        profileName: 'coder-heavy',
        kind: 'execute' as const,
        canSteer: true,
      },
    ];
    const steerAlias = resolveMentionTarget('@coder keep it concise', profiles, active);
    expect(steerAlias?.route).toBe('steer');
    if (steerAlias?.route === 'steer') {
      expect(steerAlias.run.profileName).toBe('coder-heavy');
    }
  });

  it('posts role reports with author_profile_id and kind across task lifecycle', async () => {
    const dbDir = mkTmp('dalang-room-lifecycle-');
    const repoDir = mkTmp('dalang-room-lc-repo-');
    const conn = openDatabase(path.join(dbDir, 'dalang.db'));
    conns.push(conn);

    const runner = createRoomRunner((bin, args, opts, prompt) => {
      const cwd = opts.cwd;
      // Quick plan
      const quickMatch = prompt.match(/Write ONLY the JSON contract to "([^"]+)"/);
      if (quickMatch) {
        const target = path.join(cwd, quickMatch[1]);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(
          target,
          JSON.stringify({
            verdict: 'ready',
            summary: 'Add hello.txt',
            task: {
              id: 'T-001',
              title: 'Create hello.txt',
              milestone: 'Quick',
              role: 'engineer',
              complexity: 'low',
              depends_on: [],
              goal: 'Create hello.txt with greeting',
              files_allowed: ['hello.txt'],
              files_reference: [],
              acceptance_criteria: ['hello.txt exists'],
              verify: 'test -f hello.txt',
              needs_split: false,
            },
          }),
        );
        return {
          exitCode: 0,
          stdout: JSON.stringify({ type: 'result', session_id: 'lead-q1', result: 'done' }),
          stderr: '',
          timedOut: false,
          idleTimedOut: false,
        };
      }

      // Reviewer run (runs on codex in read-only mode)
      if (bin.endsWith('codex') || args.includes('plan')) {
        const reviewJson = JSON.stringify({
          task_id: 'T-001',
          status: 'pass',
          verify_exit_code: 0,
          summary: 'All good',
          findings: [],
        });
        return {
          exitCode: 0,
          stdout: bin.endsWith('codex')
            ? [
                JSON.stringify({ type: 'thread.started', thread_id: 'rev-1' }),
                JSON.stringify({
                  type: 'item.completed',
                  item: { type: 'agent_message', text: reviewJson },
                }),
              ].join('\n')
            : JSON.stringify({
                type: 'result',
                session_id: 'rev-1',
                result: reviewJson,
              }),
          stderr: '',
          timedOut: false,
          idleTimedOut: false,
        };
      }

      // Coder run
      const resultMatch =
        prompt.match(/write\s+the\s+JSON\s+result\s+to\s+"([^"]+)"/i) ??
        prompt.match(/(\.dalang\/[^\s"]+result\.json)/);
      if (resultMatch) {
        fs.writeFileSync(path.join(cwd, 'hello.txt'), 'hello room\n');
        const target = path.join(cwd, resultMatch[1]);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(
          target,
          JSON.stringify({
            task_id: 'T-001',
            status: 'completed',
            changed_files: ['hello.txt'],
            summary: 'Added hello.txt',
            notes: [],
            blockers: [],
          }),
        );
        return {
          exitCode: 0,
          stdout: JSON.stringify({ type: 'result', session_id: 'coder-1', result: 'ok' }),
          stderr: '',
          timedOut: false,
          idleTimedOut: false,
        };
      }

      return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
    });

    const registry = new ProviderRegistry(runner);
    const events = new DalangEventBus();
    const projectService = new ProjectService(conn.db);
    const profileService = new ProfileService(conn.db);
    profileService.updateProfile('profile-coder-small', { provider: 'claude-code', model: '' });
    profileService.updateProfile('profile-reviewer', { provider: 'codex', model: '' });

    const leadService = new LeadService(conn.db, registry, events);
    const executionService = new ExecutionService(conn.db, registry, leadService, events);

    const project = await projectService.createOrOpen({
      mode: 'create',
      name: 'room-lc',
      path: repoDir,
      initGitIfMissing: true,
      leadProvider: 'claude-code',
    });

    const quick = await leadService.sendChatMessage(project.id, {
      mode: 'quick',
      message: 'Create hello.txt',
    });
    const sid = quick.session.id;
    const plan = leadService.approveQuickPlan(project.id, sid);
    const taskId = plan.tasks[0].id;

    await executionService.startExecution(project.id, { sessionId: sid, allowUnconfined: true });
    await executionService.waitForTaskExecution(taskId);
    await executionService.approveMergeTask(project.id, taskId, {
      allowUnconfined: true,
      runIntegration: false,
    });

    const detail = leadService.getSessionDetail(project.id, sid);
    const reports = detail.messages
      .filter((m) => m.type === 'report')
      .map((m) => ({
        author: m.authorProfileName,
        kind: m.kind,
        content: m.content as RoomReportContent,
      }));

    const eventNames = reports.map((r) => r.content.event);
    expect(eventNames).toEqual([
      'task_started',
      'task_finished',
      'verify_result',
      'review_verdict',
      'task_merged',
      // The plan's only task is merged, so the room gets one closing note.
      'run_finished',
    ]);

    const finishedReport = reports.find((r) => r.content.event === 'task_finished')!;
    expect(finishedReport.author).toBe('coder-small');
    expect(finishedReport.content.diffStats?.filesChanged).toBeGreaterThanOrEqual(1);
    expect(finishedReport.content.diffStats?.insertions).toBeGreaterThanOrEqual(1);

    const verdictReport = reports.find((r) => r.content.event === 'review_verdict')!;
    expect(verdictReport.kind).toBe('gate');
    expect(verdictReport.content.reviewStatus).toBe('pass');
  });
});
