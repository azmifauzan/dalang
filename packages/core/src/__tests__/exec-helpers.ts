import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProviderRegistry } from '../adapters/registry.js';
import type { CliRunner, RunCommandOptions, RunCommandResult } from '../adapters/types.js';
import { openDatabase } from '../db/client.js';
import { DalangEventBus, type DalangEvent } from '../services/events.js';
import { ExecutionService } from '../services/executor.js';
import { LeadService } from '../services/lead.js';
import { ProjectService } from '../services/project.js';
import { SettingsService } from '../services/settings.js';

const tempDirs: string[] = [];
export function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function setupApprovedProject(
  runner: CliRunner,
  tasksOverride?: Array<{
    id: string;
    title: string;
    complexity?: 'low' | 'medium' | 'high';
    depends_on?: string[];
    files_allowed?: string[];
  }>,
) {
  const dbDir = makeTempDir('dalang-exec-db-');
  const projDir = path.join(makeTempDir('dalang-exec-proj-'), 'crud-app');
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
    mode: 'create',
    name: 'CRUD App',
    path: projDir,
    stackHint: 'TypeScript + SQLite',
    initGitIfMissing: false,
    leadProvider: 'claude-code',
  });

  await leadSvc.finishDiscussAndWriteBrief(project.id);
  const briefs = leadSvc.listBriefs(project.id);
  leadSvc.approveBrief(project.id, briefs[0].version);

  const plan = await leadSvc.generatePlan(project.id);
  if (tasksOverride) {
    // Replace generated task with custom multi-task graph via API-equivalent edits
    for (const existing of plan.tasks) {
      leadSvc.deleteTask(project.id, existing.id);
    }
    for (const t of tasksOverride) {
      leadSvc.createTask(project.id, {
        title: t.title,
        milestone: 'M1',
        role: 'engineer',
        complexity: t.complexity ?? 'low',
        dependsOn: t.depends_on ?? [],
        goal: `Implement ${t.title}`,
        filesAllowed: t.files_allowed ?? ['src/**'],
        filesReference: ['PROJECT.md'],
        acceptanceCriteria: [`${t.title} works`],
        verify: 'pnpm test',
        needsSplit: false,
        status: 'ready',
      });
    }
  }
  const approvedPlan = leadSvc.approvePlan(project.id);

  return { conn, events, project, plan: approvedPlan, leadSvc, execSvc, projDir };
}

export function handleLeadCalls(cwd: string, args: string[], opts: RunCommandOptions): RunCommandResult | null {
  const promptArg = args.find((a) => a.includes('.dalang/')) ?? args.join(' ');
  const emitClaude = (sid: string, text: string) => {
    const line = JSON.stringify({ type: 'result', session_id: sid, result: text });
    opts.onStdoutLine?.(line);
    return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
  };

  const briefMatch = promptArg.match(/\.dalang\/brief\.v(\d+)\.json/);
  if (briefMatch) {
    const ver = Number(briefMatch[1]);
    fs.writeFileSync(
      path.join(cwd, '.dalang', `brief.v${ver}.json`),
      JSON.stringify({
        version: ver,
        title: 'CRUD App',
        summary: 'Local CRUD app',
        scope: ['Create and list items'],
        features: ['Item CRUD'],
        stack: ['TypeScript'],
        constraints: [],
        out_of_scope: [],
        assumptions: [],
      }),
    );
    return emitClaude('lead-1', 'Brief ready');
  }

  if (promptArg.includes('.dalang/tmp/plan-v')) {
    const target = path.join(cwd, '.dalang', 'tmp', 'plan-v1.json');
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
            title: 'Create store module',
            milestone: 'M1',
            role: 'engineer',
            complexity: 'low',
            depends_on: [],
            goal: 'Write src/store.ts',
            files_allowed: ['src/**'],
            files_reference: ['PROJECT.md'],
            acceptance_criteria: ['src/store.ts exists'],
            verify: 'pnpm test',
            needs_split: false,
          },
        ],
      }),
    );
    return emitClaude('lead-1', 'Plan ready');
  }

  return null;
}

export function handleVerifyAndReviewCalls(
  cmd: string,
  args: string[],
  opts: RunCommandOptions,
  reviewStatus: 'pass' | 'fail' = 'pass',
): RunCommandResult | null {
  const joined = `${cmd} ${args.join(' ')}`;
  if (args.includes('/bin/sh') && args.includes('-c')) {
    opts.onStdoutLine?.('Tests passed');
    return { exitCode: 0, stdout: 'Tests passed\n', stderr: '', timedOut: false, idleTimedOut: false };
  }

  const reviewMatch = joined.match(/code review round \d+ of \d+ for task ([A-Za-z0-9_-]+)/i);
  if (reviewMatch) {
    const extId = reviewMatch[1];
    const payload = JSON.stringify({
      task_id: extId,
      status: reviewStatus,
      verify_exit_code: 0,
      summary: reviewStatus === 'pass' ? `Verified ${extId}` : `Issues found in ${extId}`,
      findings:
        reviewStatus === 'pass'
          ? []
          : [{ severity: 'critical', file: 'src/store.ts', note: 'Missing edge case handling' }],
    });
    const isCodex = joined.includes('codex');
    const isAgy = joined.includes('agy');
    const line = isCodex
      ? JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: payload } })
      : isAgy
        ? JSON.stringify({ type: 'result', conversation_id: 'rev-agy-1', response: payload })
        : JSON.stringify({ type: 'result', session_id: 'rev-claude-1', result: payload });
    opts.onStdoutLine?.(line);
    return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
  }

  return null;
}

