import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliRunner, RunCommandOptions, RunCommandResult } from '@dalang/core';
import { createDalangServer, startDalangServer } from '../app.js';

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

describe('Loopback MCP endpoint (/mcp) end-to-end', () => {
  it('enforces loopback + bearer auth and completes multi-provider agent delegation over real HTTP', async () => {
    const dbDir = makeTempDir('dalang-mcp-srv-db-');
    const projDir = path.join(makeTempDir('dalang-mcp-srv-proj-'), 'demo');
    let parentTokenSeen = '';
    let parentReviewDiff = '';

    const runner: CliRunner = {
      async which(bin) {
        if (bin === 'bwrap' || bin === 'sandbox-exec') return null;
        return `/usr/local/bin/${bin}`;
      },
      async run(cmd, args, opts: RunCommandOptions): Promise<RunCommandResult> {
        const base = path.basename(cmd).toLowerCase();
        if (args[0] === '--version') return { exitCode: 0, stdout: '1.0.0\n', stderr: '', timedOut: false, idleTimedOut: false };
        if (cmd.includes('claude') && args[0] === 'auth') {
          return { exitCode: 0, stdout: JSON.stringify({ loggedIn: true, email: 'dev@local' }), stderr: '', timedOut: false, idleTimedOut: false };
        }
        if (cmd.includes('codex') && args[0] === 'login') {
          return { exitCode: 0, stdout: 'Logged in\n', stderr: '', timedOut: false, idleTimedOut: false };
        }
        if (base === 'sh' || base === 'cmd.exe') {
          return { exitCode: 0, stdout: 'verify ok\n', stderr: '', timedOut: false, idleTimedOut: false };
        }

        const joined = `${cmd} ${args.join(' ')}`;
        const briefMatch = joined.match(/(\.dalang\/(?:sessions\/[A-Za-z0-9_-]+\/)?brief\.v(\d+)\.json)/);
        if (briefMatch) {
          const target = path.join(opts.cwd, briefMatch[1]);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(
            target,
            JSON.stringify({
              version: Number(briefMatch[2]),
              title: 'Demo',
              summary: 'Demo',
              scope: ['src'],
              features: ['Delegation'],
              stack: ['TypeScript'],
            }),
          );
          const line = JSON.stringify({ type: 'result', session_id: 'lead-1', result: 'ok' });
          opts.onStdoutLine?.(line);
          return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
        }

        const planMatch = joined.match(/(\.dalang\/(?:sessions\/[A-Za-z0-9_-]+\/)?tmp\/plan-v\d+\.json)/);
        if (planMatch) {
          const target = path.join(opts.cwd, planMatch[1]);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(
            target,
            JSON.stringify({
              version: 1,
              brief_version: 1,
              milestones: [{ id: 'M1', title: 'Core' }],
              tasks: [
                {
                  id: 'T-001',
                  title: 'Build dual-module feature',
                  milestone: 'M1',
                  role: 'engineer',
                  complexity: 'high',
                  depends_on: [],
                  goal: 'Delegate module A to Codex and module B to Claude, then wire index.ts',
                  files_allowed: ['src/**'],
                  files_reference: ['PROJECT.md'],
                  acceptance_criteria: ['src/a.ts, src/b.ts, and src/index.ts exist'],
                  verify: 'echo ok',
                  needs_split: false,
                },
              ],
            }),
          );
          const line = JSON.stringify({ type: 'result', session_id: 'lead-1', result: 'ok' });
          opts.onStdoutLine?.(line);
          return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
        }

        const reviewMatch = joined.match(/code review round \d+ of \d+ for task ([A-Za-z0-9_-]+)/i);
        if (reviewMatch) {
          const extId = reviewMatch[1];
          if (extId === 'T-001') {
            parentReviewDiff = args.find((a) => a.includes('Unified diff:')) ?? joined;
          }
          const payload = JSON.stringify({
            task_id: extId,
            status: 'pass',
            verify_exit_code: 0,
            summary: `Reviewed ${extId}`,
            findings: [],
          });
          const line = joined.includes('codex')
            ? JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: payload } })
            : JSON.stringify({ type: 'result', session_id: `rev-${extId}`, result: payload });
          opts.onStdoutLine?.(line);
          return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
        }

        const taskMatch = joined.match(/You are executing task ([A-Za-z0-9_-]+):/);
        if (taskMatch) {
          const extId = taskMatch[1];
          const resPathMatch = joined.match(/"(\.dalang\/[^\"]+result\.json)"/);
          const relResult = resPathMatch?.[1] ?? `.dalang/tasks/${extId}/result.json`;

          if (extId === 'T-001') {
            const mcpIdx = args.indexOf('--mcp-config');
            expect(mcpIdx).toBeGreaterThan(-1);
            const mcpCfg = JSON.parse(fs.readFileSync(args[mcpIdx + 1], 'utf8')) as {
              mcpServers: { dalang: { url: string; headers: { Authorization: string } } };
            };
            const mcpUrl = mcpCfg.mcpServers.dalang.url;
            const auth = mcpCfg.mcpServers.dalang.headers.Authorization;
            parentTokenSeen = auth.replace(/^Bearer\s+/i, '');

            // Call real HTTP /mcp initialize + delegate_task twice (codex + claude-code)
            const initHttp = await fetch(mcpUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: auth },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
            });
            expect(initHttp.status).toBe(200);

            const del1 = await fetch(mcpUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: auth },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/call',
                params: {
                  name: 'delegate_task',
                  arguments: {
                    title: 'Module A',
                    prompt: 'Write src/a.ts',
                    provider: 'codex',
                    files_allowed: ['src/a.ts'],
                    mode: 'wait',
                  },
                },
              }),
            });
            expect(del1.status).toBe(200);
            const d1Json = (await del1.json()) as { result: { isError: boolean } };
            expect(d1Json.result.isError).toBe(false);

            const del2 = await fetch(mcpUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: auth },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 3,
                method: 'tools/call',
                params: {
                  name: 'delegate_task',
                  arguments: {
                    title: 'Module B',
                    prompt: 'Write src/b.ts',
                    provider: 'claude-code',
                    files_allowed: ['src/b.ts'],
                    mode: 'wait',
                  },
                },
              }),
            });
            expect(del2.status).toBe(200);
            const d2Json = (await del2.json()) as { result: { isError: boolean } };
            expect(d2Json.result.isError).toBe(false);

            fs.mkdirSync(path.join(opts.cwd, 'src'), { recursive: true });
            fs.writeFileSync(path.join(opts.cwd, 'src/index.ts'), 'export * from "./a.js";\nexport * from "./b.js";\n');
            const absRes = path.join(opts.cwd, relResult);
            fs.mkdirSync(path.dirname(absRes), { recursive: true });
            fs.writeFileSync(
              absRes,
              JSON.stringify({
                task_id: extId,
                status: 'completed',
                changed_files: ['src/a.ts', 'src/b.ts', 'src/index.ts'],
                summary: 'Delegated and integrated',
              }),
            );
            const line = JSON.stringify({ type: 'result', session_id: 'p1', result: 'ok' });
            opts.onStdoutLine?.(line);
            return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
          }

          // Subtasks
          const fileRel = joined.includes('src/a.ts') ? 'src/a.ts' : 'src/b.ts';
          fs.mkdirSync(path.join(opts.cwd, 'src'), { recursive: true });
          fs.writeFileSync(path.join(opts.cwd, fileRel), `export const val = "${fileRel}";\n`);
          const absRes = path.join(opts.cwd, relResult);
          fs.mkdirSync(path.dirname(absRes), { recursive: true });
          fs.writeFileSync(
            absRes,
            JSON.stringify({
              task_id: extId,
              status: 'completed',
              changed_files: [fileRel],
              summary: `Wrote ${fileRel}`,
            }),
          );
          const line = joined.includes('codex')
            ? JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } })
            : JSON.stringify({ type: 'result', session_id: `s-${extId}`, result: 'ok' });
          opts.onStdoutLine?.(line);
          return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
        }

        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
      },
    };

    const server = await startDalangServer({
      port: 0,
      dbPath: path.join(dbDir, 'dalang.db'),
      runner,
    });

    try {
      // Unauthenticated request to /mcp is rejected with 401
      const unauth = await fetch(`${server.url}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      expect(unauth.status).toBe(401);

      // Switch reviewer to codex so review works without agy keyring
      await fetch(`${server.url}/api/profiles/profile-reviewer`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'codex', model: '' }),
      });

      const createProj = await fetch(`${server.url}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'create', name: 'MCP Demo', path: projDir, leadProvider: 'claude-code' }),
      });
      expect(createProj.status).toBe(201);
      const { project } = (await createProj.json()) as { project: { id: string } };

      await fetch(`${server.url}/api/projects/${project.id}/discuss/finish`, { method: 'POST' });
      await fetch(`${server.url}/api/projects/${project.id}/briefs/1/approve`, { method: 'POST' });
      await fetch(`${server.url}/api/projects/${project.id}/plan/generate`, { method: 'POST' });
      await fetch(`${server.url}/api/projects/${project.id}/plan/approve`, { method: 'POST' });

      const startRes = await fetch(`${server.url}/api/projects/${project.id}/execution/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowUnconfined: true }),
      });
      expect(startRes.status).toBe(202);

      // Poll until T-001 reaches awaiting_merge
      const deadline = Date.now() + 20_000;
      let parentStatus = '';
      while (Date.now() < deadline) {
        const planRes = await fetch(`${server.url}/api/projects/${project.id}/plan`);
        const { plan } = (await planRes.json()) as { plan: { tasks: Array<{ externalId: string; status: string }> } };
        parentStatus = plan.tasks.find((t) => t.externalId === 'T-001')?.status ?? '';
        if (parentStatus === 'awaiting_merge' || parentStatus === 'failed' || parentStatus === 'review_failed') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(parentStatus).toBe('awaiting_merge');
      expect(parentReviewDiff).toContain('src/a.ts');
      expect(parentReviewDiff).toContain('src/b.ts');
      expect(parentReviewDiff).toContain('src/index.ts');

      // Token is expired after run completion
      expect(parentTokenSeen.length).toBeGreaterThan(20);
      const stale = await fetch(`${server.url}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${parentTokenSeen}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      expect(stale.status).toBe(401);

      // Approve merge to main via API
      const mergeRes = await fetch(`${server.url}/api/projects/${project.id}/tasks/T-001/approve-merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runIntegration: false }),
      });
      expect(mergeRes.status).toBe(200);
      expect(fs.existsSync(path.join(projDir, 'src/a.ts'))).toBe(true);
      expect(fs.existsSync(path.join(projDir, 'src/b.ts'))).toBe(true);
      expect(fs.existsSync(path.join(projDir, 'src/index.ts'))).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('rejects non-loopback Host headers on /mcp and stays independent of browser login cookies', async () => {
    const dbDir = makeTempDir('dalang-mcp-guard-db-');
    const { app, close } = await createDalangServer({
      dbPath: path.join(dbDir, 'dalang.db'),
    });
    try {
      // Enable browser login password
      const enable = await app.inject({
        method: 'PUT',
        url: '/api/auth/settings',
        payload: { enabled: true, password: 'test-login-password' },
      });
      expect(enable.statusCode).toBe(200);

      // Non-loopback Host is rejected with 403
      const badHost = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { host: 'evil.example:4173', 'content-type': 'application/json' },
        payload: { jsonrpc: '2.0', id: 1, method: 'ping' },
      });
      expect(badHost.statusCode).toBe(403);

      // Loopback /mcp without Bearer token gets 401 from MCP auth (not browser cookie redirect)
      const noToken = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { host: '127.0.0.1:4173', 'content-type': 'application/json' },
        payload: { jsonrpc: '2.0', id: 1, method: 'ping' },
      });
      expect(noToken.statusCode).toBe(401);
      expect(noToken.json().error.message).toMatch(/bearer/i);
    } finally {
      await close();
    }
  });
});
