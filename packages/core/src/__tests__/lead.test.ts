import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliRunner, RunCommandOptions, RunCommandResult } from '../adapters/types.js';
import { ProviderRegistry } from '../adapters/registry.js';
import { openDatabase } from '../db/client.js';
import { LeadService } from '../services/lead.js';
import { ProjectService } from '../services/project.js';

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

const brokenPlan = {
  version: 1,
  brief_version: 1,
  milestones: [{ id: 'M1', title: 'Core' }],
  tasks: [
    {
      id: 'T-001',
      title: 'Orphan dependency',
      milestone: 'M9',
      role: 'engineer',
      complexity: 'low',
      depends_on: ['T-404'],
      goal: 'Reference things that do not exist',
      files_allowed: [],
      files_reference: [],
      acceptance_criteria: ['n/a'],
      verify: 'true',
      needs_split: false,
    },
  ],
};

function createScriptedLeadRunner(
  projectPath: string,
  opts?: { invalidDiscussAttempts?: number; badPlanDrafts?: number },
): CliRunner {
  let discussCalls = 0;
  let planDrafts = 0;

  return {
    async which(bin) {
      return `/usr/bin/${bin}`;
    },
    async run(_cmd, args, runOpts: RunCommandOptions): Promise<RunCommandResult> {
      const joined = args.join(' ');

      // Inspect prompt argument regardless of bwrap wrapping
      const promptArg =
        args.find((a) => a.includes('round-')) ||
        args.find((a) => a.includes('brief.v')) ||
        args.find((a) => a.includes('plan-v')) ||
        args.find((a) => a.includes('split-')) ||
        joined;

      const emitClaudeResult = (sessionId: string, text: string) => {
        const line = JSON.stringify({ type: 'result', session_id: sessionId, result: text });
        runOpts.onStdoutLine?.(line);
        return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
      };

      const splitMatch = promptArg.match(
        /(\.dalang\/(?:sessions\/[A-Za-z0-9_-]+\/)?tmp\/split-([A-Za-z0-9-]+)-d(\d+)\.json)/,
      );
      if (splitMatch) {
        const parentId = splitMatch[2];
        const depth = Number(splitMatch[3]);
        const target = path.join(projectPath, splitMatch[1]);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(
          target,
          JSON.stringify({
            parent_task_id: parentId,
            subtasks: [
              {
                id: `${parentId}a`,
                title: `${parentId} part A`,
                milestone: 'M1',
                role: 'engineer',
                complexity: 'low',
                depends_on: [],
                goal: 'Implement part A',
                files_allowed: ['src/a.ts'],
                files_reference: ['PROJECT.md'],
                acceptance_criteria: ['Part A passes tests'],
                verify: 'pnpm test a',
                needs_split: depth < 2 ? true : false,
              },
              {
                id: `${parentId}b`,
                title: `${parentId} part B`,
                milestone: 'M1',
                role: 'engineer',
                complexity: 'low',
                depends_on: [`${parentId}a`],
                goal: 'Implement part B',
                files_allowed: ['src/b.ts'],
                files_reference: ['PROJECT.md'],
                acceptance_criteria: ['Part B passes tests'],
                verify: 'pnpm test b',
                needs_split: false,
              },
            ],
          }),
        );
        return emitClaudeResult('sess-lead-1', `Split ${parentId}`);
      }

      const roundMatch = promptArg.match(
        /(\.dalang\/(?:sessions\/[A-Za-z0-9_-]+\/)?discuss\/round-(\d+)\.json)/,
      );
      if (roundMatch) {
        discussCalls += 1;
        const roundNum = Number(roundMatch[2]);
        const target = path.join(projectPath, roundMatch[1]);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (discussCalls <= (opts?.invalidDiscussAttempts ?? 0)) {
          // Intentionally write invalid schema to verify retry mechanism!
          fs.writeFileSync(target, JSON.stringify({ wrong_field: true }));
          return emitClaudeResult('sess-lead-1', 'Oops');
        }
        fs.writeFileSync(
          target,
          JSON.stringify({
            round: roundNum,
            summary: 'Clarifying database and auth preference',
            ready_for_brief: false,
            questions: [
              {
                id: 'q1',
                question: 'Which database should store attendance records?',
                reason: 'Determines schema and local deployment setup',
                kind: 'single',
                options: ['SQLite', 'PostgreSQL'],
                allow_custom: true,
              },
            ],
          }),
        );
        return emitClaudeResult('sess-lead-1', 'Asked round questions');
      }

      const briefMatch = promptArg.match(
        /(\.dalang\/(?:sessions\/[A-Za-z0-9_-]+\/)?brief\.v(\d+)\.json)/,
      );
      if (briefMatch) {
        const ver = Number(briefMatch[2]);
        const target = path.join(projectPath, briefMatch[1]);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(
          target,
          JSON.stringify({
            version: ver,
            title: `Attendance App Brief v${ver}`,
            summary: 'Barcode-based attendance app with WhatsApp notifications.',
            scope: ['Barcode check-in', 'Daily attendance log'],
            features: ['POST /attendance/scan', 'WhatsApp webhook'],
            stack: ['Node 26', 'Fastify', 'SQLite'],
            constraints: ['Runs locally'],
            out_of_scope: ['Payroll calculation'],
            assumptions: ['Single office timezone'],
          }),
        );
        return emitClaudeResult('sess-lead-1', `Wrote brief v${ver}`);
      }

      const planMatch = promptArg.match(
        /(\.dalang\/(?:sessions\/[A-Za-z0-9_-]+\/)?tmp\/plan-v\d+\.json)/,
      );
      if (planMatch) {
        planDrafts += 1;
        const target = path.join(projectPath, planMatch[1]);
        if (opts?.badPlanDrafts && planDrafts <= opts.badPlanDrafts) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, JSON.stringify(brokenPlan));
          return emitClaudeResult('sess-lead-1', 'Wrote a plan with dangling references');
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(
          target,
          JSON.stringify({
            version: 1,
            brief_version: 2,
            milestones: [
              { id: 'M1', title: 'Core API' },
              { id: 'M2', title: 'UI & Polish' },
            ],
            tasks: [
              {
                id: 'T-001',
                title: 'Setup SQLite schema',
                milestone: 'M1',
                role: 'engineer',
                complexity: 'low',
                depends_on: [],
                goal: 'Create attendance table',
                files_allowed: ['src/db/**'],
                files_reference: ['PROJECT.md'],
                acceptance_criteria: ['Migration creates attendance table'],
                verify: 'pnpm test db',
                needs_split: false,
              },
              {
                id: 'T-002',
                title: 'Full scan & notification module',
                milestone: 'M1',
                role: 'engineer',
                complexity: 'high',
                depends_on: ['T-001'],
                goal: 'Implement scan endpoint and WhatsApp alerts',
                files_allowed: ['src/scan/**'],
                files_reference: ['src/db/schema.ts'],
                acceptance_criteria: ['Scan works'],
                verify: 'pnpm test scan',
                needs_split: true,
              },
            ],
          }),
        );
        return emitClaudeResult('sess-lead-1', 'Wrote plan.json');
      }

      return emitClaudeResult('sess-lead-1', 'Unhandled prompt');
    },
  };
}

describe('LeadService end-to-end Rembuk flow (F-03 to F-10)', () => {
  it('retries invalid contract output up to 2 times, resumes session, generates brief & plan, and auto-splits up to 2 levels', async () => {
    const dbDir = makeTempDir('dalang-db-');
    const conn = openDatabase(path.join(dbDir, 'dalang.db'));
    const projectSvc = new ProjectService(conn.db);
    const repoDir = path.join(makeTempDir('dalang-repo-'), 'attendance-app');

    const proj = await projectSvc.createOrOpen({
      mode: 'create',
      name: 'Attendance App',
      path: repoDir,
      initGitIfMissing: false,
      leadProvider: 'claude-code',
    });

    const runner = createScriptedLeadRunner(repoDir, { invalidDiscussAttempts: 2 });
    const registry = new ProviderRegistry(runner);
    const lead = new LeadService(conn.db, registry);

    // 1. Discuss round 1 (fails twice, succeeds on 3rd attempt = maxRetries 2)
    const roundRes = await lead.sendDiscussMessage(proj.id, {
      message: 'Build a barcode attendance app with WhatsApp notifications',
    });
    expect(roundRes.round.round).toBe(1);
    expect(roundRes.round.questions).toHaveLength(1);
    expect(lead.getDiscussState(proj.id).session?.cliSessionId).toBe('sess-lead-1');

    // 2. Finish discuss -> draft brief v1
    const briefV1 = await lead.finishDiscussAndWriteBrief(proj.id);
    expect(briefV1.version).toBe(1);
    expect(briefV1.status).toBe('draft');

    // 3. Revise brief -> brief v2, edit inline, then approve
    const briefV2 = await lead.reviseBrief(proj.id, 1, 'Add CSV export to scope');
    expect(briefV2.version).toBe(2);

    const edited = lead.updateBrief(proj.id, 2, {
      ...briefV2.content,
      scope: [...briefV2.content.scope, 'CSV export'],
    });
    expect(edited.content.scope).toContain('CSV export');

    // Cannot generate plan before brief approval
    await expect(lead.generatePlan(proj.id)).rejects.toThrow(/approve a brief/i);

    const approvedBrief = lead.approveBrief(proj.id, 2);
    expect(approvedBrief.status).toBe('approved');
    expect(() =>
      lead.updateBrief(proj.id, 2, edited.content),
    ).toThrow(/approved and locked/i);

    // 4. Generate plan -> T-002 has needs_split=true -> splits depth 1 (T-002a needs_split=true, T-002b), then depth 2 (T-002aa, T-002ab)
    const plan = await lead.generatePlan(proj.id);
    expect(plan.tasks.length).toBe(4);
    expect(plan.tasks.every((t) => t.needsSplit === false)).toBe(true);
    expect(plan.tasks.some((t) => t.parentTaskId === 'T-002a')).toBe(true);

    // 5. Kanban CRUD, cycle detection, and reorder
    const customTask = lead.createTask(proj.id, {
      title: 'Add README',
      milestone: 'M2',
      role: 'engineer',
      complexity: 'low',
      dependsOn: ['T-001'],
      goal: 'Document setup steps',
      filesAllowed: ['README.md'],
      filesReference: ['PROJECT.md'],
      acceptanceCriteria: ['README explains setup'],
      verify: 'test -f README.md',
      needsSplit: false,
      status: 'ready',
      profileOverride: 'coder-small',
    });
    expect(customTask.profileOverride).toBe('coder-small');

    // Reject circular dependency
    const t001 = plan.tasks.find((t) => t.externalId === 'T-001')!;
    expect(() =>
      lead.updateTask(proj.id, t001.id, { dependsOn: [customTask.externalId] }),
    ).toThrow(/circular dependency/i);

    const reordered = lead.reorderTasks(proj.id, {
      updates: [{ id: customTask.id, position: 0, status: 'ready' }],
    });
    expect(reordered.tasks.find((t) => t.id === customTask.id)?.position).toBe(0);

    const approvedPlan = lead.approvePlan(proj.id);
    expect(approvedPlan.status).toBe('approved');
    expect(approvedPlan.tasks.every((t) => t.status === 'approved')).toBe(true);

    // Verify session plan.json on disk matches
    const onDiskPlan = JSON.parse(fs.readFileSync(path.join(repoDir, approvedPlan.filePath), 'utf8'));
    expect(onDiskPlan.tasks).toHaveLength(5);

    conn.close();
  });
});

async function bootstrapApprovedBrief(runnerOpts?: { badPlanDrafts?: number }) {
  const dbDir = makeTempDir('dalang-db-');
  const conn = openDatabase(path.join(dbDir, 'dalang.db'));
  const projectSvc = new ProjectService(conn.db);
  const repoDir = path.join(makeTempDir('dalang-repo-'), 'app');
  const proj = await projectSvc.createOrOpen({
    mode: 'create',
    name: 'App',
    path: repoDir,
    initGitIfMissing: false,
    leadProvider: 'claude-code',
  });
  const lead = new LeadService(conn.db, new ProviderRegistry(createScriptedLeadRunner(repoDir, runnerOpts)));
  await lead.finishDiscussAndWriteBrief(proj.id);
  lead.approveBrief(proj.id, 1);
  return { conn, lead, proj, repoDir, projectSvc };
}

describe('Lead hardening', () => {
  it('sends a plan with dangling milestone and dependency references back to the agent, then fails after the retries', async () => {
    const { conn, lead, proj } = await bootstrapApprovedBrief({ badPlanDrafts: 3 });
    await expect(lead.generatePlan(proj.id)).rejects.toThrow(/unknown (milestone|task)/i);
    expect(lead.getPlan(proj.id)).toBeNull();
    conn.close();
  });

  it('keeps the current plan.json when a regeneration attempt fails', async () => {
    const { conn, lead, proj, repoDir } = await bootstrapApprovedBrief();
    const generated = await lead.generatePlan(proj.id);
    const planPath = path.join(repoDir, generated.filePath);
    const before = fs.readFileSync(planPath, 'utf8');

    // A second draft that is invalid must leave the saved plan untouched.
    const failing = new LeadService(conn.db, new ProviderRegistry(createScriptedLeadRunner(repoDir, { badPlanDrafts: 9 })));
    await expect(failing.generatePlan(proj.id)).rejects.toThrow();
    expect(fs.readFileSync(planPath, 'utf8')).toBe(before);
    conn.close();
  });

  it('rejects overlapping Lead turns on the same project', async () => {
    const { conn, lead, proj } = await bootstrapApprovedBrief();
    const first = lead.generatePlan(proj.id);
    await expect(lead.generatePlan(proj.id)).rejects.toThrow(/still working/i);
    await first;
    conn.close();
  });

  it('keeps the needs-split flag and column in step, and blocks approval while a task still needs a split', async () => {
    const { conn, lead, proj } = await bootstrapApprovedBrief();
    const plan = await lead.generatePlan(proj.id);
    const task = plan.tasks[0];

    const flagged = lead.updateTask(proj.id, task.id, { needsSplit: true });
    expect(flagged.status).toBe('needs_split');
    expect(() => lead.approvePlan(proj.id)).toThrow(/split or clear/i);

    const moved = lead.reorderTasks(proj.id, { updates: [{ id: task.id, position: 0, status: 'ready' }] });
    expect(moved.tasks.find((t) => t.id === task.id)).toMatchObject({ status: 'ready', needsSplit: false });

    // Hand-set status can never be `approved`, and milestones must exist in the plan.
    expect(() => lead.createTask(proj.id, {
      title: 'Bad milestone',
      milestone: 'M99',
      role: 'engineer',
      complexity: 'low',
      dependsOn: [],
      goal: 'x',
      filesAllowed: [],
      filesReference: [],
      acceptanceCriteria: ['x'],
      verify: 'true',
      needsSplit: false,
      status: 'ready',
    })).toThrow(/unknown milestone/i);

    expect(lead.approvePlan(proj.id).status).toBe('approved');
    await expect(lead.generatePlan(proj.id)).rejects.toThrow(/approved and locked/i);
    conn.close();
  });
});
