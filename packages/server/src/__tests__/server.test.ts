import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliRunner, RunCommandOptions, RunCommandResult } from '@dalang/core';
import { BriefContentSchema, PlanContractSchema } from '@dalang/shared';
import { createDalangServer } from '../app.js';

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

function createMultiProjectFakeRunner(projectSpecs: Record<string, { title: string; stack: string[]; taskTitle: string }>): CliRunner {
  return {
    async which(bin) {
      return `/usr/bin/${bin}`;
    },
    async run(cmd, args, opts: RunCommandOptions): Promise<RunCommandResult> {
      if (args[0] === '--version') {
        return { exitCode: 0, stdout: '1.0.0', stderr: '', timedOut: false, idleTimedOut: false };
      }
      if (cmd.includes('claude') && args[0] === 'auth') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ loggedIn: true, email: 'dev@example.com', planTier: 'pro' }),
          stderr: '',
          timedOut: false,
          idleTimedOut: false,
        };
      }
      if (cmd.includes('codex') && args[0] === 'login') {
        return { exitCode: 0, stdout: 'Logged in using ChatGPT', stderr: '', timedOut: false, idleTimedOut: false };
      }
      if (cmd.includes('agy') && args[0] === '-p=/usage') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            status: 'SUCCESS',
            command: {
              name: 'usage',
              data: {
                groups: [
                  {
                    name: 'Gemini Models',
                    buckets: [
                      {
                        id: 'g-5h',
                        name: 'Five Hour Limit Remaining',
                        window: '5h',
                        remaining_fraction: 0.85,
                        reset_time: '2026-11-18T15:00:00Z',
                      },
                    ],
                  },
                ],
              },
            },
          }),
          stderr: '',
          timedOut: false,
          idleTimedOut: false,
        };
      }
      if (cmd.includes('agy') && args[0] === 'models') {
        return {
          exitCode: 0,
          stdout: 'gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)\n',
          stderr: '',
          timedOut: false,
          idleTimedOut: false,
        };
      }

      const cwd = opts.cwd;
      const spec = projectSpecs[cwd] ?? {
        title: 'Sample Project',
        stack: ['TypeScript'],
        taskTitle: 'Build core feature',
      };
      const promptArg = args.find((a) => a.includes('.dalang/')) ?? args.join(' ');

      const emit = (sid: string, text: string) => {
        const line = JSON.stringify({ type: 'result', session_id: sid, result: text });
        opts.onStdoutLine?.(line);
        return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
      };

      const roundMatch = promptArg.match(/\.dalang\/discuss\/round-(\d+)\.json/);
      if (roundMatch) {
        const round = Number(roundMatch[1]);
        const target = path.join(cwd, '.dalang', 'discuss', `round-${round}.json`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(
          target,
          JSON.stringify({
            round,
            summary: `Clarifying ${spec.title}`,
            ready_for_brief: false,
            questions: [
              {
                id: 'q1',
                question: `Confirm deployment mode for ${spec.title}?`,
                reason: 'Sets packaging and local config',
                kind: 'single',
                options: ['Local CLI', 'Docker'],
                allow_custom: true,
              },
            ],
          }),
        );
        return emit(`sess-${path.basename(cwd)}`, 'Round done');
      }

      const briefMatch = promptArg.match(/\.dalang\/brief\.v(\d+)\.json/);
      if (briefMatch) {
        const ver = Number(briefMatch[1]);
        const target = path.join(cwd, '.dalang', `brief.v${ver}.json`);
        fs.writeFileSync(
          target,
          JSON.stringify({
            version: ver,
            title: spec.title,
            summary: `Brief for ${spec.title}`,
            scope: ['Core workflow', 'Tests'],
            features: [spec.taskTitle],
            stack: spec.stack,
            constraints: ['Local first'],
            out_of_scope: ['Cloud multi-tenant'],
            assumptions: ['Node 26 installed'],
          }),
        );
        return emit(`sess-${path.basename(cwd)}`, 'Brief done');
      }

      if (promptArg.includes('.dalang/tmp/plan-v')) {
        const target = path.join(cwd, '.dalang', 'tmp', 'plan-v1.json');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(
          target,
          JSON.stringify({
            version: 1,
            brief_version: 1,
            milestones: [{ id: 'M1', title: 'MVP' }],
            tasks: [
              {
                id: 'T-001',
                title: spec.taskTitle,
                milestone: 'M1',
                role: 'engineer',
                complexity: 'low',
                depends_on: [],
                goal: `Implement ${spec.taskTitle}`,
                files_allowed: ['src/**'],
                files_reference: ['PROJECT.md'],
                acceptance_criteria: ['Tests pass'],
                verify: 'pnpm test',
                needs_split: false,
              },
            ],
          }),
        );
        return emit(`sess-${path.basename(cwd)}`, 'Plan done');
      }

      const taskMatch = promptArg.match(/\.dalang\/tasks\/([A-Za-z0-9_-]+)\/result\.json/);
      if (taskMatch) {
        const extId = taskMatch[1];
        const target = path.join(cwd, '.dalang', 'tasks', extId, 'result.json');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
        fs.writeFileSync(path.join(cwd, 'src', 'index.ts'), 'export const ok = true;\n');
        fs.writeFileSync(
          target,
          JSON.stringify({
            task_id: extId,
            status: 'completed',
            changed_files: ['src/index.ts'],
            summary: `Completed ${extId}`,
            notes: [],
            blockers: [],
            verify_command: 'pnpm test',
            verify_exit_code: 0,
          }),
        );
        return emit(`sess-exec-${extId}`, `Task ${extId} done`);
      }

      return emit('sess-generic', 'ok');
    },
  };
}

describe('@dalang/server API (v0.1 Rembuk)', () => {
  it('checks provider statuses and runs Discuss -> Brief -> Plan across 3 sample projects', async () => {
    const dbDir = makeTempDir('dalang-srv-db-');
    const rootProjects = makeTempDir('dalang-srv-projs-');

    const projA = path.join(rootProjects, 'sample-1-attendance');
    const projB = path.join(rootProjects, 'sample-2-invoice');
    const projC = path.join(rootProjects, 'sample-3-bookmarks');

    const runner = createMultiProjectFakeRunner({
      [projA]: { title: 'Barcode Attendance', stack: ['Fastify', 'SQLite'], taskTitle: 'Scan endpoint' },
      [projB]: { title: 'SME Invoice CLI', stack: ['TypeScript', 'PDFKit'], taskTitle: 'PDF generator' },
      [projC]: { title: 'Local Bookmark Tagger', stack: ['React', 'SQLite'], taskTitle: 'Tag search' },
    });

    const { app, close } = await createDalangServer({
      dbPath: path.join(dbDir, 'dalang.db'),
      runner,
    });

    try {
      const health = await app.inject({ method: 'GET', url: '/api/health' });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ ok: true, version: '0.2.0' });

      const providersRes = await app.inject({ method: 'GET', url: '/api/providers/status' });
      expect(providersRes.statusCode).toBe(200);
      const { providers } = providersRes.json() as { providers: Array<{ id: string; loggedIn: boolean }> };
      expect(providers.map((p) => p.id)).toEqual(['claude-code', 'codex', 'antigravity']);
      expect(providers.every((p) => p.loggedIn)).toBe(true);

      const profilesRes = await app.inject({ method: 'GET', url: '/api/profiles' });
      expect(profilesRes.statusCode).toBe(200);
      expect(profilesRes.json().profiles.length).toBeGreaterThanOrEqual(4);

      const samples = [
        { path: projA, name: 'Sample 1', goal: 'Build barcode attendance app' },
        { path: projB, name: 'Sample 2', goal: 'Build SME invoice generator' },
        { path: projC, name: 'Sample 3', goal: 'Build local bookmark tagger' },
      ];

      for (const sample of samples) {
        const createRes = await app.inject({
          method: 'POST',
          url: '/api/projects',
          payload: { mode: 'create', name: sample.name, path: sample.path },
        });
        expect(createRes.statusCode).toBe(201);
        const projectId = createRes.json().project.id as string;

        const discussRes = await app.inject({
          method: 'POST',
          url: `/api/projects/${projectId}/discuss/message`,
          payload: { message: sample.goal },
        });
        expect(discussRes.statusCode).toBe(200);
        expect(discussRes.json().round.questions).toHaveLength(1);

        const briefRes = await app.inject({
          method: 'POST',
          url: `/api/projects/${projectId}/discuss/finish`,
        });
        expect(briefRes.statusCode).toBe(200);
        const briefVersion = briefRes.json().brief.version as number;
        expect(() => BriefContentSchema.parse(briefRes.json().brief.content)).not.toThrow();

        const approveBriefRes = await app.inject({
          method: 'POST',
          url: `/api/projects/${projectId}/briefs/${briefVersion}/approve`,
        });
        expect(approveBriefRes.statusCode).toBe(200);
        expect(approveBriefRes.json().brief.status).toBe('approved');

        const planRes = await app.inject({
          method: 'POST',
          url: `/api/projects/${projectId}/plan/generate`,
        });
        expect(planRes.statusCode).toBe(200);
        expect(planRes.json().plan.tasks).toHaveLength(1);

        const onDiskPlan = JSON.parse(
          fs.readFileSync(path.join(sample.path, '.dalang', 'plan.json'), 'utf8'),
        );
        expect(() => PlanContractSchema.parse(onDiskPlan)).not.toThrow();
      }
    } finally {
      await close();
    }
  });

  it('runs v0.2 Assign & Navigate execution, log replay, and checkpoint rollback via HTTP API', async () => {
    const dbDir = makeTempDir('dalang-srv-v2-db-');
    const projDir = path.join(makeTempDir('dalang-srv-v2-proj-'), 'app');
    const runner = createMultiProjectFakeRunner({
      [projDir]: { title: 'Notes App', stack: ['TypeScript'], taskTitle: 'Create notes store' },
    });

    const { app, close } = await createDalangServer({
      dbPath: path.join(dbDir, 'dalang.db'),
      runner,
    });

    try {
      const routingRes = await app.inject({ method: 'GET', url: '/api/routing' });
      expect(routingRes.statusCode).toBe(200);
      expect(routingRes.json().rules.length).toBeGreaterThanOrEqual(4);

      const createRes = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { mode: 'create', name: 'Notes App', path: projDir },
      });
      const projectId = createRes.json().project.id as string;

      await app.inject({ method: 'POST', url: `/api/projects/${projectId}/discuss/finish` });
      await app.inject({ method: 'POST', url: `/api/projects/${projectId}/briefs/1/approve` });
      const planRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/plan/generate`,
      });
      const taskId = planRes.json().plan.tasks[0].id as string;

      const approvePlanRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/plan/approve`,
      });
      expect(approvePlanRes.statusCode).toBe(200);

      // Override task profile in Assign
      const assignRes = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${projectId}/tasks/${taskId}/profile`,
        payload: { profileOverride: 'profile-coder-heavy' },
      });
      expect(assignRes.statusCode).toBe(200);
      expect(assignRes.json().task.profileOverride).toBe('profile-coder-heavy');

      // Start sequential execution
      const startRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/execution/start`,
        payload: { allowUnconfined: true },
      });
      expect(startRes.statusCode).toBe(202);
      const runId = startRes.json().run.id as string;

      // Poll until run finishes
      let execState: { activeRun: unknown; runs: Array<{ id: string; status: string }>; dispatchPreviews: Array<{ status: string }> } | null = null;
      for (let i = 0; i < 40; i++) {
        const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/execution` });
        execState = res.json().execution;
        if (!execState?.activeRun && execState?.runs[0]?.status === 'completed') break;
        await new Promise((r) => setTimeout(r, 25));
      }

      expect(execState?.runs[0].status).toBe('completed');
      expect(execState?.dispatchPreviews[0].status).toBe('done');
      expect(fs.existsSync(path.join(projDir, 'src', 'index.ts'))).toBe(true);

      const logRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/runs/${runId}/log`,
      });
      expect(logRes.statusCode).toBe(200);
      expect(logRes.json().content).toContain('T-001');

      const rollbackRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/runs/${runId}/rollback`,
      });
      expect(rollbackRes.statusCode).toBe(200);
      expect(rollbackRes.json().run.status).toBe('rolled_back');
      expect(fs.existsSync(path.join(projDir, 'src', 'index.ts'))).toBe(false);
    } finally {
      await close();
    }
  });

  it('refuses requests whose Host or Origin is not loopback (DNS rebinding guard)', async () => {
    const dbDir = makeTempDir('dalang-db-');
    const { app, close } = await createDalangServer({ dbPath: path.join(dbDir, 'dalang.db') });
    try {
      const ok = await app.inject({ method: 'GET', url: '/api/health', headers: { host: '127.0.0.1:4173' } });
      expect(ok.statusCode).toBe(200);

      const rebound = await app.inject({ method: 'GET', url: '/api/projects', headers: { host: 'evil.example:4173' } });
      expect(rebound.statusCode).toBe(403);

      const crossOrigin = await app.inject({
        method: 'GET',
        url: '/api/projects',
        headers: { host: '127.0.0.1:4173', origin: 'https://evil.example' },
      });
      expect(crossOrigin.statusCode).toBe(403);

      const devOrigin = await app.inject({
        method: 'GET',
        url: '/api/projects',
        headers: { host: '127.0.0.1:4173', origin: 'http://localhost:5173' },
      });
      expect(devOrigin.statusCode).toBe(200);
    } finally {
      await close();
    }
  });
});
