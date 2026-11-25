import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, describe, expect, it } from 'vitest';
import type { RoomReportContent } from '@dalang/shared';
import { ProviderRegistry } from '../adapters/registry.js';
import { openDatabase } from '../db/client.js';
import { AutomationService } from '../services/automation.js';
import { DalangEventBus } from '../services/events.js';
import { ExecutionService } from '../services/executor.js';
import { ExternalMcpService, ExternalMcpTokenService } from '../services/external-mcp.js';
import { LeadService } from '../services/lead.js';
import { ProfileService } from '../services/profiles.js';
import { ProjectService } from '../services/project.js';
import type { CliRunner, RunCommandOptions, RunCommandResult } from '../adapters/types.js';

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface MockCall {
  cmd: string;
  args: string[];
  cwd: string;
  prompt: string;
}

function createGeneralTaskRunner(options: {
  onExecute: (ctx: {
    extId: string;
    cwd: string;
    prompt: string;
    resultPath: string;
    answerPath: string | null;
    attempt: number;
  }) => void;
  onReview: (ctx: {
    extId: string;
    cwd: string;
    prompt: string;
    round: number;
  }) => { status: 'pass' | 'fail'; summary: string; findings?: Array<{ severity: 'critical' | 'major' | 'minor' | 'info'; file: string; note: string }> };
}): { runner: CliRunner; calls: MockCall[]; shellCommands: string[] } {
  const calls: MockCall[] = [];
  const shellCommands: string[] = [];
  const execAttempts = new Map<string, number>();

  const runner: CliRunner = {
    async which(bin) {
      if (bin === 'bwrap' || bin === 'sandbox-exec') return null;
      return `/usr/local/bin/${bin}`;
    },
    async run(cmd, args, opts: RunCommandOptions): Promise<RunCommandResult> {
      const base = path.basename(cmd).toLowerCase();
      if (args[0] === '--version') {
        return { exitCode: 0, stdout: '1.0.0\n', stderr: '', timedOut: false, idleTimedOut: false };
      }
      if (cmd.includes('claude') && args[0] === 'auth') {
        return { exitCode: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: '', timedOut: false, idleTimedOut: false };
      }
      if (cmd.includes('codex') && args[0] === 'login') {
        return { exitCode: 0, stdout: 'Logged in\n', stderr: '', timedOut: false, idleTimedOut: false };
      }
      if (base === 'sh' || base === 'cmd.exe') {
        shellCommands.push(args.join(' '));
        return { exitCode: 0, stdout: 'unexpected shell run\n', stderr: '', timedOut: false, idleTimedOut: false };
      }

      const prompt = args.join(' ');
      calls.push({ cmd, args, cwd: opts.cwd, prompt });

      const emit = (text: string, sessionId = 'mock-sess'): RunCommandResult => {
        const line = cmd.includes('codex')
          ? JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } })
          : JSON.stringify({ type: 'result', session_id: sessionId, result: text });
        opts.onStdoutLine?.(line);
        return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
      };

      const reviewMatch = prompt.match(/review round (\d+) of \d+ for (?:answer )?task ([A-Za-z0-9_-]+)/i);
      if (reviewMatch) {
        const round = Number(reviewMatch[1]);
        const extId = reviewMatch[2];
        const verdict = options.onReview({ extId, cwd: opts.cwd, prompt, round });
        return emit(
          JSON.stringify({
            task_id: extId,
            status: verdict.status,
            verify_exit_code: null,
            summary: verdict.summary,
            findings: verdict.findings ?? [],
          }),
          `rev-${extId}-${round}`,
        );
      }

      const taskMatch =
        prompt.match(/You are (?:executing|fixing) task ([A-Za-z0-9_-]+):/) ??
        prompt.match(/Review round \d+ FAILED for task ([A-Za-z0-9_-]+):/);
      if (taskMatch) {
        const extId = taskMatch[1];
        const attempt = (execAttempts.get(extId) ?? 0) + 1;
        execAttempts.set(extId, attempt);
        const resPathMatch = prompt.match(/"(\.dalang\/[^"]+result\.json)"/);
        const ansPathMatch = prompt.match(/"(\.dalang\/[^"]+answer\.md)"/);
        const resultPath = resPathMatch?.[1] ?? `.dalang/tasks/${extId}/result.json`;
        const answerPath = ansPathMatch?.[1] ?? null;
        options.onExecute({ extId, cwd: opts.cwd, prompt, resultPath, answerPath, attempt });
        return emit('completed', `exec-${extId}-${attempt}`);
      }

      // Ask mode follow-up turn
      return emit(JSON.stringify({ answer: 'Follow-up acknowledged.', suggested_mode: null }), 'lead-ask');
    },
  };

  return { runner, calls, shellCommands };
}

async function setupHarness(runner: CliRunner) {
  const dbDir = makeTempDir('dalang-v014-db-');
  const projDir = path.join(makeTempDir('dalang-v014-proj-'), 'workspace');
  const conn = openDatabase(path.join(dbDir, 'dalang.db'));
  const events = new DalangEventBus();
  const registry = new ProviderRegistry(runner, { antigravityKeyringAccess: () => false });
  const projectSvc = new ProjectService(conn.db);
  const profileSvc = new ProfileService(conn.db);
  // Keep reviewer on claude-code so tests do not require agy keyring.
  profileSvc.updateProfile('profile-reviewer', { provider: 'claude-code', model: '' });
  const leadSvc = new LeadService(conn.db, registry, events);
  const execSvc = new ExecutionService(conn.db, registry, leadSvc, events);
  const autoSvc = new AutomationService(conn.db, leadSvc, execSvc, events);
  const tokenSvc = new ExternalMcpTokenService(conn.db);
  const mcpSvc = new ExternalMcpService(conn.db, tokenSvc, projectSvc, leadSvc, execSvc, autoSvc);

  const project = await projectSvc.createOrOpen({
    mode: 'create',
    name: 'General Tasks Workspace',
    path: projDir,
    initGitIfMissing: false,
    leadProvider: 'claude-code',
  });

  // Add a baseline tracked file so we can test answer-task read access and scope violation detection.
  fs.writeFileSync(path.join(projDir, 'notes.md'), '# Project Notes\nBaseline facts: Q3 revenue was $120k.\n');
  const git = simpleGit(projDir);
  await git.add('notes.md');
  await git.commit('Add baseline project notes');

  return { conn, projectSvc, profileSvc, leadSvc, execSvc, autoSvc, tokenSvc, mcpSvc, project, projDir, git };
}

describe('v0.14 general tasks (optional verify & answer tasks)', () => {
  it('runs a files task with no verify command: skips verify, reviews criteria directly, and merges cleanly', async () => {
    let capturedReviewPrompt = '';
    const { runner, shellCommands } = createGeneralTaskRunner({
      onExecute: ({ extId, cwd, resultPath }) => {
        const docPath = path.join(cwd, 'docs', 'summary.md');
        fs.mkdirSync(path.dirname(docPath), { recursive: true });
        fs.writeFileSync(docPath, '# Executive Summary\n\nQ3 revenue reached $120k.\n');
        const absRes = path.join(cwd, resultPath);
        fs.mkdirSync(path.dirname(absRes), { recursive: true });
        fs.writeFileSync(
          absRes,
          JSON.stringify({
            task_id: extId,
            status: 'completed',
            changed_files: ['docs/summary.md'],
            verify_command: null,
            summary: 'Drafted docs/summary.md based on notes.md',
          }),
        );
      },
      onReview: ({ prompt }) => {
        capturedReviewPrompt = prompt;
        return { status: 'pass', summary: 'Summary matches notes.md and meets all criteria.' };
      },
    });

    const h = await setupHarness(runner);
    try {
      const { session, task } = h.leadSvc.createDirectApprovedTask(h.project.id, {
        sessionTitle: 'Draft executive summary',
        userMessage: 'Draft docs/summary.md citing notes.md.',
        title: 'Write docs/summary.md',
        goal: 'Write a concise summary in docs/summary.md citing notes.md.',
        output: 'files',
        filesAllowed: ['docs/summary.md'],
        filesReference: ['notes.md'],
        acceptanceCriteria: ['docs/summary.md exists', 'Mentions $120k Q3 revenue'],
        verify: null,
      });

      expect(task.output).toBe('files');
      expect(task.verify).toBeNull();

      await h.execSvc.startExecution(h.project.id, { sessionId: session.id, allowUnconfined: true });
      await h.execSvc.waitForProjectExecution(h.project.id);

      // Verify step was skipped — no shell verify command ran.
      expect(shellCommands).toHaveLength(0);
      expect(capturedReviewPrompt).toContain('Verify step: skipped');
      expect(capturedReviewPrompt).toContain('Judge every acceptance criterion directly');

      const guard = await h.execSvc.getGuardState(h.project.id, session.id);
      const entry = guard.tasks[0];
      expect(entry.task.status).toBe('awaiting_merge');
      expect(entry.latestReview?.status).toBe('pass');
      expect(entry.latestReview?.verifyCommand).toBeNull();
      expect(entry.latestReview?.verifyExitCode).toBeNull();

      // Session transcript records verify skipped (not exit 0).
      const detail = h.leadSvc.getSessionDetail(h.project.id, session.id);
      const verifyReport = detail.messages
        .filter((m) => m.type === 'report')
        .map((m) => m.content as RoomReportContent)
        .find((r) => r.event === 'verify_result');
      expect(verifyReport?.verifySkipped).toBe(true);
      expect(verifyReport?.verifyExitCode).toBeNull();

      const diff = await h.execSvc.getTaskDiffForTask(h.project.id, task.id);
      expect(diff.output).toBe('files');
      expect(diff.files.some((f) => f.path === 'docs/summary.md')).toBe(true);

      const merged = await h.execSvc.approveMergeTask(h.project.id, task.id, {
        runIntegration: false,
        allowUnconfined: true,
      });
      expect(merged.task.status).toBe('done');
      expect(merged.mergeCommitSha).toBeTruthy();
      expect(fs.readFileSync(path.join(h.projDir, 'docs', 'summary.md'), 'utf8')).toContain('$120k');
    } finally {
      h.conn.close();
    }
  });

  it('runs an answer task end-to-end: catches scope violations, reviews answer.md, accepts without git merge, and cleans up on reject', async () => {
    const answerMarkdown = '# Q3 Revenue Brief\n\n- Reported Q3 revenue: **$120k** (source: `notes.md`).\n';
    const reviewPrompts: string[] = [];

    const { runner, calls, shellCommands } = createGeneralTaskRunner({
      onExecute: ({ extId, cwd, prompt, resultPath, answerPath, attempt }) => {
        const targetAnswer = answerPath ?? `.dalang/tasks/${extId}/answer.md`;
        const absAns = path.join(cwd, targetAnswer);
        fs.mkdirSync(path.dirname(absAns), { recursive: true });
        const markdown = prompt.includes('Produce an answer we will reject') ? '# Rejected draft\n' : answerMarkdown;
        fs.writeFileSync(absAns, markdown);

        if (extId === 'T-001' && attempt === 1) {
          // Deliberately modify a project file to trigger an answer-task scope violation!
          fs.appendFileSync(path.join(cwd, 'notes.md'), '\nUnauthorized edit\n');
        } else if (extId === 'T-001' && attempt === 2) {
          // Revert unauthorized edit during fix round.
          fs.writeFileSync(path.join(cwd, 'notes.md'), '# Project Notes\nBaseline facts: Q3 revenue was $120k.\n');
        }

        const absRes = path.join(cwd, resultPath);
        fs.mkdirSync(path.dirname(absRes), { recursive: true });
        fs.writeFileSync(
          absRes,
          JSON.stringify({
            task_id: extId,
            status: 'completed',
            changed_files: [],
            verify_command: null,
            summary: 'Wrote Q3 revenue summary answer',
            answer: markdown,
          }),
        );
      },
      onReview: ({ prompt, round }) => {
        reviewPrompts.push(prompt);
        if (round === 1 && prompt.includes('notes.md') && !prompt.includes('Scope violations (project files modified by an answer task):\n- None')) {
          return {
            status: 'fail',
            summary: 'Answer task modified project file notes.md.',
            findings: [{ severity: 'major', file: 'notes.md', note: 'Revert all edits outside .dalang/.' }],
          };
        }
        return { status: 'pass', summary: 'Answer is accurate and project files are untouched.' };
      },
    });

    const h = await setupHarness(runner);
    try {
      const headBefore = (await h.git.revparse(['HEAD'])).trim();

      const { session, task } = h.leadSvc.createDirectApprovedTask(h.project.id, {
        sessionTitle: 'Answer Q3 question',
        userMessage: 'Summarize Q3 revenue from notes.md.',
        title: 'Summarize Q3 revenue',
        goal: 'Read notes.md and write a short Markdown summary of Q3 revenue without modifying project files.',
        output: 'answer',
        filesAllowed: [],
        filesReference: ['notes.md'],
        acceptanceCriteria: ['Cites $120k from notes.md', 'Leaves all project files unchanged'],
        verify: null,
      });

      await h.execSvc.startExecution(h.project.id, { sessionId: session.id, allowUnconfined: true });
      await h.execSvc.waitForProjectExecution(h.project.id);

      expect(shellCommands).toHaveLength(0);
      // Round 1 caught scope violation on notes.md; round 2 passed after fix reverted it.
      expect(reviewPrompts).toHaveLength(2);
      expect(reviewPrompts[0]).toContain('Scope violations (project files modified by an answer task):');
      expect(reviewPrompts[0]).not.toContain('Scope violations (project files modified by an answer task):\n- None');
      expect(reviewPrompts[0]).toContain('notes.md');
      expect(reviewPrompts[1]).toContain('Q3 Revenue Brief');
      expect(reviewPrompts[1]).toContain('Scope violations (project files modified by an answer task):\n- None');

      const guard = await h.execSvc.getGuardState(h.project.id, session.id);
      const entry = guard.tasks[0];
      expect(entry.task.status).toBe('awaiting_merge');
      expect(entry.task.output).toBe('answer');
      expect(entry.diffAvailable).toBe(true);
      expect(entry.answer).toContain('Q3 Revenue Brief');
      expect(entry.reviews).toHaveLength(2);
      const rev1 = entry.reviews.find((r) => r.round === 1)!;
      const rev2 = entry.reviews.find((r) => r.round === 2)!;
      expect(rev1.status).toBe('fail');
      expect(rev1.scopeWarnings.some((w) => w.includes('notes.md'))).toBe(true);
      expect(rev2.status).toBe('pass');
      expect(rev2.scopeWarnings).toEqual([]);

      // /diff returns the answer content and empty git diff files
      const diff = await h.execSvc.getTaskDiffForTask(h.project.id, task.id);
      expect(diff.output).toBe('answer');
      expect(diff.answer).toContain('$120k');
      expect(diff.files).toEqual([]);

      // Pushing an answer task to git is refused
      await expect(h.execSvc.pushTaskBranchAndPr(h.project.id, task.id)).rejects.toThrow(/answer task/i);

      // Accept the answer (Gate 2)
      const accepted = await h.execSvc.approveMergeTask(h.project.id, task.id, {
        runIntegration: true,
        allowUnconfined: true,
      });
      expect(accepted.task.status).toBe('done');
      expect(accepted.task.mergeCommitSha).toBeNull();
      expect(accepted.mergeCommitSha).toBe('');
      expect(accepted.integrationRun).toBeNull();
      expect(accepted.answerPath).toBe(`.dalang/answers/${task.id}.md`);

      // Saved under the task's own id (external ids like T-001 repeat across sessions)
      const savedAnswerPath = path.join(h.projDir, '.dalang', 'answers', `${task.id}.md`);
      expect(fs.existsSync(savedAnswerPath)).toBe(true);
      expect(fs.readFileSync(savedAnswerPath, 'utf8')).toContain('Q3 Revenue Brief');

      // Main git HEAD is untouched (no merge commit) and worktree/branch are cleaned up
      const headAfter = (await h.git.revparse(['HEAD'])).trim();
      expect(headAfter).toBe(headBefore);
      const branches = await h.git.branchLocal();
      expect(branches.all).not.toContain(task.branchName);

      // Session transcript includes task_accepted report with answer text
      const detail = h.leadSvc.getSessionDetail(h.project.id, session.id);
      const acceptedReport = detail.messages
        .filter((m) => m.type === 'report')
        .map((m) => m.content as RoomReportContent)
        .find((r) => r.event === 'task_accepted');
      expect(acceptedReport).toBeTruthy();
      expect(acceptedReport?.answer).toContain('Q3 Revenue Brief');
      expect(acceptedReport?.answerPath).toBe(`.dalang/answers/${task.id}.md`);

      // Follow-up Ask in the same session receives the accepted answer in context
      await h.leadSvc.sendChatMessage(h.project.id, {
        sessionId: session.id,
        mode: 'ask',
        message: 'What did we conclude about Q3?',
      });
      const askCall = calls[calls.length - 1];
      expect(askCall.prompt).toContain('Completed work in this session:');
      expect(askCall.prompt).toContain(`.dalang/answers/${task.id}.md`);

      // Rejecting a second answer task removes worktree & branch without saving .dalang/answers/
      const second = h.leadSvc.createDirectApprovedTask(h.project.id, {
        sessionTitle: 'Rejected answer task',
        userMessage: 'Draft a rejected answer.',
        title: 'Draft rejected answer',
        goal: 'Produce an answer we will reject.',
        output: 'answer',
        filesAllowed: [],
        acceptanceCriteria: ['Writes an answer'],
        verify: null,
      });
      await h.execSvc.startExecution(h.project.id, { sessionId: second.session.id, allowUnconfined: true });
      await h.execSvc.waitForProjectExecution(h.project.id);

      // The second session's task is also T-001; it must show its own answer, not the accepted one above.
      expect(second.task.externalId).toBe(task.externalId);
      const secondGuard = await h.execSvc.getGuardState(h.project.id, second.session.id);
      expect(secondGuard.tasks[0].answer).toContain('Rejected draft');
      expect(reviewPrompts.at(-1)).toContain('Rejected draft');
      expect(fs.readFileSync(savedAnswerPath, 'utf8')).toContain('Q3 Revenue Brief');

      const rejected = await h.execSvc.rejectTask(h.project.id, second.task.id, {
        note: 'Not needed',
        requeue: false,
      });
      expect(rejected.status).toBe('failed');
      const branchesAfterReject = await h.git.branchLocal();
      expect(branchesAfterReject.all).not.toContain(second.task.branchName);
    } finally {
      h.conn.close();
    }
  });

  it('supports optional verify and answer output in AutomationService and ExternalMcpService', async () => {
    const { runner } = createGeneralTaskRunner({
      onExecute: ({ extId, cwd, resultPath, answerPath }) => {
        const targetAnswer = answerPath ?? `.dalang/tasks/${extId}/answer.md`;
        const absAns = path.join(cwd, targetAnswer);
        fs.mkdirSync(path.dirname(absAns), { recursive: true });
        fs.writeFileSync(absAns, '# Weekly Digest\n\nAll systems steady.\n');
        const absRes = path.join(cwd, resultPath);
        fs.mkdirSync(path.dirname(absRes), { recursive: true });
        fs.writeFileSync(
          absRes,
          JSON.stringify({
            task_id: extId,
            status: 'completed',
            changed_files: [],
            verify_command: null,
            summary: 'Wrote weekly digest',
            answer: '# Weekly Digest\n\nAll systems steady.\n',
          }),
        );
      },
      onReview: () => ({ status: 'pass', summary: 'Digest is complete.' }),
    });

    const h = await setupHarness(runner);
    try {
      const createdAuto = h.autoSvc.createAutomation({
        projectId: h.project.id,
        name: 'Weekly digest',
        kind: 'schedule',
        enabled: true,
        cronExpr: '0 9 * * 1',
        title: 'Write weekly digest',
        prompt: 'Summarize recent project notes.',
        role: 'engineer',
        complexity: 'low',
        output: 'answer',
        filesAllowed: [],
        filesReference: ['notes.md'],
        acceptanceCriteria: ['Includes key numbers'],
        verify: null,
        profileOverride: null,
        allowUnconfined: true,
        autoMerge: false,
      });
      expect(createdAuto.output).toBe('answer');
      expect(createdAuto.verify).toBeNull();

      // External MCP start_task with omitted verify and output='answer' on a repo with no test command
      const createdToken = h.tokenSvc.createToken({
        name: 'General agent',
        accessLevel: 'full-access',
        projectId: h.project.id,
      });
      const auth = h.mcpSvc.authenticate(`Bearer ${createdToken.token}`)!;
      const httpResp = await h.mcpSvc.handleHttpRequest(auth, {
        method: 'POST',
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'start_task',
            arguments: {
              project_id: h.project.id,
              title: 'MCP Answer Digest',
              prompt: 'Summarize notes.md as a standalone answer.',
              output: 'answer',
              acceptance_criteria: ['Summarizes notes.md'],
              allow_unconfined: true,
              wait: true,
            },
          },
        },
      });
      const rpcResp = httpResp.body as { result?: { isError?: boolean; content?: Array<{ text: string }> } };

      expect(rpcResp.result?.isError).not.toBe(true);
      const snapshot = JSON.parse(rpcResp.result!.content![0].text) as {
        status: string;
        output: string;
        verify: string | null;
        answer: string | null;
      };
      expect(snapshot.status).toBe('awaiting_merge');
      expect(snapshot.output).toBe('answer');
      expect(snapshot.verify).toBeNull();
      expect(snapshot.answer).toContain('Weekly Digest');
    } finally {
      h.conn.close();
    }
  });
});
