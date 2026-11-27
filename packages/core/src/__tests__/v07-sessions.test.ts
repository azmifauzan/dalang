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
import { StatisticsService } from '../services/stats.js';
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
  public autoResponse: unknown = { answer: 'What would you like to know?', auto_plan: null };

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

    if (prompt.includes('Lead in DALANG Auto mode')) {
      const out = JSON.stringify({ type: 'result', session_id: 'cli-sess-auto-1', result: JSON.stringify(this.autoResponse) }) + '\n';
      options.onStdoutLine?.(out.trim());
      return ok(out);
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

async function setupProjectWithSeededBug(runner: CliRunner) {
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

describe('Auto commit in the active checkout', () => {
  it('commits only requested files and leaves unrelated staged and untracked files intact', async () => {
    const runner = new SessionModesFakeRunner();
    runner.autoResponse = {
      answer: 'I will commit the selected files.', auto_plan: null,
      auto_commit: { paths: ['src/math.mjs', 'src/new.mjs'], message: 'Fix math' },
    };
    const { conn, leadSvc, project, projDir } = await setupProjectWithSeededBug(runner);
    try {
      fs.writeFileSync(path.join(projDir, 'src/math.mjs'), 'export const answer = 42;\n');
      fs.writeFileSync(path.join(projDir, 'src/new.mjs'), 'export const added = true;\n');
      fs.writeFileSync(path.join(projDir, 'src/other.mjs'), 'unrelated\n');
      fs.writeFileSync(path.join(projDir, 'src/math.test.mjs'), 'staged unrelated\n');
      execFileSync('git', ['add', 'src/math.test.mjs'], { cwd: projDir });
      const result = await leadSvc.sendChatMessage(project.id, { mode: 'auto', message: 'Commit src/math.mjs and src/new.mjs' });
      expect(result.messages.some((entry) => String(entry.content).includes('Committed src/math.mjs'))).toBe(true);
      const committed = execFileSync('git', ['show', '--format=', '--name-only', 'HEAD'], { cwd: projDir, encoding: 'utf8' });
      expect(committed.trim().split('\n').sort()).toEqual(['src/math.mjs', 'src/new.mjs']);
      const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: projDir, encoding: 'utf8' });
      expect(staged.trim()).toBe('src/math.test.mjs');
      expect(fs.readFileSync(path.join(projDir, 'src/other.mjs'), 'utf8')).toBe('unrelated\n');
    } finally { conn.close(); }
  });

  it('accepts a clear yes after Lead lists the exact commit files', async () => {
    const runner = new SessionModesFakeRunner();
    runner.autoResponse = { answer: 'Commit `src/math.mjs`?', auto_commit: null };
    const { conn, leadSvc, project, projDir } = await setupProjectWithSeededBug(runner);
    try {
      fs.writeFileSync(path.join(projDir, 'src/math.mjs'), 'changed\n');
      const first = await leadSvc.sendChatMessage(project.id, { mode: 'auto', message: 'Please commit the fix' });
      runner.autoResponse = { answer: 'I will commit it.', auto_commit: { paths: ['src/math.mjs'], message: 'Fix math' } };
      const result = await leadSvc.sendChatMessage(project.id, { sessionId: first.session.id, mode: 'auto', message: 'ya' });
      expect(result.messages.some((entry) => String(entry.content).includes('Committed src/math.mjs'))).toBe(true);
    } finally { conn.close(); }
  });

  it('does not execute a commit action without a user commit request', async () => {
    const runner = new SessionModesFakeRunner();
    runner.autoResponse = { answer: 'Working.', auto_commit: { paths: ['src/math.mjs'], message: 'Fix' } };
    const { conn, leadSvc, project, projDir } = await setupProjectWithSeededBug(runner);
    try {
      const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projDir, encoding: 'utf8' });
      await expect(leadSvc.sendChatMessage(project.id, { mode: 'auto', message: 'Explain the bug' }))
        .rejects.toThrow('explicit request');
      expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projDir, encoding: 'utf8' })).toBe(before);
    } finally { conn.close(); }
  });

  it('does not overwrite partially staged content when committing a file', async () => {
    const runner = new SessionModesFakeRunner();
    runner.autoResponse = { answer: 'I will commit the file.', auto_commit: { paths: ['src/math.mjs'], message: 'Fix' } };
    const { conn, leadSvc, project, projDir } = await setupProjectWithSeededBug(runner);
    try {
      const file = path.join(projDir, 'src/math.mjs');
      fs.writeFileSync(file, 'staged content\n');
      execFileSync('git', ['add', 'src/math.mjs'], { cwd: projDir });
      fs.writeFileSync(file, 'unstaged content\n');
      const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projDir, encoding: 'utf8' });
      const result = await leadSvc.sendChatMessage(project.id, { mode: 'auto', message: 'Commit src/math.mjs' });
      expect(result.messages.some((entry) => String(entry.content).includes('both staged and unstaged'))).toBe(true);
      expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projDir, encoding: 'utf8' })).toBe(before);
      expect(execFileSync('git', ['show', ':src/math.mjs'], { cwd: projDir, encoding: 'utf8' })).toBe('staged content\n');
      expect(fs.readFileSync(file, 'utf8')).toBe('unstaged content\n');
    } finally { conn.close(); }
  });
});

describe('Auto session mode', () => {
  it.each([false, true, 'answer'] as const)('recovers an orphaned failed task only when its checkpoint has no code changes (changed=%s)', async (mode) => {
    const changed = mode === true;
    const runner = new SessionModesFakeRunner();
    const { conn, leadSvc, project, projDir } = await setupProjectWithSeededBug(runner);
    try {
      const work = leadSvc.createDirectApprovedTask(project.id, {
        sessionTitle: 'Earlier work', userMessage: 'Fix code', title: 'Fix', goal: 'Fix code',
        filesAllowed: ['src/math.mjs'], acceptanceCriteria: ['Tests pass'], verify: 'node --test',
      });
      const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projDir, encoding: 'utf8' }).trim();
      if (changed) {
        fs.writeFileSync(path.join(projDir, 'src/math.mjs'), 'export const changed = true;\n');
        execFileSync('git', ['add', 'src/math.mjs'], { cwd: projDir });
      } else {
        const result = `.dalang/sessions/${work.session.id}/tasks/T-001/result.json`;
        fs.mkdirSync(path.dirname(path.join(projDir, result)), { recursive: true });
        fs.writeFileSync(path.join(projDir, result), '{}');
        execFileSync('git', ['add', '-f', result], { cwd: projDir });
        if (mode === 'answer') {
          const answer = `.dalang/sessions/${work.session.id}/tasks/T-001/answer.md`;
          fs.writeFileSync(path.join(projDir, answer), '# Draft\n');
          execFileSync('git', ['add', '-f', answer], { cwd: projDir });
        }
      }
      execFileSync('git', ['commit', '-m', 'Checkpoint'], { cwd: projDir, stdio: 'pipe' });
      const after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projDir, encoding: 'utf8' }).trim();
      conn.sqlite.prepare("update tasks set status = 'failed', branch_name = 'dalang/T-001' where id = ?").run(work.task.id);
      conn.sqlite.prepare("insert into runs (id, project_id, task_id, profile_id, provider, status, started_at, finished_at, commit_before, commit_after, log_path, worktree_path) values (?, ?, ?, 'profile-coder-small', 'claude-code', 'failed', ?, ?, ?, ?, 'run.log', ?)")
        .run('run-1', project.id, work.task.id, new Date().toISOString(), new Date().toISOString(), before, after, path.join(projDir, 'missing-worktree'));
      leadSvc.markSessionWorking(project.id, work.session.id);
      await leadSvc.sendChatMessage(project.id, { mode: 'auto', message: 'What happened?' });
      expect(leadSvc.getSession(project.id, work.session.id).workState).toBe(changed ? 'working' : 'idle');
      expect(leadSvc.hasSessionUnfinishedWork(work.session.id)).toBe(changed);
    } finally {
      conn.close();
    }
  });
  it('answers and asks for sensitive approval without dispatching work', async () => {
    const runner = new SessionModesFakeRunner();
    runner.autoResponse = { answer: 'This changes production data. May I proceed?', auto_plan: null };
    const { conn, leadSvc, project } = await setupProjectWithSeededBug(runner);
    const started: string[] = [];
    leadSvc.setExecutionRouter({
      listActiveRunsForSession: () => [],
      steerTask: async () => {},
      startExecution: async (_projectId, input) => { started.push(input.sessionId); },
    });
    try {
      const result = await leadSvc.sendChatMessage(project.id, { mode: 'auto', message: 'Update production data' });
      expect(result.session.mode).toBe('auto');
      expect(result.askReply?.text).toContain('May I proceed');
      expect(leadSvc.getPlan(project.id, result.session.id)).toBeNull();
      expect(started).toEqual([]);
      expect(runner.calls.find((call) => call.prompt.includes('Lead in DALANG Auto mode'))?.prompt)
        .toContain('production or user data');
    } finally {
      conn.close();
    }
  });

  it('validates and dispatches a multi-task plan in the same session', async () => {
    const runner = new SessionModesFakeRunner();
    const task = (id: string, file: string, depends_on: string[]) => ({
      id, title: id, milestone: 'M1', role: 'engineer', complexity: 'low', depends_on,
      goal: `Fix ${file}`, files_allowed: [file], files_reference: [],
      acceptance_criteria: ['Tests pass'], verify: 'node --test', needs_split: false,
    });
    runner.autoResponse = {
      answer: 'I will implement this.',
      auto_plan: { milestones: [{ id: 'M1', title: 'Fix' }], tasks: [
        task('T-001', 'src/math.mjs', []), task('T-002', 'src/math.test.mjs', ['T-001']),
      ] },
    };
    const { conn, leadSvc, project } = await setupProjectWithSeededBug(runner);
    const started: string[] = [];
    leadSvc.setExecutionRouter({
      listActiveRunsForSession: () => [],
      steerTask: async () => {},
      startExecution: async (_projectId, input) => { started.push(input.sessionId); },
    });
    try {
      // Two or more tasks wait for approval, as T3 Code's proposed plans wait for "implement".
      const result = await leadSvc.sendChatMessage(project.id, { mode: 'auto', message: 'Fix the math code' });
      let plan = leadSvc.getPlan(project.id, result.session.id);
      expect(plan?.status).toBe('draft');
      expect(plan?.tasks).toHaveLength(2);
      expect(plan?.tasks[1].dependsOn).toEqual(['T-001']);
      expect(started).toEqual([]);
      const planMessage = result.messages.filter((m) => m.type === 'plan').at(-1)?.content as {
        awaitingApproval?: boolean; tasks: Array<{ id: string; dependsOn: string[]; executor: string | null }>;
      };
      expect(planMessage.awaitingApproval).toBe(true);
      expect(planMessage.tasks.map((t) => [t.id, t.dependsOn])).toEqual([['T-001', []], ['T-002', ['T-001']]]);

      // Asking for a change returns a revised plan, again as a draft; one task may name its executor.
      runner.autoResponse = {
        answer: 'Revised plan.',
        auto_plan: { milestones: [{ id: 'M1', title: 'Fix' }], tasks: [
          task('T-001', 'src/math.mjs', []), { ...task('T-002', 'src/math.test.mjs', ['T-001']), profile: 'executor-heavy' },
        ] },
      };
      await leadSvc.sendChatMessage(project.id, { sessionId: result.session.id, mode: 'auto', message: 'run T-002 on the heavy executor' });
      plan = leadSvc.getPlan(project.id, result.session.id);
      expect(plan?.version).toBe(2);
      expect(plan?.status).toBe('draft');
      const heavy = conn.sqlite.prepare("select id from agent_profiles where name = 'executor-heavy'").get() as { id: string };
      expect(plan?.tasks[1].profileOverride).toBe(heavy.id);
      expect(plan?.tasks[0].profileOverride).toBeNull();
      expect(started).toEqual([]);

      leadSvc.approvePlan(project.id, result.session.id);
      expect(leadSvc.getPlan(project.id, result.session.id)?.status).toBe('approved');

      // An unknown executor name is refused with the names that exist.
      runner.autoResponse = {
        answer: 'Plan.',
        auto_plan: { milestones: [{ id: 'M1', title: 'Fix' }], tasks: [{ ...task('T-009', 'src/x.mjs', []), profile: 'nobody' }] },
      };
      const other = await leadSvc.sendChatMessage(project.id, { mode: 'auto', message: 'Fix x' });
      const error = other.messages.filter((m) => m.type === 'error').at(-1)?.content;
      expect(String(error)).toContain('unknown executor profile "nobody"');
    } finally {
      conn.close();
    }
  });

  it('reports a blocking session instead of promising to start Auto work', async () => {
    const runner = new SessionModesFakeRunner();
    runner.autoResponse = {
      answer: 'I will implement this.',
      auto_plan: { milestones: [{ id: 'M1', title: 'Fix' }], tasks: [{
        id: 'T-001', title: 'Fix', milestone: 'M1', role: 'engineer', complexity: 'low',
        depends_on: [], goal: 'Fix code', files_allowed: ['src/math.mjs'], files_reference: [],
        acceptance_criteria: ['Tests pass'], verify: 'node --test', needs_split: false,
      }] },
    };
    const { conn, leadSvc, project } = await setupProjectWithSeededBug(runner);
    const started: string[] = [];
    const discarded: string[] = [];
    leadSvc.setExecutionRouter({
      listActiveRunsForSession: () => [],
      steerTask: async () => {},
      startExecution: async (_projectId, input) => { started.push(input.sessionId); },
      discardSessionWork: async (_projectId, sessionId) => {
        discarded.push(sessionId);
        conn.sqlite.prepare("update sessions set work_state = 'idle' where id = ?").run(sessionId);
      },
    });
    try {
      const blockingWork = leadSvc.createDirectApprovedTask(project.id, {
        sessionTitle: 'Earlier work', userMessage: 'Previous task', title: 'Previous task', goal: 'Fix code',
        filesAllowed: ['src/math.mjs'], acceptanceCriteria: ['Tests pass'], verify: 'node --test',
      });
      const blocker = blockingWork.session;
      leadSvc.markSessionWorking(project.id, blocker.id);
      const result = await leadSvc.sendChatMessage(project.id, { mode: 'auto', message: 'Fix the code' });
      expect(result.askReply?.text).toContain('Earlier work');
      expect(result.askReply?.text).not.toContain('I will implement');
      expect(leadSvc.getPlan(project.id, result.session.id)).toBeNull();
      expect(started).toEqual([]);
      expect(runner.calls.find((call) => call.prompt.includes('Lead in DALANG Auto mode'))?.prompt)
        .toContain('Earlier work');
      expect(result.askReply?.text).toContain('uncommitted files');
      const declined = await leadSvc.sendChatMessage(project.id, { sessionId: result.session.id, mode: 'auto', message: 'no' });
      expect(declined.askReply?.text).toContain('has not started');
      expect(discarded).toEqual([]);
      await leadSvc.sendChatMessage(project.id, { sessionId: result.session.id, mode: 'auto', message: 'Fix the code' });
      conn.sqlite.prepare("update tasks set status = 'failed' where id = ?").run(blockingWork.task.id);
      const changed = await leadSvc.sendChatMessage(project.id, { sessionId: result.session.id, mode: 'auto', message: 'yes' });
      expect(changed.askReply?.text).toContain('changed since the previous request');
      expect(discarded).toEqual([]);
      const approved = await leadSvc.sendChatMessage(project.id, { sessionId: result.session.id, mode: 'auto', message: 'yes' });
      expect(discarded).toEqual([blocker.id]);
      expect(started).toEqual([result.session.id]);
      expect(approved.askReply?.text).toMatch(/started the requested work/i);
      expect(leadSvc.getPlan(project.id, result.session.id)?.status).toBe('approved');
    } finally {
      conn.close();
    }
  });

  it('separates live activity from saved approval/branch work and lets Auto discard recovered idle session work on yes', async () => {
    const runner = new SessionModesFakeRunner();
    runner.autoResponse = {
      answer: 'I will implement this.',
      auto_plan: {
        milestones: [{ id: 'M1', title: 'Fix' }],
        tasks: [{
          id: 'T-001', title: 'Fix', milestone: 'M1', role: 'engineer', complexity: 'low',
          depends_on: [], goal: 'Fix code', files_allowed: ['src/math.mjs'], files_reference: [],
          acceptance_criteria: ['Tests pass'], verify: 'node --test', needs_split: false,
        }],
      },
    };
    const { conn, leadSvc, project } = await setupProjectWithSeededBug(runner);
    const started: string[] = [];
    const discarded: string[] = [];
    leadSvc.setExecutionRouter({
      listActiveRunsForSession: () => [],
      steerTask: async () => {},
      startExecution: async (_projectId, input) => { started.push(input.sessionId); },
      discardSessionWork: async (_projectId, sessionId) => {
        discarded.push(sessionId);
        conn.sqlite.prepare("update tasks set status = 'failed', branch_name = null where plan_id in (select id from plans where session_id = ?)").run(sessionId);
        conn.sqlite.prepare("update sessions set work_state = 'idle' where id = ?").run(sessionId);
      },
    });
    try {
      const work = leadSvc.createDirectApprovedTask(project.id, {
        sessionTitle: 'Recovered chat', userMessage: 'Previous task', title: 'Previous task', goal: 'Fix code',
        filesAllowed: ['src/math.mjs'], acceptanceCriteria: ['Tests pass'], verify: 'node --test',
      });
      conn.sqlite.prepare("update tasks set status = 'awaiting_merge', branch_name = 'dalang/T-001' where id = ?").run(work.task.id);
      leadSvc.markSessionWorking(project.id, work.session.id);

      expect(leadSvc.hasSessionLiveActivity(work.session.id)).toBe(false);
      expect(leadSvc.hasSessionPendingApprovalOrBranch(work.session.id)).toBe(true);
      expect(leadSvc.recoverSessionToIdleIfInactive(work.session.id)).toBe(true);
      expect(leadSvc.recoverSessionToIdleIfInactive(work.session.id)).toBe(false);
      expect(leadSvc.getSession(project.id, work.session.id).workState).toBe('idle');
      expect(leadSvc.hasSessionUnfinishedWork(work.session.id)).toBe(true);
      expect(() => leadSvc.updateSession(project.id, work.session.id, { archived: true })).toThrow(/unfinished work/i);

      const ask = await leadSvc.sendChatMessage(project.id, {
        sessionId: work.session.id,
        mode: 'auto',
        message: 'Start a fresh fix',
      });
      // Same chat, so the question offers to replace its own unfinished tasks.
      expect(ask.askReply?.text).toContain('This chat already has a plan');
      expect(started).toEqual([]);

      const confirmed = await leadSvc.sendChatMessage(project.id, {
        sessionId: work.session.id,
        mode: 'auto',
        message: 'yes',
      });
      expect(discarded).toEqual([work.session.id]);
      expect(started).toEqual([work.session.id]);
      expect(confirmed.askReply?.text).toMatch(/started the requested work/i);
    } finally {
      conn.close();
    }
  });

  it("asks to replace this chat's own unfinished plan, not to discard another session", async () => {
    const runner = new SessionModesFakeRunner();
    runner.autoResponse = {
      answer: 'I will split the failed task.',
      auto_plan: { milestones: [{ id: 'M1', title: 'Fix' }], tasks: [{
        id: 'T-002', title: 'Smaller fix', milestone: 'M1', role: 'engineer', complexity: 'low',
        depends_on: [], goal: 'Fix code', files_allowed: ['src/math.mjs'], files_reference: [],
        acceptance_criteria: ['Tests pass'], verify: 'node --test', needs_split: false,
      }] },
    };
    const { conn, leadSvc, project } = await setupProjectWithSeededBug(runner);
    const started: string[] = [];
    const discarded: string[] = [];
    leadSvc.setExecutionRouter({
      listActiveRunsForSession: () => [],
      steerTask: async () => {},
      startExecution: async (_projectId, input) => { started.push(input.sessionId); },
      discardSessionWork: async (_projectId, sessionId) => {
        discarded.push(sessionId);
        conn.sqlite.prepare("update tasks set status = 'failed', branch_name = null where status = 'review_failed'").run();
        conn.sqlite.prepare("update sessions set work_state = 'idle' where id = ?").run(sessionId);
      },
    });
    try {
      const own = leadSvc.createDirectApprovedTask(project.id, {
        sessionTitle: 'Phase work', userMessage: 'Big task', title: 'Big task', goal: 'Fix code',
        filesAllowed: ['src/math.mjs'], acceptanceCriteria: ['Tests pass'], verify: 'node --test',
      });
      conn.sqlite.prepare("update tasks set status = 'review_failed', branch_name = 'dalang/T-001' where id = ?").run(own.task.id);
      leadSvc.markSessionWorking(project.id, own.session.id);

      const result = await leadSvc.sendChatMessage(project.id, { sessionId: own.session.id, mode: 'auto', message: 'split it and continue' });
      const text = result.askReply?.text ?? '';
      expect(text).toContain('This chat already has a plan with unfinished tasks (1 failed review)');
      expect(text).toContain('new plan of 1 task(s)');
      expect(text).toContain('"Big task"');
      expect(text).not.toContain('Session "Phase work"');
      expect(started).toEqual([]);

      const approved = await leadSvc.sendChatMessage(project.id, { sessionId: own.session.id, mode: 'auto', message: 'yes' });
      expect(discarded).toEqual([own.session.id]);
      expect(started).toEqual([own.session.id]);
      expect(approved.askReply?.text).toContain('Replaced the unfinished tasks of this chat');
      expect(leadSvc.getPlan(project.id, own.session.id)?.tasks.map((t) => t.externalId)).toEqual(['T-002']);
    } finally {
      conn.close();
    }
  });

  it('stops running execution when Lead returns auto_stop in Auto mode', async () => {
    const runner = new SessionModesFakeRunner();
    runner.autoResponse = {
      answer: 'Stopping all running tasks now.',
      auto_plan: null,
      auto_stop: true,
    };
    const { conn, leadSvc, project } = await setupProjectWithSeededBug(runner);
    const stoppedCalls: Array<{ projectId: string; taskId?: string; sessionId?: string }> = [];
    leadSvc.setExecutionRouter({
      listActiveRunsForSession: () => [{
        taskId: 't1',
        externalId: 'db-v16',
        runId: 'r1',
        profileId: 'profile-coder-medium',
        profileName: 'executor-medium',
        kind: 'execute',
        canSteer: false,
      }],
      steerTask: async () => {},
      stopExecution: async (pid, taskId, sid) => {
        stoppedCalls.push({ projectId: pid, taskId, sessionId: sid });
        return { stopped: true };
      },
    });
    try {
      const result = await leadSvc.sendChatMessage(project.id, { mode: 'auto', message: 'stop dulu semuanya' });
      expect(stoppedCalls).toEqual([{ projectId: project.id, taskId: undefined, sessionId: result.session.id }]);
      expect(result.messages.some((m) => String(m.content).includes('Stopped running execution.'))).toBe(true);
      expect(runner.calls.find((c) => c.prompt.includes('Lead in DALANG Auto mode'))?.prompt).toContain('[db-v16]');
    } finally {
      conn.close();
    }
  });

  it('aborts an in-flight Lead turn via stopTurns and releases the lock', async () => {
    let startedResolve!: () => void;
    const turnStarted = new Promise<void>((resolve) => { startedResolve = resolve; });
    const runner: CliRunner = {
      async which(bin) { return `/usr/bin/${bin}`; },
      async run(_cmd, _args, opts) {
        startedResolve();
        return new Promise((resolve) => {
          opts.signal?.addEventListener('abort', () => {
            resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false, idleTimedOut: false, aborted: true });
          }, { once: true });
        });
      },
    };
    const { conn, leadSvc, project } = await setupProjectWithSeededBug(runner);
    try {
      const chatPromise = leadSvc.sendChatMessage(project.id, { mode: 'auto', message: 'analyze repo' });
      await turnStarted;
      const stopRes = await leadSvc.stopTurns(project.id);
      expect(stopRes).toEqual({ stopped: true });
      await expect(chatPromise).rejects.toThrow('Stopped by user');
      // After stopTurns resolves, no active turn remains.
      expect(await leadSvc.stopTurns(project.id)).toEqual({ stopped: false });
    } finally {
      conn.close();
    }
  });
});

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
        message: 'Kenapa add(2, 3) gagal di src/math.mjs?',
      });
      expect(askTurn.session.mode).toBe('ask');
      expect(askTurn.session.workState).toBe('idle');
      expect(askTurn.session.title).toContain('Kenapa add(2, 3) gagal');
      expect(leadSvc.listSessions(project.id)).toHaveLength(1);

      // Verify Ask adapter call ran read-only (plan mode in Claude Code)
      const askCall = runner.calls.find((c) => c.prompt.includes('Ask mode (read-only'));
      expect(askCall).toBeDefined();
      expect(askCall!.args).toContain('plan');
      expect(askCall!.prompt).toContain('match the language of the latest user question');
      expect(askCall!.prompt).toContain('falling back to English');

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
      expect(fallbackCall.prompt).toContain('Completed work in this session:');
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

      // Verify both Lead turns (Quick + Discuss) are recorded in usage statistics
      const statsSvc = new StatisticsService(conn.db);
      const stats = statsSvc.getUsageStatistics({ projectId: project.id });
      expect(stats.totals.totalRuns).toBe(2);
      expect(stats.totals.completedRuns).toBe(2);
      const claudeStats = stats.providers.find((p) => p.provider === 'claude-code')!;
      expect(claudeStats.totalRuns).toBe(2);
      expect(claudeStats.byKind.lead).toBe(2);
    } finally {
      conn.close();
    }
  });

  it('backfills historical Lead turns from existing .dalang log files (Claude and Antigravity) on database open', async () => {
    const dbDir = makeTempDir('dalang-v07-backfill-db-');
    const projDir = path.join(makeTempDir('dalang-v07-backfill-proj-'), 'app');
    initSeededBugRepo(projDir);
    const dbPath = path.join(dbDir, 'dalang.db');

    const conn1 = openDatabase(dbPath);
    const projectSvc = new ProjectService(conn1.db);
    const project = await projectSvc.createOrOpen({
      mode: 'open',
      path: projDir,
      name: 'Backfill App',
      initGitIfMissing: false,
      leadProvider: 'claude-code',
    });

    const sessId = '2d47369c-d1f2-4614-9847-02480ce03cbb';
    const now = new Date().toISOString();
    conn1.sqlite
      .prepare(
        `INSERT INTO sessions (id, project_id, title, mode, work_state, phase, provider, model, created_at, updated_at)
         VALUES (?, ?, 'halo', 'full', 'idle', 'discuss', 'antigravity', 'gemini-4-hydrogen', ?, ?)`,
      )
      .run(sessId, project.id, now, now);

    // Write a Claude Ask log and an Antigravity Discuss log on disk
    const tmpDir = path.join(projDir, '.dalang', 'tmp');
    const sessLogsDir = path.join(projDir, '.dalang', 'sessions', sessId, 'logs');
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(sessLogsDir, { recursive: true });

    const tsNow = Date.now();
    fs.writeFileSync(
      path.join(tmpDir, `ask-${sessId}-${tsNow - 60_000}.log`),
      [
        JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-5-5', session_id: 'c-1', claude_code_version: '2.1.0' }),
        JSON.stringify({
          type: 'result',
          session_id: 'c-1',
          duration_ms: 3200,
          total_cost_usd: 0.052,
          is_error: false,
          usage: {
            input_tokens: 100,
            output_tokens: 350,
            cache_read_input_tokens: 10000,
            cache_creation_input_tokens: 5000,
          },
        }),
      ].join('\n') + '\n',
    );

    fs.writeFileSync(
      path.join(sessLogsDir, `discuss-round-1-${tsNow - 30_000}.log`),
      [
        JSON.stringify({ event: 'init', conversation_id: 'agy-1', init: { model: 'gemini-4-hydrogen' } }),
        JSON.stringify({
          event: 'result',
          result: {
            conversation_id: 'agy-1',
            status: 'SUCCESS',
            duration_seconds: 12.4,
            usage: {
              input_tokens: 20000,
              output_tokens: 2500,
              cache_read_tokens: 35000,
            },
          },
        }),
      ].join('\n') + '\n',
    );
    conn1.close();

    // Reopen database -> backfillLeadTurnsFromDisk populates lead_turns from those 2 logs
    const conn2 = openDatabase(dbPath);
    try {
      const stats = new StatisticsService(conn2.db).getUsageStatistics({ projectId: project.id });
      expect(stats.totals.totalRuns).toBe(2);
      expect(stats.totals.completedRuns).toBe(2);
      expect(stats.totals.inputTokens).toBe(20100);
      expect(stats.totals.outputTokens).toBe(2850);
      expect(stats.totals.cacheReadTokens).toBe(45000);
      expect(stats.totals.cacheWriteTokens).toBe(5000);
      expect(stats.totals.totalDurationMs).toBe(15600);
      expect(stats.totals.estimatedCostUsd).toBeGreaterThan(0.052);

      const agyStats = stats.providers.find((p) => p.provider === 'antigravity')!;
      expect(agyStats.totalRuns).toBe(1);
      expect(agyStats.byKind.lead).toBe(1);
      expect(agyStats.cacheReadTokens).toBe(35000);

      const claudeStats = stats.providers.find((p) => p.provider === 'claude-code')!;
      expect(claudeStats.totalRuns).toBe(1);
      expect(claudeStats.byKind.lead).toBe(1);
    } finally {
      conn2.close();
    }
  });
});
