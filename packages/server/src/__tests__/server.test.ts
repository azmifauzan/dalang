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
      const joined = `${cmd} ${args.join(' ')}`;

      const emit = (sid: string, text: string) => {
        const line = JSON.stringify({ type: 'result', session_id: sid, result: text });
        opts.onStdoutLine?.(line);
        return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
      };

      if ((cmd === '/bin/sh' || args.includes('/bin/sh')) && args.includes('-c')) {
        const shellCmd = args[args.indexOf('-c') + 1] ?? '';
        if (shellCmd.includes('fail-verify')) {
          return { exitCode: 1, stdout: '', stderr: 'verify failed', timedOut: false, idleTimedOut: false };
        }
        opts.onStdoutLine?.('Tests passed');
        return { exitCode: 0, stdout: 'Tests passed\n', stderr: '', timedOut: false, idleTimedOut: false };
      }

      const reviewMatch = joined.match(/code review round (\d+) of \d+ for task ([A-Za-z0-9_-]+)/i);
      if (reviewMatch) {
        const roundNum = Number(reviewMatch[1]);
        const extId = reviewMatch[2];
        const passOnRound = roundNum >= 1;
        const payload = JSON.stringify({
          task_id: extId,
          status: passOnRound ? 'pass' : 'fail',
          verify_exit_code: 0,
          summary: `Review round ${roundNum} ok`,
          findings: [],
        });
        const isCodex = joined.includes('codex');
        const line = isCodex
          ? JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: payload } })
          : JSON.stringify({ type: 'result', session_id: `rev-${extId}`, result: payload });
        opts.onStdoutLine?.(line);
        return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
      }

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
      expect(health.json()).toEqual({ ok: true, version: '0.3.0' });

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

      // Poll until coding + review finishes (task enters awaiting_merge in Guard)
      let execState: { activeRun: unknown; runs: Array<{ id: string; kind: string; status: string }>; dispatchPreviews: Array<{ status: string }> } | null = null;
      for (let i = 0; i < 60; i++) {
        const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/execution` });
        execState = res.json().execution;
        if (!execState?.activeRun && execState?.dispatchPreviews[0]?.status === 'awaiting_merge') break;
        await new Promise((r) => setTimeout(r, 25));
      }

      expect(execState?.dispatchPreviews[0].status).toBe('awaiting_merge');
      const coderRunId = execState!.runs.find((r) => r.kind === 'execute')!.id;
      expect(fs.existsSync(path.join(projDir, 'src', 'index.ts'))).toBe(false);

      const guardRes = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/guard` });
      expect(guardRes.statusCode).toBe(200);
      expect(guardRes.json().guard.tasks).toHaveLength(1);
      expect(guardRes.json().guard.tasks[0].latestReview.status).toBe('pass');

      const diffRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/tasks/${taskId}/diff`,
      });
      expect(diffRes.statusCode).toBe(200);
      expect(diffRes.json().diff.files.some((f: { path: string }) => f.path === 'src/index.ts')).toBe(true);

      const mergeRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/tasks/${taskId}/approve-merge`,
        payload: { runIntegration: true },
      });
      expect(mergeRes.statusCode).toBe(200);
      expect(mergeRes.json().task.status).toBe('done');
      expect(fs.existsSync(path.join(projDir, 'src', 'index.ts'))).toBe(true);

      const logRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/runs/${runId}/log`,
      });
      expect(logRes.statusCode).toBe(200);
      expect(logRes.json().content).toContain('T-001');

      const rollbackRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/runs/${coderRunId}/rollback`,
      });
      expect(rollbackRes.statusCode).toBe(200);
      expect(rollbackRes.json().run.status).toBe('rolled_back');
      expect(fs.existsSync(path.join(projDir, 'src', 'index.ts'))).toBe(false);
    } finally {
      await close();
    }
  });

  it('supports v0.3 profiles/routing CRUD and runs 5 test projects end-to-end through Guard', async () => {
    const dbDir = makeTempDir('dalang-srv-v3-db-');
    const projectsRoot = makeTempDir('dalang-srv-v3-projs-');
    const fixTracker = new Set<string>();

    const baseRunner = createMultiProjectFakeRunner({});
    const runner: CliRunner = {
      which: baseRunner.which,
      async run(cmd, args, opts) {
        const joined = `${cmd} ${args.join(' ')}`;
        // Project 2 fails review round 1, passes after fix round 2.
        if (opts.cwd.endsWith('proj-2') && joined.includes('code review round 1')) {
          const payload = JSON.stringify({
            task_id: 'T-001',
            status: 'fail',
            verify_exit_code: 0,
            summary: 'Missing input validation',
            findings: [{ severity: 'major', file: 'src/index.ts', note: 'Validate non-empty input' }],
          });
          const isCodex = joined.includes('codex');
          const line = isCodex
            ? JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: payload } })
            : JSON.stringify({ type: 'result', session_id: 'rev-fail-1', result: payload });
          opts.onStdoutLine?.(line);
          return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
        }
        if (joined.includes('Review round 1 FAILED')) {
          fixTracker.add(opts.cwd);
        }
        return baseRunner.run(cmd, args, opts);
      },
    };

    const { app, close } = await createDalangServer({
      dbPath: path.join(dbDir, 'dalang.db'),
      runner,
    });

    try {
      // Profiles & Routing CRUD
      const createProf = await app.inject({
        method: 'POST',
        url: '/api/profiles',
        payload: {
          name: 'qa-claude',
          provider: 'claude-code',
          model: 'sonnet',
          effort: 'high',
          permissionMode: 'read-only',
          maxReviewRounds: 2,
        },
      });
      expect(createProf.statusCode).toBe(201);
      const profId = createProf.json().profile.id as string;

      const patchProf = await app.inject({
        method: 'PATCH',
        url: `/api/profiles/${profId}`,
        payload: { model: 'opus', maxReviewRounds: 3 },
      });
      expect(patchProf.statusCode).toBe(200);
      expect(patchProf.json().profile.maxReviewRounds).toBe(3);

      const createRule = await app.inject({
        method: 'POST',
        url: '/api/routing',
        payload: { role: 'reviewer', complexity: 'high', profileId: profId, fallbackProfileId: 'profile-lead' },
      });
      expect(createRule.statusCode).toBe(201);
      const ruleId = createRule.json().rule.id as string;

      const reorderRes = await app.inject({
        method: 'POST',
        url: '/api/routing/reorder',
        payload: { ruleIds: [ruleId] },
      });
      expect(reorderRes.statusCode).toBe(200);
      expect(reorderRes.json().rules[0].id).toBe(ruleId);

      // Run 5 projects through Discuss -> Agree -> List -> Assign -> Navigate -> Review -> Guard Merge
      let passedWithin2Rounds = 0;
      for (let idx = 1; idx <= 5; idx++) {
        const projPath = path.join(projectsRoot, `proj-${idx}`);
        const cRes = await app.inject({
          method: 'POST',
          url: '/api/projects',
          payload: { mode: 'create', name: `Sample ${idx}`, path: projPath },
        });
        const pid = cRes.json().project.id as string;

        await app.inject({ method: 'POST', url: `/api/projects/${pid}/discuss/finish` });
        await app.inject({ method: 'POST', url: `/api/projects/${pid}/briefs/1/approve` });
        const pRes = await app.inject({ method: 'POST', url: `/api/projects/${pid}/plan/generate` });
        const tid = pRes.json().plan.tasks[0].id as string;
        await app.inject({ method: 'POST', url: `/api/projects/${pid}/plan/approve` });

        // Add package.json test script on main so F-20 post-merge integration executes.
        await app.inject({
          method: 'PATCH',
          url: `/api/projects/${pid}/settings`,
          payload: { integrationCommand: 'node -e "process.exit(0)"' },
        });

        await app.inject({
          method: 'POST',
          url: `/api/projects/${pid}/execution/start`,
          payload: { allowUnconfined: true },
        });

        for (let step = 0; step < 80; step++) {
          const ex = await app.inject({ method: 'GET', url: `/api/projects/${pid}/execution` });
          if (!ex.json().execution.activeRun) break;
          await new Promise((r) => setTimeout(r, 25));
        }

        const guard = await app.inject({ method: 'GET', url: `/api/projects/${pid}/guard` });
        const entry = guard.json().guard.tasks[0];
        if (entry.task.status === 'awaiting_merge' && entry.task.reviewRounds <= 2) {
          passedWithin2Rounds += 1;
        }

        if (idx === 5) {
          // Verify Reject endpoint on project 5
          const rej = await app.inject({
            method: 'POST',
            url: `/api/projects/${pid}/tasks/${tid}/reject`,
            payload: { note: 'Needs stricter types', requeue: true },
          });
          expect(rej.statusCode).toBe(200);
          expect(rej.json().task.status).toBe('approved');
          expect(rej.json().task.rejectionNote).toBe('Needs stricter types');
        } else {
          const merged = await app.inject({
            method: 'POST',
            url: `/api/projects/${pid}/tasks/${tid}/approve-merge`,
            payload: { runIntegration: true },
          });
          expect(merged.statusCode).toBe(200);
          expect(merged.json().task.status).toBe('done');
          expect(merged.json().integrationRun.status).toBe('passed');
        }
      }

      expect(passedWithin2Rounds).toBe(5);
      expect(fixTracker.size).toBe(1);

      // Cleanup routing rule; deleting an in-use profile is rejected while unused profiles can be deleted
      expect((await app.inject({ method: 'DELETE', url: `/api/routing/${ruleId}` })).statusCode).toBe(200);
      expect((await app.inject({ method: 'DELETE', url: `/api/profiles/${profId}` })).statusCode).toBe(400);

      const unusedProf = await app.inject({
        method: 'POST',
        url: '/api/profiles',
        payload: { name: 'temp-unused', provider: 'codex', permissionMode: 'read-only' },
      });
      expect(unusedProf.statusCode).toBe(201);
      const unusedId = unusedProf.json().profile.id as string;
      expect((await app.inject({ method: 'DELETE', url: `/api/profiles/${unusedId}` })).statusCode).toBe(200);
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

  it('keeps the Antigravity keyring opt-in off by default and stores a change', async () => {
    const dbDir = makeTempDir('dalang-db-');
    const { app, close } = await createDalangServer({ dbPath: path.join(dbDir, 'dalang.db') });
    try {
      const before = await app.inject({ method: 'GET', url: '/api/settings' });
      expect(before.json()).toEqual({ settings: { antigravityKeyringAccess: false } });

      const patched = await app.inject({
        method: 'PATCH',
        url: '/api/settings',
        payload: { antigravityKeyringAccess: true },
      });
      expect(patched.json()).toEqual({ settings: { antigravityKeyringAccess: true } });
      expect((await app.inject({ method: 'GET', url: '/api/settings' })).json().settings.antigravityKeyringAccess).toBe(true);

      const bad = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { antigravityKeyringAccess: 'yes' } });
      expect(bad.statusCode).toBe(400);
    } finally {
      await close();
    }
  });
});

