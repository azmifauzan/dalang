import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AntigravityAdapter } from '../adapters/antigravity.js';
import { ClaudeCodeAdapter } from '../adapters/claude.js';
import { CodexAdapter } from '../adapters/codex.js';
import type { CliRunner, RunCommandOptions, RunCommandResult } from '../adapters/types.js';
import { openDatabase } from '../db/client.js';
import { DalangEventBus, type DalangEvent } from '../services/events.js';
import { ExecutionService } from '../services/executor.js';
import { LeadService } from '../services/lead.js';
import { DelegationSessionStore, handleMcpHttpRequest } from '../services/mcp.js';
import { ProfileService } from '../services/profiles.js';
import { ProjectService } from '../services/project.js';
import { isGlobSubset } from '../services/scheduler.js';
import { SettingsService } from '../services/settings.js';
import { ProviderRegistry } from '../adapters/registry.js';
import {
  cleanupTempDirs,
  handleLeadCalls,
  handleVerifyAndReviewCalls,
  makeTempDir,
  shellCommand,
} from './exec-helpers.js';

afterEach(() => {
  cleanupTempDirs();
});

describe('v0.8 agent delegation', () => {
  describe('isGlobSubset', () => {
    it('accepts exact, wildcard, globstar, and brace-expanded subsets', () => {
      expect(isGlobSubset(['src/auth/login.ts'], ['src/**']).ok).toBe(true);
      expect(isGlobSubset(['src/auth/**'], ['src/**']).ok).toBe(true);
      expect(isGlobSubset(['src/a.ts', 'src/b.ts'], ['src/*.ts']).ok).toBe(true);
      expect(isGlobSubset(['src/{a,b}.ts'], ['src/**']).ok).toBe(true);
      expect(isGlobSubset(['src/*.test.ts'], ['src/*.ts']).ok).toBe(true);
      expect(isGlobSubset(['src/a?.ts'], ['src/a*.ts']).ok).toBe(true);
      expect(isGlobSubset(['src/anything.ts'], []).ok).toBe(true);
    });

    it('rejects wider globs, out-of-scope paths, traversal, and empty child under restricted parent', () => {
      expect(isGlobSubset(['src/**'], ['src/auth/**']).ok).toBe(false);
      expect(isGlobSubset(['tests/auth.test.ts'], ['src/**']).ok).toBe(false);
      expect(isGlobSubset(['src/sub/a.ts'], ['src/*.ts']).ok).toBe(false);
      expect(isGlobSubset(['src/*'], ['src/*.ts']).ok).toBe(false);
      expect(isGlobSubset(['src/a*.ts'], ['src/a?.ts']).ok).toBe(false);
      expect(isGlobSubset(['../secret.ts'], ['src/**']).ok).toBe(false);
      expect(isGlobSubset(['/etc/passwd'], []).ok).toBe(false);
      expect(isGlobSubset([], ['src/**']).ok).toBe(false);
    });
  });

  describe('MCP protocol & scoped bearer tokens', () => {
    it('authenticates active tokens, rejects invalid/revoked tokens, and handles JSON-RPC lifecycle', async () => {
      const store = new DelegationSessionStore();
      const scope = store.issue({
        runId: 'run-1',
        projectId: 'proj-1',
        sessionId: 'sess-1',
        taskId: 'task-1',
        externalId: 'T-001',
        branchName: 'dalang/T-001',
        worktreePath: '/tmp/wt',
        baseMainSha: 'abc',
        delegationDepth: 0,
        filesAllowed: ['src/**'],
        verify: 'npm test',
        parentAccountKey: 'claude-code',
        sandboxReady: true,
      });

      const handler = {
        async delegateTask() {
          throw new Error('not called');
        },
        async getTaskStatus() {
          throw new Error('not called');
        },
        async cancelTask() {
          throw new Error('not called');
        },
      };

      const noAuth = await handleMcpHttpRequest(store, handler, {
        method: 'POST',
        body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      });
      expect(noAuth.statusCode).toBe(401);

      const badAuth = await handleMcpHttpRequest(store, handler, {
        method: 'POST',
        authorizationHeader: 'Bearer wrong-token',
        body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      });
      expect(badAuth.statusCode).toBe(401);

      const initRes = await handleMcpHttpRequest(store, handler, {
        method: 'POST',
        authorizationHeader: `Bearer ${scope.token}`,
        body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
      });
      expect(initRes.statusCode).toBe(200);
      expect((initRes.body as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe('dalang');

      const notifRes = await handleMcpHttpRequest(store, handler, {
        method: 'POST',
        authorizationHeader: `Bearer ${scope.token}`,
        body: { jsonrpc: '2.0', method: 'notifications/initialized' },
      });
      expect(notifRes.statusCode).toBe(202);

      const listRes = await handleMcpHttpRequest(store, handler, {
        method: 'POST',
        authorizationHeader: `Bearer ${scope.token}`,
        body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      });
      expect(listRes.statusCode).toBe(200);
      const tools = (
        listRes.body as {
          result: {
            tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
          };
        }
      ).result.tools;
      expect(tools.map((t) => t.name)).toEqual(['delegate_task', 'task_status', 'task_cancel']);
      expect(tools[0].inputSchema.properties).toHaveProperty('client_request_id');

      store.revoke(scope.token);
      const expiredRes = await handleMcpHttpRequest(store, handler, {
        method: 'POST',
        authorizationHeader: `Bearer ${scope.token}`,
        body: { jsonrpc: '2.0', id: 3, method: 'ping' },
      });
      expect(expiredRes.statusCode).toBe(401);
    });
  });

  describe('Adapter MCP wiring & log secret redaction', () => {
    it('wires MCP config and redacts bearer tokens from logs for Claude and Codex and withholds it from Antigravity', async () => {
      const secret = 'tok_super_secret_delegation_9876543210';
      const workDir = makeTempDir('dalang-mcp-adapt-');
      const captured: Array<{ cmd: string; args: string[]; env?: Record<string, string | undefined>; configContent?: string }> = [];

      const runner: CliRunner = {
        async which(bin) {
          if (bin === 'bwrap' || bin === 'sandbox-exec') return null;
          return `/usr/local/bin/${bin}`;
        },
        async run(cmd, args, opts: RunCommandOptions): Promise<RunCommandResult> {
          let configContent: string | undefined;
          const mcpIdx = args.indexOf('--mcp-config');
          if (mcpIdx >= 0 && args[mcpIdx + 1] && fs.existsSync(args[mcpIdx + 1])) {
            configContent = fs.readFileSync(args[mcpIdx + 1], 'utf8');
          }
          const settingsIdx = args.indexOf('--settings');
          if (settingsIdx >= 0 && args[settingsIdx + 1] && fs.existsSync(args[settingsIdx + 1])) {
            configContent = fs.readFileSync(args[settingsIdx + 1], 'utf8');
          }
          captured.push({ cmd, args: [...args], env: opts.env, configContent });

          // Simulate a naughty CLI trying to echo the bearer token to stdout & stderr.
          const outLine = JSON.stringify({ type: 'result', session_id: 's1', conversation_id: 'c1', result: `leaked ${secret}`, response: `leaked ${secret}` });
          opts.onStdoutLine?.(outLine);
          opts.onStderrLine?.(`stderr token ${secret}`);
          return { exitCode: 0, stdout: `${outLine}\n`, stderr: `stderr token ${secret}\n`, timedOut: false, idleTimedOut: false };
        },
      };

      const claudeLog = path.join(workDir, 'claude.log');
      const claudeLines: string[] = [];
      const claudeRes = await new ClaudeCodeAdapter(runner).runTurn({
        projectPath: workDir,
        prompt: 'hello',
        logFilePath: claudeLog,
        onLogLine: (l) => claudeLines.push(l),
        mcp: { url: 'http://127.0.0.1:4173/mcp', bearerToken: secret },
      });
      expect(captured[0].args).toContain('--mcp-config');
      expect(captured[0].args.join(' ')).not.toContain(secret);
      expect(captured[0].configContent).toContain('http://127.0.0.1:4173/mcp');
      expect(fs.readFileSync(claudeLog, 'utf8')).not.toContain(secret);
      expect(claudeLines.join('\n')).not.toContain(secret);
      expect(claudeRes.stdout).not.toContain(secret);
      expect(claudeRes.stderr).not.toContain(secret);
      // Temp config file was removed in finally
      const claudeCfgPath = captured[0].args[captured[0].args.indexOf('--mcp-config') + 1];
      expect(fs.existsSync(claudeCfgPath)).toBe(false);

      const codexLog = path.join(workDir, 'codex.log');
      const codexLines: string[] = [];
      const codexRes = await new CodexAdapter(runner).runTurn({
        projectPath: workDir,
        prompt: 'hello',
        logFilePath: codexLog,
        onLogLine: (l) => codexLines.push(l),
        mcp: { url: 'http://127.0.0.1:4173/mcp', bearerToken: secret },
      });
      expect(captured[1].args).toContain('mcp_servers.dalang.url="http://127.0.0.1:4173/mcp"');
      expect(captured[1].args).toContain('mcp_servers.dalang.bearer_token_env_var="DALANG_MCP_TOKEN"');
      expect(captured[1].args.join(' ')).not.toContain(secret);
      expect(captured[1].env?.DALANG_MCP_TOKEN).toBe(secret);
      expect(fs.readFileSync(codexLog, 'utf8')).not.toContain(secret);
      expect(codexLines.join('\n')).not.toContain(secret);
      expect(codexRes.stdout).not.toContain(secret);

      await new AntigravityAdapter(runner).runTurn({
        projectPath: workDir,
        prompt: 'hello',
        logFilePath: path.join(workDir, 'agy.log'),
        mcp: { url: 'http://127.0.0.1:4173/mcp', bearerToken: secret },
      });
      // agy rejects per-run MCP servers (`--settings: unknown setting "mcpServers"`), so it gets no MCP config.
      expect(captured[2].args).not.toContain('--settings');
      expect(captured[2].args.join(' ')).not.toContain(secret);
    });
  });

  describe('End-to-end subtask delegation, multi-provider review, merge, and limits', () => {
    async function setupDelegationHarness(
      customRun: (
        execSvcRef: { current: ExecutionService | null },
        cmd: string,
        args: string[],
        opts: RunCommandOptions,
      ) => Promise<RunCommandResult | null>,
      opts: { maxSubtasksPerTask?: number; taskFilesAllowed?: string[] } = {},
    ) {
      const execSvcRef: { current: ExecutionService | null } = { current: null };
      const runner: CliRunner = {
        async which(bin) {
          if (bin === 'bwrap' || bin === 'sandbox-exec') return null;
          return `/usr/local/bin/${bin}`;
        },
        async run(cmd, args, runOpts) {
          const leadReply = handleLeadCalls(runOpts.cwd, args, runOpts);
          if (leadReply) return leadReply;
          const custom = await customRun(execSvcRef, cmd, args, runOpts);
          if (custom) return custom;
          const reviewReply = handleVerifyAndReviewCalls(cmd, args, runOpts, 'pass');
          if (reviewReply) return reviewReply;
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
        },
      };

      const dbDir = makeTempDir('dalang-del-db-');
      const projDir = path.join(makeTempDir('dalang-del-proj-'), 'app');
      const conn = openDatabase(path.join(dbDir, 'dalang.db'));
      const events = new DalangEventBus();
      const capturedEvents: DalangEvent[] = [];
      events.onEvent((e) => capturedEvents.push(e));

      const settingsSvc = new SettingsService(conn.db);
      const registry = new ProviderRegistry(runner, {
        antigravityKeyringAccess: () => settingsSvc.antigravityKeyringAccess(),
      });
      // Route T-001 (engineer/high) -> claude-code, coder-small -> codex, reviewer -> codex (or claude-code cross-model)
      new ProfileService(conn.db).updateProfile('profile-reviewer', { provider: 'codex', model: '' });

      const projectSvc = new ProjectService(conn.db);
      const leadSvc = new LeadService(conn.db, registry, events);
      const execSvc = new ExecutionService(conn.db, registry, leadSvc, events, {
        mcpEndpointUrl: 'http://127.0.0.1:4173/mcp',
        maxSubtasksPerTask: opts.maxSubtasksPerTask ?? 6,
      });
      execSvcRef.current = execSvc;

      const project = await projectSvc.createOrOpen({
        mode: 'create',
        name: 'Delegation App',
        path: projDir,
        stackHint: 'TypeScript',
        initGitIfMissing: false,
        leadProvider: 'claude-code',
      });

      await leadSvc.finishDiscussAndWriteBrief(project.id);
      const briefs = leadSvc.listBriefs(project.id);
      leadSvc.approveBrief(project.id, briefs[0].version);
      const plan = await leadSvc.generatePlan(project.id);
      for (const existing of plan.tasks) {
        leadSvc.deleteTask(project.id, existing.id);
      }
      leadSvc.createTask(project.id, {
        title: 'Build modular feature',
        milestone: 'M1',
        role: 'engineer',
        complexity: 'high',
        dependsOn: [],
        goal: 'Split alpha and beta helpers across providers, then integrate them in src/index.ts',
        filesAllowed: opts.taskFilesAllowed ?? ['src/**'],
        filesReference: ['PROJECT.md'],
        acceptanceCriteria: ['src/alpha.ts, src/beta.ts, and src/index.ts exist and pass tests'],
        verify: 'echo verify-ok',
        needsSplit: false,
        status: 'ready',
      });
      const approvedPlan = leadSvc.approvePlan(project.id);
      return { conn, events, capturedEvents, project, plan: approvedPlan, leadSvc, execSvc, projDir };
    }

    it('splits one task into two subtasks on two providers (wait + async), reviews & merges them into parent branch, then parent review sees combined diff and merges to main', async () => {
      let capturedToken = '';
      let parentReviewPrompt = '';
      const subtaskMcpSeen: boolean[] = [];

      const { conn, capturedEvents, project, plan, leadSvc, execSvc, projDir } = await setupDelegationHarness(
        async (execRef, cmd, args, runOpts) => {
          const joined = `${cmd} ${args.join(' ')}`;
          if (shellCommand(cmd, args) !== null) {
            return { exitCode: 0, stdout: 'verify-ok\n', stderr: '', timedOut: false, idleTimedOut: false };
          }
          // Capture parent review prompt so we verify it sees the combined diff of both subtasks + parent!
          const revMatch = joined.match(/code review round \d+ of \d+ for task ([A-Za-z0-9_-]+)/i);
          if (revMatch) {
            if (revMatch[1] === 'T-001') {
              parentReviewPrompt = args.find((a) => a.includes('Unified diff:')) ?? joined;
            }
            return handleVerifyAndReviewCalls(cmd, args, runOpts, 'pass');
          }

          const taskMatch = joined.match(/You are executing task ([A-Za-z0-9_-]+):/);
          if (!taskMatch) return null;
          const extId = taskMatch[1];
          const resPathMatch = joined.match(/"(\.dalang\/[^\"]+result\.json)"/);
          const relResult = resPathMatch?.[1] ?? `.dalang/tasks/${extId}/result.json`;

          if (extId === 'T-001') {
            // Read the run-scoped bearer token from Claude's --mcp-config temp file
            const mcpIdx = args.indexOf('--mcp-config');
            expect(mcpIdx).toBeGreaterThan(-1);
            const mcpJson = JSON.parse(fs.readFileSync(args[mcpIdx + 1], 'utf8')) as {
              mcpServers: { dalang: { url: string; headers: { Authorization: string } } };
            };
            const authHeader = mcpJson.mcpServers.dalang.headers.Authorization;
            capturedToken = authHeader.replace(/^Bearer\s+/i, '');

            // Subtask 1 on Codex in `wait` mode
            const res1 = await execRef.current!.handleMcpHttpRequest({
              method: 'POST',
              authorizationHeader: authHeader,
              body: {
                jsonrpc: '2.0',
                id: 10,
                method: 'tools/call',
                params: {
                  name: 'delegate_task',
                  arguments: {
                    title: 'Create alpha helper',
                    prompt: 'Write src/alpha.ts exporting alpha()',
                    provider: 'codex',
                    files_allowed: ['src/alpha.ts'],
                    mode: 'wait',
                  },
                },
              },
            });
            expect(res1.statusCode).toBe(200);
            const call1 = (res1.body as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
            expect(call1.isError).toBe(false);
            const sub1 = JSON.parse(call1.content[0].text) as { external_id: string; status: string; merged_into_parent: boolean; provider: string };
            expect(sub1.status).toBe('done');
            expect(sub1.merged_into_parent).toBe(true);
            expect(sub1.provider).toBe('codex');
            // Parent worktree immediately sees alpha.ts merged onto dalang/T-001!
            expect(fs.existsSync(path.join(runOpts.cwd, 'src/alpha.ts'))).toBe(true);

            // Subtask 2 on Claude Code in `async` mode + poll via `task_status`
            // Note: also tests same-provider wait/async delegation without deadlock!
            const res2 = await execRef.current!.handleMcpHttpRequest({
              method: 'POST',
              authorizationHeader: authHeader,
              body: {
                jsonrpc: '2.0',
                id: 11,
                method: 'tools/call',
                params: {
                  name: 'delegate_task',
                  arguments: {
                    title: 'Create beta helper',
                    prompt: 'Write src/beta.ts exporting beta()',
                    provider: 'claude-code',
                    files_allowed: ['src/beta.ts'],
                    mode: 'async',
                  },
                },
              },
            });
            expect(res2.statusCode).toBe(200);
            const call2 = (res2.body as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
            expect(call2.isError).toBe(false);
            const sub2Initial = JSON.parse(call2.content[0].text) as { task_id: string; external_id: string };

            // Check task_status on subtask 1 (already done)
            const status1Res = await execRef.current!.handleMcpHttpRequest({
              method: 'POST',
              authorizationHeader: authHeader,
              body: {
                jsonrpc: '2.0',
                id: 12,
                method: 'tools/call',
                params: { name: 'task_status', arguments: { task_id: sub1.external_id } },
              },
            });
            const st1 = JSON.parse(
              (status1Res.body as { result: { content: Array<{ text: string }> } }).result.content[0].text,
            ) as { merged_into_parent: boolean };
            expect(st1.merged_into_parent).toBe(true);

            // Write parent integration file src/index.ts & result.json (executor will wait for async sub2 before review!)
            fs.mkdirSync(path.join(runOpts.cwd, 'src'), { recursive: true });
            fs.writeFileSync(
              path.join(runOpts.cwd, 'src/index.ts'),
              `export * from './alpha.js';\nexport * from './beta.js';\n`,
            );
            const absRes = path.join(runOpts.cwd, relResult);
            fs.mkdirSync(path.dirname(absRes), { recursive: true });
            fs.writeFileSync(
              absRes,
              JSON.stringify({
                task_id: extId,
                status: 'completed',
                changed_files: ['src/index.ts', 'src/alpha.ts', 'src/beta.ts'],
                summary: `Integrated ${sub1.external_id} and ${sub2Initial.external_id}`,
                notes: [],
                blockers: [],
              }),
            );
            const line = JSON.stringify({ type: 'result', session_id: 'parent-s1', result: `Done (echo ${capturedToken})` });
            runOpts.onStdoutLine?.(line);
            return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
          }

          // Subtask execution (T-001-S1 on codex, T-001-S2 on claude-code)
          const hasMcp =
            args.includes('--mcp-config') ||
            args.some((a) => a.includes('mcp_servers.dalang')) ||
            Boolean(runOpts.env?.DALANG_MCP_TOKEN);
          subtaskMcpSeen.push(hasMcp);

          const isAlpha = joined.includes('src/alpha.ts');
          const fileRel = isAlpha ? 'src/alpha.ts' : 'src/beta.ts';
          fs.mkdirSync(path.join(runOpts.cwd, 'src'), { recursive: true });
          fs.writeFileSync(
            path.join(runOpts.cwd, fileRel),
            isAlpha ? 'export const alpha = () => "alpha";\n' : 'export const beta = () => "beta";\n',
          );
          const absRes = path.join(runOpts.cwd, relResult);
          fs.mkdirSync(path.dirname(absRes), { recursive: true });
          fs.writeFileSync(
            absRes,
            JSON.stringify({
              task_id: extId,
              status: 'completed',
              changed_files: [fileRel],
              summary: `Implemented ${fileRel}`,
              notes: [],
              blockers: [],
            }),
          );
          const line = joined.includes('codex')
            ? JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `Done ${extId}` } })
            : JSON.stringify({ type: 'result', session_id: `sub-${extId}`, result: `Done ${extId}` });
          runOpts.onStdoutLine?.(line);
          return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
        },
      );

      try {
        const parentTask = plan.tasks[0];
        await execSvc.startExecution(project.id, { taskId: parentTask.id, allowUnconfined: true });
        await execSvc.waitForProjectExecution(project.id);

        // Depth 1: neither subtask received MCP configuration
        expect(subtaskMcpSeen).toEqual([false, false]);

        // Token expired immediately after parent run finished
        expect(capturedToken.length).toBeGreaterThan(20);
        const afterEnd = await execSvc.handleMcpHttpRequest({
          method: 'POST',
          authorizationHeader: `Bearer ${capturedToken}`,
          body: { jsonrpc: '2.0', id: 99, method: 'ping' },
        });
        expect(afterEnd.statusCode).toBe(401);

        // Token NEVER entered any run.log event or persisted log file!
        const logEvents = capturedEvents
          .filter((e): e is Extract<DalangEvent, { type: 'run.log' }> => e.type === 'run.log')
          .map((e) => e.line)
          .join('\n');
        expect(logEvents).not.toContain(capturedToken);

        const execState = await execSvc.getExecutionState(project.id);
        for (const r of execState.runs) {
          const log = await execSvc.getRunLog(project.id, r.id);
          expect(log.content).not.toContain(capturedToken);
        }

        // Subtasks are real DALANG tasks on two providers, both passed review & merged into parent branch
        const updatedPlan = leadSvc.getPlan(project.id)!;
        const subtasks = updatedPlan.tasks.filter((t) => t.delegationDepth === 1);
        expect(subtasks).toHaveLength(2);
        expect(subtasks.every((s) => s.status === 'done' && s.mergeCommitSha && s.mergeTargetBranch === 'dalang/T-001')).toBe(true);

        const subtaskCoderRuns = execState.runs.filter((r) => r.kind === 'execute' && r.delegationDepth === 1);
        expect(new Set(subtaskCoderRuns.map((r) => r.provider))).toEqual(new Set(['codex', 'claude-code']));

        // Parent's own review saw the combined diff of alpha.ts, beta.ts, AND index.ts!
        expect(parentReviewPrompt).toContain('src/alpha.ts');
        expect(parentReviewPrompt).toContain('src/beta.ts');
        expect(parentReviewPrompt).toContain('src/index.ts');

        // Subtasks did NOT merge into main yet!
        expect(fs.existsSync(path.join(projDir, 'src/alpha.ts'))).toBe(false);
        expect(fs.existsSync(path.join(projDir, 'src/beta.ts'))).toBe(false);

        // Guard lists only parent T-001 (not subtasks), and direct merge of a subtask is refused
        const guard = await execSvc.getGuardState(project.id);
        expect(guard.tasks.map((g) => g.task.externalId)).toEqual(['T-001']);
        await expect(execSvc.approveMergeTask(project.id, subtasks[0].id)).rejects.toThrow(/parent branch/i);

        // Gate 2 merge of parent T-001 brings everything cleanly onto main!
        const merged = await execSvc.approveMergeTask(project.id, parentTask.id, {
          runIntegration: false,
        });
        expect(merged.task.status).toBe('done');
        expect(fs.existsSync(path.join(projDir, 'src/alpha.ts'))).toBe(true);
        expect(fs.existsSync(path.join(projDir, 'src/beta.ts'))).toBe(true);
        expect(fs.existsSync(path.join(projDir, 'src/index.ts'))).toBe(true);
      } finally {
        conn.close();
      }
    });

    it('enforces files_allowed subset, subtask cap, depth-1 limit, and task_cancel', async () => {
      const observations: Record<string, unknown> = {};
      let releaseSlowSubtask!: () => void;
      const slowStarted = new Promise<void>((r) => {
        releaseSlowSubtask = r;
      });

      const { conn, project, plan, execSvc } = await setupDelegationHarness(
        async (execRef, cmd, args, runOpts) => {
          const joined = `${cmd} ${args.join(' ')}`;
          if (shellCommand(cmd, args) !== null) {
            return { exitCode: 0, stdout: 'ok\n', stderr: '', timedOut: false, idleTimedOut: false };
          }
          if (/code review round/i.test(joined)) {
            const reviewReply = handleVerifyAndReviewCalls(cmd, args, runOpts, 'pass');
            if (reviewReply) return reviewReply;
          }
          const taskMatch = joined.match(/You are executing task ([A-Za-z0-9_-]+):/);
          if (!taskMatch) return null;
          const extId = taskMatch[1];
          const resPathMatch = joined.match(/"(\.dalang\/[^\"]+result\.json)"/);
          const relResult = resPathMatch?.[1] ?? `.dalang/tasks/${extId}/result.json`;

          if (extId === 'T-001') {
            const mcpIdx = args.indexOf('--mcp-config');
            const mcpJson = JSON.parse(fs.readFileSync(args[mcpIdx + 1], 'utf8')) as {
              mcpServers: { dalang: { headers: { Authorization: string } } };
            };
            const authHeader = mcpJson.mcpServers.dalang.headers.Authorization;

            // 1. Out-of-scope files_allowed rejected
            const badScope = await execRef.current!.handleMcpHttpRequest({
              method: 'POST',
              authorizationHeader: authHeader,
              body: {
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                  name: 'delegate_task',
                  arguments: {
                    prompt: 'Touch outside file',
                    files_allowed: ['outside/evil.ts'],
                  },
                },
              },
            });
            observations.badScope = (badScope.body as { result: { isError: boolean; content: Array<{ text: string }> } }).result;

            // 2. First subtask succeeds (wait)
            const ok1 = await execRef.current!.handleMcpHttpRequest({
              method: 'POST',
              authorizationHeader: authHeader,
              body: {
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/call',
                params: {
                  name: 'delegate_task',
                  arguments: {
                    title: 'Sub 1',
                    prompt: 'Write src/sub1.ts',
                    provider: 'codex',
                    files_allowed: ['src/sub1.ts'],
                    mode: 'wait',
                  },
                },
              },
            });
            observations.ok1 = (ok1.body as { result: { isError: boolean } }).result;

            // 3. Second subtask in async mode -> cancel it via task_cancel
            const ok2 = await execRef.current!.handleMcpHttpRequest({
              method: 'POST',
              authorizationHeader: authHeader,
              body: {
                jsonrpc: '2.0',
                id: 3,
                method: 'tools/call',
                params: {
                  name: 'delegate_task',
                  arguments: {
                    title: 'Slow sub 2',
                    prompt: 'SLOW_SUBTASK write src/sub2.ts',
                    provider: 'codex',
                    files_allowed: ['src/sub2.ts'],
                    mode: 'async',
                  },
                },
              },
            });
            const sub2Info = JSON.parse(
              (ok2.body as { result: { content: Array<{ text: string }> } }).result.content[0].text,
            ) as { external_id: string };

            await slowStarted;
            const cancelRes = await execRef.current!.handleMcpHttpRequest({
              method: 'POST',
              authorizationHeader: authHeader,
              body: {
                jsonrpc: '2.0',
                id: 4,
                method: 'tools/call',
                params: {
                  name: 'task_cancel',
                  arguments: { task_id: sub2Info.external_id },
                },
              },
            });
            observations.cancelled = JSON.parse(
              (cancelRes.body as { result: { content: Array<{ text: string }> } }).result.content[0].text,
            );

            // 4. Third subtask hits cap (maxSubtasksPerTask = 2)
            const capHit = await execRef.current!.handleMcpHttpRequest({
              method: 'POST',
              authorizationHeader: authHeader,
              body: {
                jsonrpc: '2.0',
                id: 5,
                method: 'tools/call',
                params: {
                  name: 'delegate_task',
                  arguments: {
                    prompt: 'Third subtask exceeds cap',
                    files_allowed: ['src/sub3.ts'],
                  },
                },
              },
            });
            observations.capHit = (capHit.body as { result: { isError: boolean; content: Array<{ text: string }> } }).result;

            // 5. Depth-1 enforcement check via a synthetic depth-1 token
            const depth1Scope = execRef.current!.getDelegationStore().issue({
              runId: 'fake-sub-run',
              projectId: project.id,
              sessionId: plan.sessionId,
              taskId: 'fake-sub-task',
              externalId: 'T-001-S1',
              branchName: 'dalang/T-001-S1',
              worktreePath: runOpts.cwd,
              baseMainSha: 'abc',
              delegationDepth: 1,
              filesAllowed: ['src/**'],
              verify: 'echo ok',
              parentAccountKey: 'codex',
              sandboxReady: false,
            });
            const depthRes = await execRef.current!.handleMcpHttpRequest({
              method: 'POST',
              authorizationHeader: `Bearer ${depth1Scope.token}`,
              body: {
                jsonrpc: '2.0',
                id: 6,
                method: 'tools/call',
                params: { name: 'delegate_task', arguments: { prompt: 'nested' } },
              },
            });
            execRef.current!.getDelegationStore().revoke(depth1Scope.token);
            observations.depthHit = (depthRes.body as { result: { isError: boolean; content: Array<{ text: string }> } }).result;

            const absRes = path.join(runOpts.cwd, relResult);
            fs.mkdirSync(path.dirname(absRes), { recursive: true });
            fs.writeFileSync(
              absRes,
              JSON.stringify({
                task_id: extId,
                status: 'completed',
                changed_files: ['src/sub1.ts'],
                summary: 'Checked limits',
                notes: [],
                blockers: [],
              }),
            );
            const line = JSON.stringify({ type: 'result', session_id: 'p1', result: 'ok' });
            runOpts.onStdoutLine?.(line);
            return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
          }

          if (joined.includes('SLOW_SUBTASK')) {
            releaseSlowSubtask();
            await new Promise<void>((resolve) => {
              if (runOpts.signal?.aborted) return resolve();
              runOpts.signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            return { exitCode: null, stdout: '', stderr: '', timedOut: false, idleTimedOut: false, aborted: true };
          }

          fs.mkdirSync(path.join(runOpts.cwd, 'src'), { recursive: true });
          fs.writeFileSync(path.join(runOpts.cwd, 'src/sub1.ts'), 'export const s1 = 1;\n');
          const absRes = path.join(runOpts.cwd, relResult);
          fs.mkdirSync(path.dirname(absRes), { recursive: true });
          fs.writeFileSync(
            absRes,
            JSON.stringify({
              task_id: extId,
              status: 'completed',
              changed_files: ['src/sub1.ts'],
              summary: 'Sub 1 done',
              notes: [],
              blockers: [],
            }),
          );
          const line = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } });
          runOpts.onStdoutLine?.(line);
          return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
        },
        { maxSubtasksPerTask: 2, taskFilesAllowed: ['src/**'] },
      );

      try {
        await execSvc.startExecution(project.id, { taskId: plan.tasks[0].id, allowUnconfined: true });
        await execSvc.waitForProjectExecution(project.id);

        const badScope = observations.badScope as { isError: boolean; content: Array<{ text: string }> };
        expect(badScope.isError).toBe(true);
        expect(badScope.content[0].text).toMatch(/subset/i);

        expect((observations.ok1 as { isError: boolean }).isError).toBe(false);
        expect((observations.cancelled as { status: string }).status).toBe('stopped');

        const capHit = observations.capHit as { isError: boolean; content: Array<{ text: string }> };
        expect(capHit.isError).toBe(true);
        expect(capHit.content[0].text).toMatch(/cap/i);

        const depthHit = observations.depthHit as { isError: boolean; content: Array<{ text: string }> };
        expect(depthHit.isError).toBe(true);
        expect(depthHit.content[0].text).toMatch(/depth/i);
      } finally {
        conn.close();
      }
    });

    it('stopping the parent task immediately stops its running subtasks', async () => {
      let notifyChildRunning!: () => void;
      const childRunning = new Promise<void>((r) => {
        notifyChildRunning = r;
      });
      let childAborted = false;

      const { conn, project, plan, leadSvc, execSvc } = await setupDelegationHarness(
        async (execRef, cmd, args, runOpts) => {
          const joined = `${cmd} ${args.join(' ')}`;
          const taskMatch = joined.match(/You are executing task ([A-Za-z0-9_-]+):/);
          if (!taskMatch) return null;
          const extId = taskMatch[1];

          if (extId === 'T-001') {
            const mcpIdx = args.indexOf('--mcp-config');
            const mcpJson = JSON.parse(fs.readFileSync(args[mcpIdx + 1], 'utf8')) as {
              mcpServers: { dalang: { headers: { Authorization: string } } };
            };
            const authHeader = mcpJson.mcpServers.dalang.headers.Authorization;

            await execRef.current!.handleMcpHttpRequest({
              method: 'POST',
              authorizationHeader: authHeader,
              body: {
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                  name: 'delegate_task',
                  arguments: {
                    title: 'Long child',
                    prompt: 'LONG_CHILD_TASK',
                    provider: 'codex',
                    files_allowed: ['src/long.ts'],
                    mode: 'async',
                  },
                },
              },
            });

            // Parent stays running until aborted by stopExecution
            await new Promise<void>((resolve) => {
              if (runOpts.signal?.aborted) return resolve();
              runOpts.signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            return { exitCode: null, stdout: '', stderr: '', timedOut: false, idleTimedOut: false, aborted: true };
          }

          notifyChildRunning();
          await new Promise<void>((resolve) => {
            if (runOpts.signal?.aborted) {
              childAborted = true;
              return resolve();
            }
            runOpts.signal?.addEventListener(
              'abort',
              () => {
                childAborted = true;
                resolve();
              },
              { once: true },
            );
          });
          return { exitCode: null, stdout: '', stderr: '', timedOut: false, idleTimedOut: false, aborted: true };
        },
      );

      try {
        await execSvc.startExecution(project.id, { taskId: plan.tasks[0].id, allowUnconfined: true });
        await childRunning;

        const stopRes = await execSvc.stopExecution(project.id, plan.tasks[0].id);
        expect(stopRes.stopped).toBe(true);
        expect(childAborted).toBe(true);

        const updatedPlan = leadSvc.getPlan(project.id)!;
        const subtask = updatedPlan.tasks.find((t) => t.delegationDepth === 1)!;
        expect(subtask.status).toBe('stopped');
      } finally {
        conn.close();
      }
    });

    it('deduplicates delegate_task retries and concurrent calls by client_request_id while enforcing auth, scope, and unique index recovery on v17 DB', async () => {
      let subtaskExecutions = 0;
      let capturedToken = '';
      const observations: Record<string, unknown> = {};

      const { conn, capturedEvents, project, plan, leadSvc, execSvc } = await setupDelegationHarness(
        async (execRef, cmd, args, runOpts) => {
          const joined = `${cmd} ${args.join(' ')}`;
          if (shellCommand(cmd, args) !== null) {
            return { exitCode: 0, stdout: 'ok\n', stderr: '', timedOut: false, idleTimedOut: false };
          }
          if (/code review round/i.test(joined)) {
            const reviewReply = handleVerifyAndReviewCalls(cmd, args, runOpts, 'pass');
            if (reviewReply) return reviewReply;
          }
          const taskMatch = joined.match(/You are executing task ([A-Za-z0-9_-]+):/);
          if (!taskMatch) return null;
          const extId = taskMatch[1];
          const resPathMatch = joined.match(/"(\.dalang\/[^\"]+result\.json)"/);
          const relResult = resPathMatch?.[1] ?? `.dalang/tasks/${extId}/result.json`;

          if (extId === 'T-001') {
            const mcpIdx = args.indexOf('--mcp-config');
            const mcpJson = JSON.parse(fs.readFileSync(args[mcpIdx + 1], 'utf8')) as {
              mcpServers: { dalang: { headers: { Authorization: string } } };
            };
            const authHeader = mcpJson.mcpServers.dalang.headers.Authorization;
            capturedToken = authHeader.replace(/^Bearer\s+/i, '');

            // 1. Blank client_request_id is rejected by schema validation.
            const blankIdRes = await execRef.current!.handleMcpHttpRequest({
              method: 'POST',
              authorizationHeader: authHeader,
              body: {
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                  name: 'delegate_task',
                  arguments: {
                    prompt: 'Blank id should fail',
                    files_allowed: ['src/blank.ts'],
                    client_request_id: '   ',
                  },
                },
              },
            });
            observations.blankId = (blankIdRes.body as { result: { isError: boolean; content: Array<{ text: string }> } }).result;

            // 2. Two concurrent wait-mode calls with the same client_request_id return the same subtask.
            const makeDelegateCall = (rpcId: number, requestId: string, files: string[], mode: 'wait' | 'async' = 'wait') =>
              execRef.current!.handleMcpHttpRequest({
                method: 'POST',
                authorizationHeader: authHeader,
                body: {
                  jsonrpc: '2.0',
                  id: rpcId,
                  method: 'tools/call',
                  params: {
                    name: 'delegate_task',
                    arguments: {
                      title: 'Concurrent alpha',
                      prompt: 'Write src/alpha.ts',
                      provider: 'codex',
                      files_allowed: files,
                      mode,
                      client_request_id: requestId,
                    },
                  },
                },
              });

            const [concA, concB] = await Promise.all([
              makeDelegateCall(2, 'req-alpha', ['src/alpha.ts'], 'wait'),
              makeDelegateCall(3, '  req-alpha  ', ['src/alpha.ts'], 'wait'),
            ]);
            const subA = JSON.parse(
              (concA.body as { result: { content: Array<{ text: string }> } }).result.content[0].text,
            ) as { task_id: string; external_id: string; client_request_id: string | null; status: string; merged_into_parent: boolean };
            const subB = JSON.parse(
              (concB.body as { result: { content: Array<{ text: string }> } }).result.content[0].text,
            ) as { task_id: string; external_id: string; client_request_id: string | null; status: string; merged_into_parent: boolean };
            observations.concA = subA;
            observations.concB = subB;

            // 3. Scope validation still rejects out-of-scope files_allowed even when retrying an existing client_request_id.
            const badScopeRetry = await makeDelegateCall(4, 'req-alpha', ['outside/evil.ts'], 'wait');
            observations.badScopeRetry = (
              badScopeRetry.body as { result: { isError: boolean; content: Array<{ text: string }> } }
            ).result;

            // 4. Depth-1 token is still rejected even when passing a client_request_id.
            const depth1Scope = execRef.current!.getDelegationStore().issue({
              runId: 'fake-sub-run',
              projectId: project.id,
              sessionId: plan.sessionId,
              taskId: 'fake-sub-task',
              externalId: 'T-001-S1',
              branchName: 'dalang/T-001-S1',
              worktreePath: runOpts.cwd,
              baseMainSha: 'abc',
              delegationDepth: 1,
              filesAllowed: ['src/**'],
              verify: 'echo ok',
              parentAccountKey: 'codex',
              sandboxReady: false,
            });
            const depthRetry = await execRef.current!.handleMcpHttpRequest({
              method: 'POST',
              authorizationHeader: `Bearer ${depth1Scope.token}`,
              body: {
                jsonrpc: '2.0',
                id: 5,
                method: 'tools/call',
                params: {
                  name: 'delegate_task',
                  arguments: {
                    prompt: 'Nested with id',
                    files_allowed: ['src/alpha.ts'],
                    client_request_id: 'req-alpha',
                  },
                },
              },
            });
            execRef.current!.getDelegationStore().revoke(depth1Scope.token);
            observations.depthRetry = (
              depthRetry.body as { result: { isError: boolean; content: Array<{ text: string }> } }
            ).result;

            // 5. Simulate a true DB unique-index collision race (pre-check misses, SQLite v17 unique index catches).
            const svcInternal = execRef.current as unknown as {
              findExistingSubtaskByClientRequestId: (parentId: string, reqId: string) => { id: string } | undefined;
            };
            const origLookup = svcInternal.findExistingSubtaskByClientRequestId.bind(execRef.current);
            let skippedOnce = false;
            svcInternal.findExistingSubtaskByClientRequestId = (parentId: string, reqId: string) => {
              if (!skippedOnce && reqId === 'req-alpha') {
                skippedOnce = true;
                return undefined;
              }
              return origLookup(parentId, reqId);
            };
            try {
              const raceRes = await makeDelegateCall(6, 'req-alpha', ['src/alpha.ts'], 'wait');
              observations.raceRecovery = JSON.parse(
                (raceRes.body as { result: { content: Array<{ text: string }> } }).result.content[0].text,
              );
            } finally {
              svcInternal.findExistingSubtaskByClientRequestId = origLookup;
            }

            // 6. Concurrent JSON-RPC batch in async mode creates one subtask (hitting maxSubtasksPerTask = 2).
            const batchRes = await execRef.current!.handleMcpHttpRequest({
              method: 'POST',
              authorizationHeader: authHeader,
              body: [
                {
                  jsonrpc: '2.0',
                  id: 7,
                  method: 'tools/call',
                  params: {
                    name: 'delegate_task',
                    arguments: {
                      title: 'Batch beta',
                      prompt: 'Write src/beta.ts',
                      provider: 'codex',
                      files_allowed: ['src/beta.ts'],
                      mode: 'async',
                      client_request_id: 'req-beta',
                    },
                  },
                },
                {
                  jsonrpc: '2.0',
                  id: 8,
                  method: 'tools/call',
                  params: {
                    name: 'delegate_task',
                    arguments: {
                      title: 'Batch beta retry',
                      prompt: 'Write src/beta.ts',
                      provider: 'codex',
                      files_allowed: ['src/beta.ts'],
                      mode: 'async',
                      client_request_id: 'req-beta',
                    },
                  },
                },
              ],
            });
            const batchBodies = batchRes.body as Array<{ result: { content: Array<{ text: string }> } }>;
            observations.batchA = JSON.parse(batchBodies[0].result.content[0].text);
            observations.batchB = JSON.parse(batchBodies[1].result.content[0].text);

            // 7. Even at subtask cap (2/2), retrying an existing client_request_id still succeeds,
            //    while a new client_request_id is rejected by the cap.
            const retryAtCap = await makeDelegateCall(9, 'req-alpha', ['src/alpha.ts'], 'wait');
            observations.retryAtCap = JSON.parse(
              (retryAtCap.body as { result: { content: Array<{ text: string }> } }).result.content[0].text,
            );
            const newAtCap = await makeDelegateCall(10, 'req-gamma', ['src/gamma.ts'], 'wait');
            observations.newAtCap = (
              newAtCap.body as { result: { isError: boolean; content: Array<{ text: string }> } }
            ).result;

            const absRes = path.join(runOpts.cwd, relResult);
            fs.mkdirSync(path.dirname(absRes), { recursive: true });
            fs.writeFileSync(
              absRes,
              JSON.stringify({
                task_id: extId,
                status: 'completed',
                changed_files: ['src/alpha.ts', 'src/beta.ts'],
                summary: 'Deduplication checks completed',
                notes: [],
                blockers: [],
              }),
            );
            const line = JSON.stringify({ type: 'result', session_id: 'p-dedupe', result: 'ok' });
            runOpts.onStdoutLine?.(line);
            return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
          }

          subtaskExecutions += 1;
          // Small delay so concurrent wait callers overlap while the subtask is actively running.
          await new Promise((r) => setTimeout(r, 40));
          const isBeta = joined.includes('src/beta.ts');
          const fileRel = isBeta ? 'src/beta.ts' : 'src/alpha.ts';
          fs.mkdirSync(path.join(runOpts.cwd, 'src'), { recursive: true });
          fs.writeFileSync(path.join(runOpts.cwd, fileRel), `export const val = "${fileRel}";\n`);
          const absRes = path.join(runOpts.cwd, relResult);
          fs.mkdirSync(path.dirname(absRes), { recursive: true });
          fs.writeFileSync(
            absRes,
            JSON.stringify({
              task_id: extId,
              status: 'completed',
              changed_files: [fileRel],
              summary: `Done ${fileRel}`,
              notes: [],
              blockers: [],
            }),
          );
          const line = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } });
          runOpts.onStdoutLine?.(line);
          return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
        },
        { maxSubtasksPerTask: 2, taskFilesAllowed: ['src/**'] },
      );

      try {
        // Confirm the temporary database uses schema v17 with the partial unique index.
        expect(Number(conn.sqlite.pragma('user_version', { simple: true }))).toBe(17);
        const indexRow = conn.sqlite
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_tasks_parent_client_request'`)
          .get() as { name: string } | undefined;
        expect(indexRow?.name).toBe('idx_tasks_parent_client_request');

        await execSvc.startExecution(project.id, { taskId: plan.tasks[0].id, allowUnconfined: true });
        await execSvc.waitForProjectExecution(project.id);

        // Revoked token after parent finishes is still rejected even with an existing client_request_id.
        const revokedRetry = await execSvc.handleMcpHttpRequest({
          method: 'POST',
          authorizationHeader: `Bearer ${capturedToken}`,
          body: {
            jsonrpc: '2.0',
            id: 99,
            method: 'tools/call',
            params: {
              name: 'delegate_task',
              arguments: { prompt: 'After stop', client_request_id: 'req-alpha' },
            },
          },
        });
        expect(revokedRetry.statusCode).toBe(401);

        // Non-running parent with a fresh token is still rejected even for an existing client_request_id.
        const staleScope = execSvc.getDelegationStore().issue({
          runId: 'stale-run',
          projectId: project.id,
          sessionId: plan.sessionId,
          taskId: plan.tasks[0].id,
          externalId: plan.tasks[0].externalId,
          branchName: 'dalang/T-001',
          worktreePath: '/tmp/unused',
          baseMainSha: 'abc',
          delegationDepth: 0,
          filesAllowed: ['src/**'],
          verify: 'echo ok',
          parentAccountKey: 'claude-code',
          sandboxReady: false,
        });
        const stoppedParentRes = await execSvc.handleMcpHttpRequest({
          method: 'POST',
          authorizationHeader: `Bearer ${staleScope.token}`,
          body: {
            jsonrpc: '2.0',
            id: 100,
            method: 'tools/call',
            params: {
              name: 'delegate_task',
              arguments: { prompt: 'Parent finished', client_request_id: 'req-alpha' },
            },
          },
        });
        execSvc.getDelegationStore().revoke(staleScope.token);
        const stoppedBody = (stoppedParentRes.body as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
        expect(stoppedBody.isError).toBe(true);
        expect(stoppedBody.content[0].text).toMatch(/no longer running/i);

        expect((observations.blankId as { isError: boolean }).isError).toBe(true);

        const concA = observations.concA as { task_id: string; external_id: string; client_request_id: string | null; status: string; merged_into_parent: boolean };
        const concB = observations.concB as { task_id: string; external_id: string; client_request_id: string | null; status: string; merged_into_parent: boolean };
        expect(concA.task_id).toBe(concB.task_id);
        expect(concA.external_id).toBe(concB.external_id);
        expect(concA.client_request_id).toBe('req-alpha');
        expect(concA.status).toBe('done');
        expect(concB.status).toBe('done');
        expect(concA.merged_into_parent).toBe(true);
        expect(concB.merged_into_parent).toBe(true);

        const badScopeRetry = observations.badScopeRetry as { isError: boolean; content: Array<{ text: string }> };
        expect(badScopeRetry.isError).toBe(true);
        expect(badScopeRetry.content[0].text).toMatch(/subset/i);

        const depthRetry = observations.depthRetry as { isError: boolean; content: Array<{ text: string }> };
        expect(depthRetry.isError).toBe(true);
        expect(depthRetry.content[0].text).toMatch(/depth/i);

        const raceRecovery = observations.raceRecovery as { task_id: string; external_id: string; client_request_id: string | null };
        expect(raceRecovery.task_id).toBe(concA.task_id);
        expect(raceRecovery.external_id).toBe(concA.external_id);
        expect(raceRecovery.client_request_id).toBe('req-alpha');

        const batchA = observations.batchA as { task_id: string; external_id: string; client_request_id: string | null };
        const batchB = observations.batchB as { task_id: string; external_id: string; client_request_id: string | null };
        expect(batchA.task_id).toBe(batchB.task_id);
        expect(batchA.external_id).toBe(batchB.external_id);
        expect(batchA.client_request_id).toBe('req-beta');

        const retryAtCap = observations.retryAtCap as { task_id: string; external_id: string };
        expect(retryAtCap.task_id).toBe(concA.task_id);

        const newAtCap = observations.newAtCap as { isError: boolean; content: Array<{ text: string }> };
        expect(newAtCap.isError).toBe(true);
        expect(newAtCap.content[0].text).toMatch(/cap/i);

        // Only 2 subtasks created and executed (req-alpha and req-beta), not duplicates.
        expect(subtaskExecutions).toBe(2);
        const delegatedEvents = capturedEvents.filter((e) => e.type === 'task.delegated');
        expect(delegatedEvents).toHaveLength(2);

        const updatedPlan = leadSvc.getPlan(project.id)!;
        const subtasks = updatedPlan.tasks.filter((t) => t.delegationDepth === 1);
        expect(subtasks).toHaveLength(2);

        const storedRows = conn.sqlite
          .prepare(`SELECT id, parent_task_id, client_request_id FROM tasks WHERE parent_task_id = ? ORDER BY client_request_id`)
          .all(plan.tasks[0].id) as Array<{ id: string; parent_task_id: string; client_request_id: string | null }>;
        expect(storedRows).toEqual([
          { id: concA.task_id, parent_task_id: plan.tasks[0].id, client_request_id: 'req-alpha' },
          { id: batchA.task_id, parent_task_id: plan.tasks[0].id, client_request_id: 'req-beta' },
        ]);
      } finally {
        conn.close();
      }
    });

    it('isolates client_request_id per parent task and keeps legacy callers without client_request_id creating distinct subtasks', async () => {
      const delegatedByParent: Record<string, Array<{ task_id: string; external_id: string; client_request_id: string | null }>> = {};
      let crossParentStatusRes: { isError: boolean; content: Array<{ text: string }> } | null = null;
      let parent1SubtaskId = '';

      const execSvcRef: { current: ExecutionService | null } = { current: null };
      const runner: CliRunner = {
        async which(bin) {
          if (bin === 'bwrap' || bin === 'sandbox-exec') return null;
          return `/usr/local/bin/${bin}`;
        },
        async run(cmd, args, runOpts) {
          const leadReply = handleLeadCalls(runOpts.cwd, args, runOpts);
          if (leadReply) return leadReply;
          const joined = `${cmd} ${args.join(' ')}`;
          if (shellCommand(cmd, args) !== null) {
            return { exitCode: 0, stdout: 'ok\n', stderr: '', timedOut: false, idleTimedOut: false };
          }
          if (/code review round/i.test(joined)) {
            const reviewReply = handleVerifyAndReviewCalls(cmd, args, runOpts, 'pass');
            if (reviewReply) return reviewReply;
          }
          const taskMatch = joined.match(/You are executing task ([A-Za-z0-9_-]+):/);
          if (!taskMatch) return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
          const extId = taskMatch[1];
          const resPathMatch = joined.match(/"(\.dalang\/[^\"]+result\.json)"/);
          const relResult = resPathMatch?.[1] ?? `.dalang/tasks/${extId}/result.json`;

          if (extId === 'T-001' || extId === 'T-002') {
            const mcpIdx = args.indexOf('--mcp-config');
            const mcpJson = JSON.parse(fs.readFileSync(args[mcpIdx + 1], 'utf8')) as {
              mcpServers: { dalang: { headers: { Authorization: string } } };
            };
            const authHeader = mcpJson.mcpServers.dalang.headers.Authorization;
            const prefix = extId === 'T-001' ? 'src/p1' : 'src/p2';
            delegatedByParent[extId] = [];

            // Both parents send the SAME client_request_id -> each gets its own subtask.
            const sharedRes = await execSvcRef.current!.handleMcpHttpRequest({
              method: 'POST',
              authorizationHeader: authHeader,
              body: {
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                  name: 'delegate_task',
                  arguments: {
                    title: `${extId} shared id sub`,
                    prompt: `Write ${prefix}/shared.ts`,
                    provider: 'codex',
                    files_allowed: [`${prefix}/shared.ts`],
                    mode: 'wait',
                    client_request_id: 'shared-req-1',
                  },
                },
              },
            });
            const sharedSub = JSON.parse(
              (sharedRes.body as { result: { content: Array<{ text: string }> } }).result.content[0].text,
            ) as { task_id: string; external_id: string; client_request_id: string | null };
            delegatedByParent[extId].push(sharedSub);

            if (extId === 'T-001') {
              parent1SubtaskId = sharedSub.task_id;
              // Legacy caller omitting client_request_id twice with identical payload creates two distinct subtasks.
              for (const rpcId of [2, 3]) {
                const legacyRes = await execSvcRef.current!.handleMcpHttpRequest({
                  method: 'POST',
                  authorizationHeader: authHeader,
                  body: {
                    jsonrpc: '2.0',
                    id: rpcId,
                    method: 'tools/call',
                    params: {
                      name: 'delegate_task',
                      arguments: {
                        title: 'Legacy no-id sub',
                        prompt: `Write ${prefix}/legacy.ts`,
                        provider: 'codex',
                        files_allowed: [`${prefix}/legacy.ts`],
                        mode: 'wait',
                      },
                    },
                  },
                });
                const legacySub = JSON.parse(
                  (legacyRes.body as { result: { content: Array<{ text: string }> } }).result.content[0].text,
                ) as { task_id: string; external_id: string; client_request_id: string | null };
                delegatedByParent[extId].push(legacySub);
              }
            } else if (parent1SubtaskId) {
              // Parent 2 cannot query Parent 1's subtask.
              const crossRes = await execSvcRef.current!.handleMcpHttpRequest({
                method: 'POST',
                authorizationHeader: authHeader,
                body: {
                  jsonrpc: '2.0',
                  id: 4,
                  method: 'tools/call',
                  params: { name: 'task_status', arguments: { task_id: parent1SubtaskId } },
                },
              });
              crossParentStatusRes = (
                crossRes.body as { result: { isError: boolean; content: Array<{ text: string }> } }
              ).result;
            }

            const absRes = path.join(runOpts.cwd, relResult);
            fs.mkdirSync(path.dirname(absRes), { recursive: true });
            fs.writeFileSync(
              absRes,
              JSON.stringify({
                task_id: extId,
                status: 'completed',
                changed_files: [`${prefix}/shared.ts`],
                summary: `Finished ${extId}`,
                notes: [],
                blockers: [],
              }),
            );
            const line = JSON.stringify({ type: 'result', session_id: `sess-${extId}`, result: 'ok' });
            runOpts.onStdoutLine?.(line);
            return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
          }

          // Subtask execution
          const fileMatch = joined.match(/Write (src\/p[12]\/[a-z]+\.ts)/);
          const fileRel = fileMatch?.[1] ?? 'src/p1/shared.ts';
          fs.mkdirSync(path.join(runOpts.cwd, path.dirname(fileRel)), { recursive: true });
          fs.writeFileSync(path.join(runOpts.cwd, fileRel), `export const id = "${extId}";\n`);
          const absRes = path.join(runOpts.cwd, relResult);
          fs.mkdirSync(path.dirname(absRes), { recursive: true });
          fs.writeFileSync(
            absRes,
            JSON.stringify({
              task_id: extId,
              status: 'completed',
              changed_files: [fileRel],
              summary: `Subtask ${extId} done`,
              notes: [],
              blockers: [],
            }),
          );
          const line = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } });
          runOpts.onStdoutLine?.(line);
          return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
        },
      };

      const dbDir = makeTempDir('dalang-del-parents-db-');
      const projDir = path.join(makeTempDir('dalang-del-parents-proj-'), 'app');
      const conn = openDatabase(path.join(dbDir, 'dalang.db'));
      try {
        expect(Number(conn.sqlite.pragma('user_version', { simple: true }))).toBe(17);

        const settingsSvc = new SettingsService(conn.db);
        const registry = new ProviderRegistry(runner, {
          antigravityKeyringAccess: () => settingsSvc.antigravityKeyringAccess(),
        });
        new ProfileService(conn.db).updateProfile('profile-reviewer', { provider: 'codex', model: '' });

        const projectSvc = new ProjectService(conn.db);
        const leadSvc = new LeadService(conn.db, registry);
        const execSvc = new ExecutionService(conn.db, registry, leadSvc, undefined, {
          mcpEndpointUrl: 'http://127.0.0.1:4173/mcp',
        });
        execSvcRef.current = execSvc;

        const project = await projectSvc.createOrOpen({
          mode: 'create',
          name: 'Multi Parent Delegation',
          path: projDir,
          stackHint: 'TypeScript',
          initGitIfMissing: false,
          leadProvider: 'claude-code',
        });

        await leadSvc.finishDiscussAndWriteBrief(project.id);
        const briefs = leadSvc.listBriefs(project.id);
        leadSvc.approveBrief(project.id, briefs[0].version);
        const draftPlan = await leadSvc.generatePlan(project.id);
        for (const existing of draftPlan.tasks) {
          leadSvc.deleteTask(project.id, existing.id);
        }
        leadSvc.createTask(project.id, {
          title: 'Parent One',
          milestone: 'M1',
          role: 'engineer',
          complexity: 'high',
          dependsOn: [],
          goal: 'Run parent 1',
          filesAllowed: ['src/p1/**'],
          filesReference: ['PROJECT.md'],
          acceptanceCriteria: ['src/p1/shared.ts exists'],
          verify: 'echo ok',
          needsSplit: false,
          status: 'ready',
        });
        leadSvc.createTask(project.id, {
          title: 'Parent Two',
          milestone: 'M1',
          role: 'engineer',
          complexity: 'high',
          dependsOn: [],
          goal: 'Run parent 2',
          filesAllowed: ['src/p2/**'],
          filesReference: ['PROJECT.md'],
          acceptanceCriteria: ['src/p2/shared.ts exists'],
          verify: 'echo ok',
          needsSplit: false,
          status: 'ready',
        });
        const approvedPlan = leadSvc.approvePlan(project.id);
        const [parent1, parent2] = approvedPlan.tasks;

        await execSvc.startExecution(project.id, { taskId: parent1.id, allowUnconfined: true });
        await execSvc.waitForProjectExecution(project.id);
        await execSvc.startExecution(project.id, { taskId: parent2.id, allowUnconfined: true });
        await execSvc.waitForProjectExecution(project.id);

        // Different parents using the same client_request_id get distinct subtasks.
        const p1Shared = delegatedByParent['T-001'][0];
        const p2Shared = delegatedByParent['T-002'][0];
        expect(p1Shared.client_request_id).toBe('shared-req-1');
        expect(p2Shared.client_request_id).toBe('shared-req-1');
        expect(p1Shared.task_id).not.toBe(p2Shared.task_id);
        expect(p1Shared.external_id).toBe('T-001-S1');
        expect(p2Shared.external_id).toBe('T-002-S1');

        // Cross-parent authorization still blocks accessing Parent 1's subtask from Parent 2's token.
        expect(crossParentStatusRes).not.toBeNull();
        expect(crossParentStatusRes!.isError).toBe(true);
        expect(crossParentStatusRes!.content[0].text).toMatch(/not found/i);

        // Legacy callers without client_request_id create distinct subtasks with NULL client_request_id in DB.
        const legacy1 = delegatedByParent['T-001'][1];
        const legacy2 = delegatedByParent['T-001'][2];
        expect(legacy1.task_id).not.toBe(legacy2.task_id);
        expect(legacy1.client_request_id).toBeNull();
        expect(legacy2.client_request_id).toBeNull();

        const dbRows = conn.sqlite
          .prepare(
            `SELECT parent_task_id, external_id, client_request_id FROM tasks WHERE delegation_depth = 1 ORDER BY external_id`,
          )
          .all() as Array<{ parent_task_id: string; external_id: string; client_request_id: string | null }>;
        expect(dbRows).toEqual([
          { parent_task_id: parent1.id, external_id: 'T-001-S1', client_request_id: 'shared-req-1' },
          { parent_task_id: parent1.id, external_id: 'T-001-S2', client_request_id: null },
          { parent_task_id: parent1.id, external_id: 'T-001-S3', client_request_id: null },
          { parent_task_id: parent2.id, external_id: 'T-002-S1', client_request_id: 'shared-req-1' },
        ]);
      } finally {
        conn.close();
      }
    });
  });
});
