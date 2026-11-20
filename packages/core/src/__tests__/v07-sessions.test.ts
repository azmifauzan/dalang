import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../adapters/registry.js';
import type { CliRunner, RunCommandOptions, RunCommandResult } from '../adapters/types.js';
import { openDatabase } from '../db/client.js';
import { DalangEventBus } from '../services/events.js';
import { ExecutionService } from '../services/executor.js';
import { LeadService } from '../services/lead.js';
import { ProjectService } from '../services/project.js';
import { SettingsService } from '../services/settings.js';
import { cleanupTempDirs, makeTempDir } from './exec-helpers.js';

function initSeededBugRepo(dir: string): void {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'seeded-bug-app', version: '1.0.0', type: 'module' }, null, 2) + '\n',
  );
  // Seeded bug: add() subtracts instead of adding
  fs.writeFileSync(
    path.join(dir, 'src', 'math.mjs'),
    'export function add(a, b) {\n  return a - b;\n}\n',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'math.test.mjs'),
    [
      "import assert from 'node:assert/strict';",
      "import { add } from './math.mjs';",
      'assert.equal(add(2, 3), 5);',
      "console.log('math tests passed');",
      '',
    ].join('\n'),
  );
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@dalang.local'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Dalang Test'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'Initial commit with seeded bug'], { cwd: dir, stdio: 'pipe' });
}

interface CallRecord {
  command: string;
  args: string[];
  cwd: string;
  prompt: string;
}

class SessionModesFakeRunner implements CliRunner {
  public readonly calls: CallRecord[] = [];
  public failResumeOnce = false;
  public askModeResponse: { answer: string; suggested_mode: 'quick' | 'full' | null; suggestion_reason?: string } = {
    answer: 'src/math.mjs defines add(a, b), which currently returns a - b instead of a + b.',
    suggested_mode: 'quick',
    suggestion_reason: 'Single-line bug fix in src/math.mjs.',
  };
  public quickModeVerdict: 'ready' | 'too_large' = 'ready';

  async which(bin: string): Promise<string | null> {
    if (bin === 'claude' || bin === 'codex' || bin === 'agy' || bin === 'git') {
      return `/usr/bin/${bin}`;
    }
    return null;
  }

  async run(command: string, args: string[], options: RunCommandOptions): Promise<RunCommandResult> {
    const joined = args.join(' ');
    const pIdx = args.indexOf('-p');
    const prompt = options.stdinData ?? (pIdx >= 0 && pIdx + 1 < args.length ? args[pIdx + 1] : joined);
    this.calls.push({ command, args: [...args], cwd: options.cwd, prompt });

    const ok = (stdout = '', stderr = ''): RunCommandResult => ({
      exitCode: 0,
      stdout,
      stderr,
      timedOut: false,
      idleTimedOut: false,
      aborted: false,
    });

    if (args.includes('--version')) {
      return ok('2.1.0\n');
    }
    if (joined.includes('auth status') || joined.includes('login status')) {
      return ok('{"loggedIn":true}\n');
    }

    // Simulate resume failure when testing fallback context injection
    if (this.failResumeOnce && (args.includes('--resume') || joined.includes('resume'))) {
      this.failResumeOnce = false;
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'Error: session not found for resume',
        timedOut: false,
        idleTimedOut: false,
        aborted: false,
      };
    }

    // 1. Ask mode (read-only)
    if (prompt.includes('Ask mode (read-only')) {
      const payload = JSON.stringify({
        answer: this.askModeResponse.answer,
        suggested_mode: this.askModeResponse.suggested_mode,
        suggestion_reason: this.askModeResponse.suggestion_reason,
      });
      const out = JSON.stringify({ type: 'result', session_id: 'cli-sess-ask-1', result: payload }) + '\n';
      options.onStdoutLine?.(out.trim());
      return ok(out);
    }

    // 2. Quick mode mini-plan
    const quickPlanMatch = prompt.match(/(\.dalang\/(?:sessions\/[A-Za-z0-9_-]+\/)?(?:tmp\/)?quick-plan[-.]v\d+\.json)/);
    if (quickPlanMatch) {
      const target = path.join(options.cwd, quickPlanMatch[1]);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (this.quickModeVerdict === 'too_large') {
        fs.writeFileSync(
          target,
          JSON.stringify(
            {
              verdict: 'too_large',
              summary: 'Rewriting authentication and billing spans many modules.',
              reason: 'Touches database schema, API routes, and UI views across multiple areas.',
              findings: ['Found auth hooks in src/auth', 'Billing tables require a schema migration'],
            },
            null,
            2,
          ),
        );
      } else {
        fs.writeFileSync(
          target,
          JSON.stringify(
            {
              verdict: 'ready',
              summary: 'Fix add(a, b) in src/math.mjs so it returns a + b.',
              task: {
                id: 'Q-001',
                title: 'Fix add() operator in src/math.mjs',
                milestone: 'Quick fix',
                role: 'engineer',
                complexity: 'low',
                depends_on: [],
                goal: 'Change return a - b to return a + b in src/math.mjs.',
                files_allowed: ['src/math.mjs'],
                files_reference: ['src/math.test.mjs'],
                acceptance_criteria: ['add(2, 3) returns 5', 'node src/math.test.mjs exits 0'],
                verify: 'node src/math.test.mjs',
                needs_split: false,
              },
            },
            null,
            2,
          ),
        );
      }
      const out = JSON.stringify({ type: 'result', session_id: 'cli-sess-quick-1', result: 'ok' }) + '\n';
      options.onStdoutLine?.(out.trim());
      return ok(out);
    }

    // 3. Discuss turn (Full mode)
    const discussMatch = prompt.match(/(\.dalang\/(?:sessions\/[A-Za-z0-9_-]+\/)?discuss\/round-\d+\.json)/);
    if (discussMatch) {
      const target = path.join(options.cwd, discussMatch[1]);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(
        target,
        JSON.stringify(
          {
            round: 1,
            summary: 'Clarifying scope based on earlier conversation.',
            ready_for_brief: true,
            questions: [
              {
                id: 'q1',
                question: 'Which auth provider should we start with?',
                kind: 'single',
                options: ['Local JWT', 'OAuth2'],
                allow_custom: true,
                reason: 'Determines token flow.',
              },
            ],
          },
          null,
          2,
        ),
      );
      const out = JSON.stringify({ type: 'result', session_id: 'cli-sess-full-1', result: 'ok' }) + '\n';
      options.onStdoutLine?.(out.trim());
      return ok(out);
    }

    // 4. Reviewer turn (read-only outputs JSON directly; non-read-only writes review.json)
    const reviewMatch = prompt.match(/(\.dalang\/(?:sessions\/[A-Za-z0-9_-]+\/)?tasks\/[^/\s]+\/review(?:\.round-\d+)?\.json)/);
    if (reviewMatch || prompt.includes('Review requirements:') || prompt.includes('code review round')) {
      const extId = prompt.match(/for task ([A-Za-z0-9_-]+)/)?.[1] ?? 'Q-001';
      const reviewPayload = {
        task_id: extId,
        status: 'pass',
        verify_exit_code: 0,
        summary: 'add(a, b) is fixed and math.test.mjs passes.',
        findings: [],
      };
      if (reviewMatch) {
        const target = path.join(options.cwd, reviewMatch[1]);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, JSON.stringify(reviewPayload));
      }
      const reviewStr = JSON.stringify(reviewPayload);
      const out = command.includes('codex')
        ? JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: reviewStr } }) + '\n'
        : command.includes('agy')
          ? JSON.stringify({ conversation_id: 'agy-rev-1', response: reviewStr }) + '\n'
          : JSON.stringify({ type: 'result', session_id: 'cli-rev-1', result: reviewStr }) + '\n';
      options.onStdoutLine?.(out.trim());
      return ok(out);
    }

    // 5. Coder turn: actually fix the seeded bug in src/math.mjs and write result.json
    const resultMatch = prompt.match(/(\.dalang\/(?:sessions\/[A-Za-z0-9_-]+\/)?tasks\/([A-Za-z0-9_-]+)\/result\.json)/);
    if (resultMatch) {
      const extId = resultMatch[2];
      fs.writeFileSync(
        path.join(options.cwd, 'src', 'math.mjs'),
        'export function add(a, b) {\n  return a + b;\n}\n',
      );
      const target = path.join(options.cwd, resultMatch[1]);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(
        target,
        JSON.stringify({
          task_id: extId,
          status: 'completed',
          changed_files: ['src/math.mjs'],
          summary: 'Fixed subtraction bug in src/math.mjs.',
          notes: ['Updated return a - b to return a + b'],
          blockers: [],
          verify_command: 'node src/math.test.mjs',
          verify_exit_code: 0,
        }),
      );
      const out = command.includes('codex')
        ? JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'coded' } }) + '\n'
        : JSON.stringify({ type: 'result', session_id: 'cli-code-1', result: 'ok' }) + '\n';
      options.onStdoutLine?.(out.trim());
      return ok(out);
    }

    // 6. Shell verify command (`/bin/sh -c "node src/math.test.mjs"`)
    if ((command === '/bin/sh' || command === 'sh' || args.includes('/bin/sh')) && args.includes('-c')) {
      const cmd = args[args.indexOf('-c') + 1] ?? '';
      try {
        const stdout = execFileSync('sh', ['-c', cmd], { cwd: options.cwd, encoding: 'utf8', stdio: 'pipe' });
        return ok(stdout);
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return {
          exitCode: e.status ?? 1,
          stdout: String(e.stdout ?? ''),
          stderr: String(e.stderr ?? ''),
          timedOut: false,
          idleTimedOut: false,
          aborted: false,
        };
      }
    }

    return ok();
  }
}

afterEach(() => {
  cleanupTempDirs();
});

async function setupProjectWithSeededBug(runner: SessionModesFakeRunner) {
  const dbDir = makeTempDir('dalang-v07-db-');
  const projDir = path.join(makeTempDir('dalang-v07-repo-'), 'seeded-bug-app');
  initSeededBugRepo(projDir);

  const conn = openDatabase(path.join(dbDir, 'dalang.db'));
  const events = new DalangEventBus();
  const settingsSvc = new SettingsService(conn.db);
  const registry = new ProviderRegistry(runner, {
    antigravityKeyringAccess: () => settingsSvc.antigravityKeyringAccess(),
  });
  const projectSvc = new ProjectService(conn.db);
  const leadSvc = new LeadService(conn.db, registry, events);
  const execSvc = new ExecutionService(conn.db, registry, leadSvc, events);

  const project = await projectSvc.createOrOpen({
    mode: 'open',
    name: 'Seeded Bug App',
    path: projDir,
    initGitIfMissing: false,
    leadProvider: 'claude-code',
  });
  // Commit scaffold (.dalang/.gitignore, PROJECT.md, symlinks) so we can strictly assert git status stays clean during Ask
  execFileSync('git', ['add', '-A'], { cwd: projDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'Add DALANG project files'], { cwd: projDir, stdio: 'pipe' });

  return { conn, projectSvc, leadSvc, execSvc, events, project, projDir };
}

describe('v0.7 Session Modes (Ask, Quick, Full)', () => {
  it('creates no session when opening a project, runs Ask read-only with clean git status, and supports promotion to Quick/Full', async () => {
    const runner = new SessionModesFakeRunner();
    const { conn, leadSvc, project, projDir } = await setupProjectWithSeededBug(runner);
    try {
      // 1. Opening a project creates NO session
      expect(leadSvc.listSessions(project.id)).toHaveLength(0);

      // 2. First Ask message creates an Ask session and leaves git status completely clean
      const askTurn = await leadSvc.sendChatMessage(project.id, {
        mode: 'ask',
        message: 'Why does add(2, 3) fail in src/math.mjs?',
      });
      expect(askTurn.session.mode).toBe('ask');
      expect(askTurn.session.workState).toBe('idle');
      expect(askTurn.session.title).toContain('Why does add(2, 3) fail');
      expect(leadSvc.listSessions(project.id)).toHaveLength(1);

      // Verify Ask adapter call ran read-only (plan mode in Claude Code)
      const askCall = runner.calls.find((c) => c.prompt.includes('Ask mode (read-only'));
      expect(askCall).toBeDefined();
      expect(askCall!.args).toContain('plan');

      // Verify git status is 100% clean
      const gitStatus = execFileSync('git', ['status', '--porcelain'], {
        cwd: projDir,
        encoding: 'utf8',
      }).trim();
      expect(gitStatus).toBe('');

      // Verify parsed Ask response + Lead mode suggestion
      const leadMsg = askTurn.messages.find((m) => m.role === 'lead');
      expect(leadMsg?.type).toBe('ask');
      expect((leadMsg?.content as { suggestion?: { targetMode: string } }).suggestion?.targetMode).toBe('quick');

      // 3. Switching Ask -> Full carries conversation over into Discuss
      const promoted = leadSvc.switchSessionMode(project.id, askTurn.session.id, 'full');
      expect(promoted.mode).toBe('full');
      expect(promoted.phase).toBe('discuss');
      const detail = leadSvc.getSessionDetail(project.id, promoted.id);
      expect(detail.messages).toHaveLength(2);
      expect(detail.messages[0].role).toBe('user');
      expect(detail.messages[1].role).toBe('lead');

      // One-way promotion: cannot switch Full back to Ask
      expect(() => leadSvc.switchSessionMode(project.id, promoted.id, 'ask')).toThrow(/upward|one-way|cannot switch/i);
    } finally {
      conn.close();
    }
  });

  it('moves a session up only when a message is sent in the higher mode', async () => {
    const runner = new SessionModesFakeRunner();
    const { conn, leadSvc, project } = await setupProjectWithSeededBug(runner);
    try {
      const asked = await leadSvc.sendChatMessage(project.id, { mode: 'ask', message: 'What does add() do?' });
      // Looking at Quick or Full in the composer sends nothing, so the session is still Ask.
      expect(leadSvc.getSession(project.id, asked.session.id).mode).toBe('ask');

      const quick = await leadSvc.sendChatMessage(project.id, {
        sessionId: asked.session.id,
        mode: 'quick',
        message: 'Fix add() so it adds.',
      });
      expect(quick.session.mode).toBe('quick');
      expect(quick.mode).toBe('quick');
    } finally {
      conn.close();
    }
  });

  it('answers a question in a Quick or Full session without changing the session mode', async () => {
    const runner = new SessionModesFakeRunner();
    const { conn, leadSvc, project } = await setupProjectWithSeededBug(runner);
    try {
      const first = await leadSvc.sendChatMessage(project.id, { mode: 'ask', message: 'What does add() do?' });
      const quick = await leadSvc.sendChatMessage(project.id, {
        sessionId: first.session.id,
        mode: 'quick',
        message: 'Fix add() so it adds.',
      });
      expect(quick.session.mode).toBe('quick');

      // The plan is not run yet, and a question still goes through.
      const question = await leadSvc.sendChatMessage(project.id, {
        sessionId: first.session.id,
        mode: 'ask',
        message: 'Which file will change?',
      });
      expect(question.mode).toBe('ask');
      expect(question.session.mode).toBe('quick');
    } finally {
      conn.close();
    }
  });

  it('reports a running Lead turn on the session, so a chat opened mid-turn can show it', async () => {
    const runner = new SessionModesFakeRunner();
    const { conn, leadSvc, events, project } = await setupProjectWithSeededBug(runner);
    try {
      const during: Array<unknown> = [];
      events.onEvent((e) => {
        if (e.type === 'lead.turn_started' && e.sessionId) {
          during.push(leadSvc.getSession(project.id, e.sessionId).turn);
        }
      });
      const turn = await leadSvc.sendChatMessage(project.id, { mode: 'ask', message: 'What does add() do?' });
      expect(during).toHaveLength(1);
      expect(during[0]).toMatchObject({ phase: 'ask', provider: 'claude-code' });
      expect(leadSvc.getSession(project.id, turn.session.id).turn).toBeNull();
    } finally {
      conn.close();
    }
  });

  it('runs an Ask turn with the model and reasoning effort picked in the composer', async () => {
    const runner = new SessionModesFakeRunner();
    const { conn, leadSvc, project } = await setupProjectWithSeededBug(runner);
    try {
      await leadSvc.sendChatMessage(project.id, {
        mode: 'ask',
        message: 'Where is add() defined?',
        provider: 'claude-code',
        model: 'opus',
        effort: 'max',
      });
      const askCall = runner.calls.find((c) => c.prompt.includes('Ask mode (read-only'));
      expect(askCall).toBeDefined();
      const effortAt = askCall!.args.indexOf('--effort');
      expect(askCall!.args[effortAt + 1]).toBe('max');
      expect(askCall!.args[askCall!.args.indexOf('--model') + 1]).toBe('opus');
    } finally {
      conn.close();
    }
  });

  it('runs a Quick session end-to-end on a seeded bug (no brief written), enforces one-working-session rule, and allows follow-up context restoration', async () => {
    const runner = new SessionModesFakeRunner();
    const { conn, leadSvc, execSvc, project, projDir } = await setupProjectWithSeededBug(runner);
    try {
      // 1. Start a Quick session directly from composer
      const quickRes = await leadSvc.sendChatMessage(project.id, {
        mode: 'quick',
        message: 'Fix the add() bug in src/math.mjs so math.test.mjs passes.',
      });
      expect(quickRes.session.mode).toBe('quick');
      expect(quickRes.quickPlan?.verdict).toBe('ready');
      expect(quickRes.plan).not.toBeNull();
      expect(quickRes.plan!.briefId).toBeNull();
      expect(quickRes.plan!.tasks).toHaveLength(1);
      // No brief written!
      expect(leadSvc.listBriefs(project.id, quickRes.session.id)).toHaveLength(0);

      // 2. Click Run: approves Quick plan and runs coder + verify + automated review
      const quickSessionId = quickRes.session.id;
      leadSvc.approveQuickPlan(project.id, quickSessionId);
      await execSvc.startExecution(project.id, {
        sessionId: quickSessionId,
        allowUnconfined: true,
      });

      // Wait until task reaches awaiting_merge
      const deadline = Date.now() + 15_000;
      let taskStatus = '';
      let taskId = quickRes.plan!.tasks[0].id;
      while (Date.now() < deadline) {
        const plan = leadSvc.getPlan(project.id, quickSessionId);
        taskStatus = plan?.tasks[0]?.status ?? '';
        if (taskStatus === 'awaiting_merge' || taskStatus === 'failed' || taskStatus === 'review_failed') {
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(taskStatus).toBe('awaiting_merge');

      // Session 1 must now be `working`
      const sess1 = leadSvc.getSession(project.id, quickSessionId);
      expect(sess1.workState).toBe('working');

      // Cannot switch a working session back to Ask
      expect(() => leadSvc.switchSessionMode(project.id, quickSessionId, 'ask')).toThrow(/working|cannot switch/i);
      // Cannot archive a working session
      expect(() => leadSvc.updateSession(project.id, quickSessionId, { archived: true })).toThrow(/working|cannot archive/i);

      // 3. Single working session rule: starting a Quick request in a new session while Session 1 is working is refused naming Session 1!
      await expect(
        leadSvc.sendChatMessage(project.id, {
          mode: 'quick',
          message: 'Another small tweak',
        }),
      ).rejects.toThrow(sess1.title);

      // Ask chat in a second session STILL works while Session 1 is working!
      const askWhileWorking = await leadSvc.sendChatMessage(project.id, {
        mode: 'ask',
        message: 'What files exist in src/?',
      });
      expect(askWhileWorking.session.mode).toBe('ask');
      expect(askWhileWorking.messages.some((m) => m.role === 'lead')).toBe(true);

      // 4. Approve and merge Session 1 -> bug is fixed on main, session returns to idle, no brief exists
      const mergeRes = await execSvc.approveMergeTask(project.id, taskId, {
        runIntegration: false,
      });
      expect(mergeRes.task.status).toBe('done');
      expect(mergeRes.task.mergeCommitSha).toBeTruthy();

      // Verify seeded bug is genuinely fixed on main!
      const testOut = execFileSync('node', ['src/math.test.mjs'], {
        cwd: projDir,
        encoding: 'utf8',
      });
      expect(testOut).toContain('math tests passed');

      // Session 1 is back to idle, and still has 0 briefs
      const sess1After = leadSvc.getSession(project.id, quickSessionId);
      expect(sess1After.workState).toBe('idle');
      expect(sess1After.doneTaskCount).toBe(1);
      expect(leadSvc.listBriefs(project.id, quickSessionId)).toHaveLength(0);

      // 5. After Session 1 merges, Session 2 can now start Quick work (and can be discarded cleanly)
      const quickRes2 = await leadSvc.sendChatMessage(project.id, {
        mode: 'quick',
        message: 'Another small tweak',
      });
      expect(quickRes2.session.id).not.toBe(quickSessionId);
      leadSvc.approveQuickPlan(project.id, quickRes2.session.id);
      await execSvc.startExecution(project.id, {
        sessionId: quickRes2.session.id,
        allowUnconfined: true,
      });
      const deadline2 = Date.now() + 15_000;
      while (Date.now() < deadline2) {
        const plan2 = leadSvc.getPlan(project.id, quickRes2.session.id);
        const st = plan2?.tasks[0]?.status ?? '';
        if (st === 'awaiting_merge' || st === 'failed' || st === 'review_failed') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(leadSvc.getSession(project.id, quickRes2.session.id).workState).toBe('working');

      // Discard unfinished work on Session 2 -> returns to idle, allowing another session to start
      const discarded = await execSvc.discardSessionWork(project.id, quickRes2.session.id);
      expect(discarded.session.workState).toBe('idle');
      const quickRes3 = await leadSvc.sendChatMessage(project.id, {
        mode: 'quick',
        message: 'Quick check after discard',
      });
      expect(quickRes3.quickPlan?.verdict).toBe('ready');

      // 6. Reopen finished Session 1 -> restores conversation & plan; follow-up Ask uses resume and falls back to saved context + completed work summary
      const reopened = leadSvc.getSessionDetail(project.id, quickSessionId);
      expect(reopened.plan?.tasks[0]?.status).toBe('done');
      expect(reopened.messages.length).toBeGreaterThanOrEqual(2);

      // Force CLI resume failure so we explicitly verify fallback context restoration!
      runner.failResumeOnce = true;
      const followUp = await leadSvc.sendChatMessage(project.id, {
        sessionId: quickSessionId,
        mode: 'ask',
        message: 'What exactly did we change in math.mjs?',
      });
      expect(followUp.session.mode).toBe('quick'); // stays Quick (not demoted)
      const fallbackCall = runner.calls[runner.calls.length - 1];
      expect(fallbackCall.prompt).toContain('Previous conversation in this session:');
      expect(fallbackCall.prompt).toContain('Completed and merged work in this session:');
      expect(fallbackCall.prompt).toContain('Fix add() operator in src/math.mjs');

      // 7. Rename, archive, unarchive, and delete session (leaving merged code on main intact!)
      const renamed = leadSvc.updateSession(project.id, quickSessionId, { title: 'Math bug fix' });
      expect(renamed.title).toBe('Math bug fix');

      const archived = leadSvc.updateSession(project.id, quickSessionId, { archived: true });
      expect(archived.archivedAt).toBeTruthy();
      expect(leadSvc.listSessions(project.id).some((s) => s.id === quickSessionId)).toBe(false);
      expect(leadSvc.listSessions(project.id, { includeArchived: true }).some((s) => s.id === quickSessionId)).toBe(true);

      const unarchived = leadSvc.updateSession(project.id, quickSessionId, { archived: false });
      expect(unarchived.archivedAt).toBeNull();

      leadSvc.deleteSession(project.id, quickSessionId);
      expect(leadSvc.listSessions(project.id, { includeArchived: true }).some((s) => s.id === quickSessionId)).toBe(false);
      // Merged fix on main MUST still be intact!
      expect(fs.readFileSync(path.join(projDir, 'src', 'math.mjs'), 'utf8')).toContain('return a + b;');
    } finally {
      conn.close();
    }
  });

  it('handles Quick verdict too_large and switches smoothly to Full Discuss with request & findings preserved', async () => {
    const runner = new SessionModesFakeRunner();
    runner.quickModeVerdict = 'too_large';
    const { conn, leadSvc, project } = await setupProjectWithSeededBug(runner);
    try {
      const quickRes = await leadSvc.sendChatMessage(project.id, {
        mode: 'quick',
        message: 'Rewrite authentication and add multi-tenant billing',
      });
      expect(quickRes.session.mode).toBe('quick');
      expect(quickRes.quickPlan?.verdict).toBe('too_large');
      expect(quickRes.plan).toBeNull();
      expect(quickRes.session.workState).toBe('idle');

      // One-click switch to Full
      const switched = leadSvc.switchSessionMode(project.id, quickRes.session.id, 'full');
      expect(switched.mode).toBe('full');
      expect(switched.phase).toBe('discuss');

      // Full Discuss has both the original request and Lead's too_large findings already in messages
      const discuss = leadSvc.getDiscussState(project.id, switched.id);
      expect(discuss.messages).toHaveLength(2);
      expect(String(discuss.messages[0].content)).toContain('Rewrite authentication');
      expect(discuss.messages[1].type).toBe('quick_plan');
      expect((discuss.messages[1].content as { findings?: string[] }).findings).toContain('Found auth hooks in src/auth');

      // Sending a Discuss follow-up works seamlessly in that promoted Full session
      const nextDiscuss = await leadSvc.sendChatMessage(project.id, {
        sessionId: switched.id,
        mode: 'full',
        message: 'Yes, let us scope auth first and defer billing.',
      });
      expect(nextDiscuss.session.mode).toBe('full');
      expect(nextDiscuss.messages.some((m) => m.type === 'questions')).toBe(true);
    } finally {
      conn.close();
    }
  });
});
