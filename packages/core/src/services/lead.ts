import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  BriefContentSchema,
  DiscussRoundSchema,
  PlanContractSchema,
  TaskSplitOutputSchema,
  type BriefContent,
  type BriefDTO,
  type CreateTaskInput,
  type DiscussMessageDTO,
  type DiscussMessageInput,
  type DiscussRound,
  type EditableTaskStatus,
  type PlanContract,
  type PlanDTO,
  type PlanMilestone,
  type PlanTaskContract,
  type PlanTaskRole,
  type ProviderId,
  type ReorderTasksInput,
  type TaskComplexity,
  type TaskDTO,
  type TaskStatus,
  type UpdateTaskInput,
} from '@dalang/shared';
import type { ProviderRegistry } from '../adapters/registry.js';
import type { DalangDb } from '../db/client.js';
import { briefs, messages, plans, projects, sessions, taskDependencies, tasks } from '../db/schema.js';
import { getProjectDalangDir, getProjectDiscussDir, getProjectTmpDir } from '../paths.js';
import { ensureProjectDir, readArtifactFile, writeArtifactFile } from '../safe-fs.js';
import { runContractTurn } from './contract.js';
import type { DalangEventBus } from './events.js';

export const MAX_SPLIT_DEPTH = 2;

export function hasDependencyCycle(
  edges: Map<string, string[]>,
  sourceId: string,
  candidateDeps: string[],
): boolean {
  const nextEdges = new Map(edges);
  nextEdges.set(sourceId, candidateDeps);

  const visited = new Set<string>();
  const visiting = new Set<string>();

  const dfs = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    for (const dep of nextEdges.get(nodeId) ?? []) {
      if (dep === nodeId || dfs(dep)) return true;
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };

  return dfs(sourceId);
}

export class LeadService {
  private readonly activeTurns = new Set<string>();

  constructor(
    private readonly db: DalangDb,
    private readonly registry: ProviderRegistry,
    private readonly events?: DalangEventBus,
  ) {}

  /** One Lead turn per project at a time: turns share a CLI session and write numbered artifacts. */
  private async exclusiveTurn<T>(projectId: string, run: () => Promise<T>): Promise<T> {
    if (this.activeTurns.has(projectId)) {
      throw new Error('The Lead is still working on this project. Wait for the current turn to finish.');
    }
    this.activeTurns.add(projectId);
    try {
      return await run();
    } finally {
      this.activeTurns.delete(projectId);
    }
  }

  sendDiscussMessage(
    projectId: string,
    input: DiscussMessageInput,
  ): Promise<{ round: DiscussRound; messages: DiscussMessageDTO[] }> {
    return this.exclusiveTurn(projectId, () => this.sendDiscussMessageInner(projectId, input));
  }

  finishDiscussAndWriteBrief(projectId: string): Promise<BriefDTO> {
    return this.exclusiveTurn(projectId, () => this.finishDiscussAndWriteBriefInner(projectId));
  }

  reviseBrief(projectId: string, version: number, note: string): Promise<BriefDTO> {
    return this.exclusiveTurn(projectId, () => this.reviseBriefInner(projectId, version, note));
  }

  generatePlan(projectId: string): Promise<PlanDTO> {
    return this.exclusiveTurn(projectId, () => this.generatePlanInner(projectId));
  }

  private getProjectRow(projectId: string) {
    const row = this.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!row) throw new Error(`Project not found: ${projectId}`);
    return row;
  }

  private getOrCreateLeadSession(projectId: string, overrideProvider?: ProviderId, overrideModel?: string) {
    const project = this.getProjectRow(projectId);
    const provider = overrideProvider ?? (project.leadProvider as ProviderId);
    const model = overrideModel !== undefined ? overrideModel : project.leadModel;

    const existing = this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.projectId, projectId), eq(sessions.phase, 'discuss')))
      .orderBy(desc(sessions.updatedAt))
      .get();

    const now = new Date().toISOString();
    if (existing) {
      // If user switched provider, clear cliSessionId since session IDs are provider-specific.
      if (existing.provider !== provider || (model !== undefined && existing.model !== (model || null))) {
        const nextCliId = existing.provider === provider ? existing.cliSessionId : null;
        this.db
          .update(sessions)
          .set({
            provider,
            model: model || null,
            cliSessionId: nextCliId,
            updatedAt: now,
          })
          .where(eq(sessions.id, existing.id))
          .run();
        return this.db.select().from(sessions).where(eq(sessions.id, existing.id)).get()!;
      }
      return existing;
    }

    const id = crypto.randomUUID();
    this.db
      .insert(sessions)
      .values({
        id,
        projectId,
        phase: 'discuss',
        provider,
        model: model || null,
        cliSessionId: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    return this.db.select().from(sessions).where(eq(sessions.id, id)).get()!;
  }

  private appendMessage(
    sessionId: string,
    role: 'user' | 'lead' | 'system',
    type: 'text' | 'questions' | 'brief' | 'plan' | 'error',
    content: unknown,
  ): DiscussMessageDTO {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const serialized = typeof content === 'string' ? content : JSON.stringify(content);
    this.db
      .insert(messages)
      .values({
        id,
        sessionId,
        role,
        type,
        content: serialized,
        createdAt,
      })
      .run();

    return {
      id,
      sessionId,
      role,
      type,
      content,
      createdAt,
    };
  }

  getDiscussState(projectId: string): {
    session: {
      id: string;
      provider: ProviderId;
      model: string | null;
      cliSessionId: string | null;
    } | null;
    messages: DiscussMessageDTO[];
    currentRound: number;
  } {
    this.getProjectRow(projectId);
    const session = this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.projectId, projectId), eq(sessions.phase, 'discuss')))
      .orderBy(desc(sessions.updatedAt))
      .get();

    if (!session) {
      return { session: null, messages: [], currentRound: 0 };
    }

    const msgRows = this.db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, session.id))
      .orderBy(asc(messages.createdAt))
      .all();

    let maxRound = 0;
    const formatted: DiscussMessageDTO[] = msgRows.map((row) => {
      let parsedContent: unknown = row.content;
      if (row.type !== 'text' && row.type !== 'error') {
        try {
          parsedContent = JSON.parse(row.content);
          if (row.type === 'questions' && parsedContent && typeof parsedContent === 'object') {
            const r = (parsedContent as { round?: number }).round;
            if (typeof r === 'number' && r > maxRound) maxRound = r;
          }
        } catch {
          parsedContent = row.content;
        }
      }
      return {
        id: row.id,
        sessionId: row.sessionId,
        role: row.role as 'user' | 'lead' | 'system',
        type: row.type as 'text' | 'questions' | 'brief' | 'plan' | 'error',
        content: parsedContent,
        createdAt: row.createdAt,
      };
    });

    return {
      session: {
        id: session.id,
        provider: session.provider as ProviderId,
        model: session.model,
        cliSessionId: session.cliSessionId,
      },
      messages: formatted,
      currentRound: maxRound,
    };
  }

  private async sendDiscussMessageInner(
    projectId: string,
    input: DiscussMessageInput,
  ): Promise<{ round: DiscussRound; messages: DiscussMessageDTO[] }> {
    const project = this.getProjectRow(projectId);
    const session = this.getOrCreateLeadSession(projectId, input.provider, input.model);
    const state = this.getDiscussState(projectId);
    const nextRound = state.currentRound + 1;

    const userText = this.formatUserDiscussMessage(input);
    this.appendMessage(session.id, 'user', 'text', userText);
    this.events?.emitEvent({ type: 'discuss.updated', projectId });

    const discussDir = getProjectDiscussDir(project.path);
    ensureProjectDir(project.path, discussDir);
    const roundFilePath = path.join(discussDir, `round-${nextRound}.json`);
    const relRoundPath = path.relative(project.path, roundFilePath);

    const projectMdPath = path.join(project.path, 'PROJECT.md');
    const projectContext = fs.existsSync(projectMdPath)
      ? readArtifactFile(project.path, projectMdPath)
      : '';

    const prompt = [
      `You are the Lead architect in DALANG's Discuss phase.`,
      `Project: ${project.name} (${project.path})`,
      projectContext ? `\nCurrent PROJECT.md:\n${projectContext}\n` : '',
      `User input:\n${userText}`,
      ``,
      `Instructions:`,
      `- Ask focused, high-leverage clarification questions (2 to 5 questions) to pin down scope, stack, constraints, and edge cases.`,
      `- If the goal is already completely clear, set "ready_for_brief": true and "questions": [].`,
      `- Write your JSON response directly to the file "${relRoundPath}" with round = ${nextRound}.`,
      `- Schema: ${JSON.stringify(z.toJSONSchema(DiscussRoundSchema))}`,
    ].join('\n');

    const adapter = this.registry.getAdapter(session.provider as ProviderId);
    this.events?.emitEvent({
      type: 'lead.turn_started',
      projectId,
      phase: 'discuss',
      provider: session.provider,
    });

    try {
      const result = await runContractTurn({
        adapter,
        projectPath: project.path,
        sessionId: session.cliSessionId,
        model: session.model,
        effort: 'high',
        prompt,
        targetFilePath: roundFilePath,
        schema: DiscussRoundSchema,
        schemaName: `discuss-round-${nextRound}`,
        onLogLine: (line) =>
          this.events?.emitEvent({ type: 'lead.log', projectId, phase: 'discuss', line }),
      });

      this.db
        .update(sessions)
        .set({
          cliSessionId: result.sessionId,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(sessions.id, session.id))
        .run();

      this.appendMessage(session.id, 'lead', 'questions', result.data);
      this.events?.emitEvent({ type: 'lead.turn_finished', projectId, phase: 'discuss', ok: true });
      this.events?.emitEvent({ type: 'discuss.updated', projectId });

      return {
        round: result.data,
        messages: this.getDiscussState(projectId).messages,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendMessage(session.id, 'system', 'error', msg);
      this.events?.emitEvent({
        type: 'lead.turn_finished',
        projectId,
        phase: 'discuss',
        ok: false,
        error: msg,
      });
      this.events?.emitEvent({ type: 'discuss.updated', projectId });
      throw err;
    }
  }

  private async finishDiscussAndWriteBriefInner(projectId: string): Promise<BriefDTO> {
    const project = this.getProjectRow(projectId);
    const session = this.getOrCreateLeadSession(projectId);
    const existingBriefs = this.listBriefs(projectId);
    const nextVersion = existingBriefs.length > 0 ? existingBriefs[0].version + 1 : 1;

    const dalangDir = getProjectDalangDir(project.path);
    ensureProjectDir(project.path, dalangDir);
    const briefFilePath = path.join(dalangDir, `brief.v${nextVersion}.json`);
    const relBriefPath = path.relative(project.path, briefFilePath);

    const discussHistory = this.getDiscussState(projectId).messages;
    const transcriptSummary = discussHistory
      .map((m) => `[${m.role}/${m.type}] ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
      .join('\n');

    const prompt = [
      `The user has ended the Discuss Q&A ("enough, write the brief").`,
      `Synthesize everything discussed so far into a concrete, testable Project Brief.`,
      transcriptSummary ? `\nDiscussion transcript:\n${transcriptSummary}\n` : '',
      `Write the brief JSON directly to "${relBriefPath}" with version = ${nextVersion}.`,
      `Schema: ${JSON.stringify(z.toJSONSchema(BriefContentSchema))}`,
    ].join('\n');

    const adapter = this.registry.getAdapter(session.provider as ProviderId);
    this.events?.emitEvent({
      type: 'lead.turn_started',
      projectId,
      phase: 'agree',
      provider: session.provider,
    });

    try {
      const result = await runContractTurn({
        adapter,
        projectPath: project.path,
        sessionId: session.cliSessionId,
        model: session.model,
        effort: 'high',
        prompt,
        targetFilePath: briefFilePath,
        schema: BriefContentSchema,
        schemaName: `brief-v${nextVersion}`,
        onLogLine: (line) =>
          this.events?.emitEvent({ type: 'lead.log', projectId, phase: 'agree', line }),
      });

      const normalized: BriefContent = { ...result.data, version: nextVersion };
      writeArtifactFile(project.path, briefFilePath, JSON.stringify(normalized, null, 2));

      this.db
        .update(sessions)
        .set({
          cliSessionId: result.sessionId,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(sessions.id, session.id))
        .run();

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      this.db
        .insert(briefs)
        .values({
          id,
          projectId,
          version: nextVersion,
          status: 'draft',
          filePath: relBriefPath,
          createdAt: now,
          approvedAt: null,
        })
        .run();

      this.appendMessage(session.id, 'lead', 'brief', {
        version: nextVersion,
        title: normalized.title,
      });

      this.events?.emitEvent({ type: 'lead.turn_finished', projectId, phase: 'agree', ok: true });
      this.events?.emitEvent({ type: 'brief.updated', projectId, version: nextVersion });
      this.events?.emitEvent({ type: 'discuss.updated', projectId });

      return this.getBriefByVersion(projectId, nextVersion);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.events?.emitEvent({
        type: 'lead.turn_finished',
        projectId,
        phase: 'agree',
        ok: false,
        error: msg,
      });
      throw err;
    }
  }

  listBriefs(projectId: string): BriefDTO[] {
    const project = this.getProjectRow(projectId);
    const rows = this.db
      .select()
      .from(briefs)
      .where(eq(briefs.projectId, projectId))
      .orderBy(desc(briefs.version))
      .all();

    return rows.map((row) => this.readBriefRow(project.path, row));
  }

  getBriefByVersion(projectId: string, version: number): BriefDTO {
    const project = this.getProjectRow(projectId);
    const row = this.db
      .select()
      .from(briefs)
      .where(and(eq(briefs.projectId, projectId), eq(briefs.version, version)))
      .get();
    if (!row) throw new Error(`Brief v${version} not found`);
    return this.readBriefRow(project.path, row);
  }

  updateBrief(projectId: string, version: number, rawContent: unknown): BriefDTO {
    const project = this.getProjectRow(projectId);
    const row = this.db
      .select()
      .from(briefs)
      .where(and(eq(briefs.projectId, projectId), eq(briefs.version, version)))
      .get();
    if (!row) throw new Error(`Brief v${version} not found`);
    if (row.status === 'approved') {
      throw new Error(`Brief v${version} is approved and locked. Create a revision instead.`);
    }

    const parsed = BriefContentSchema.parse(rawContent);
    const content: BriefContent = { ...parsed, version };
    const absPath = path.join(project.path, row.filePath);
    writeArtifactFile(project.path, absPath, JSON.stringify(content, null, 2));

    this.events?.emitEvent({ type: 'brief.updated', projectId, version });
    return this.readBriefRow(project.path, row);
  }

  private async reviseBriefInner(projectId: string, version: number, note: string): Promise<BriefDTO> {
    const project = this.getProjectRow(projectId);
    const prevBrief = this.getBriefByVersion(projectId, version);
    const existingBriefs = this.listBriefs(projectId);
    const nextVersion = existingBriefs[0].version + 1;

    const session = this.getOrCreateLeadSession(projectId);
    const dalangDir = getProjectDalangDir(project.path);
    const briefFilePath = path.join(dalangDir, `brief.v${nextVersion}.json`);
    const relBriefPath = path.relative(project.path, briefFilePath);

    const prompt = [
      `Revise the project brief based on the user's feedback note.`,
      `Previous brief (v${version}):\n${JSON.stringify(prevBrief.content, null, 2)}`,
      `User revision note:\n${note}`,
      ``,
      `Write the updated brief JSON directly to "${relBriefPath}" with version = ${nextVersion}.`,
      `Schema: ${JSON.stringify(z.toJSONSchema(BriefContentSchema))}`,
    ].join('\n');

    const adapter = this.registry.getAdapter(session.provider as ProviderId);
    this.events?.emitEvent({
      type: 'lead.turn_started',
      projectId,
      phase: 'agree',
      provider: session.provider,
    });

    try {
      const result = await runContractTurn({
        adapter,
        projectPath: project.path,
        sessionId: session.cliSessionId,
        model: session.model,
        effort: 'high',
        prompt,
        targetFilePath: briefFilePath,
        schema: BriefContentSchema,
        schemaName: `brief-v${nextVersion}`,
        onLogLine: (line) =>
          this.events?.emitEvent({ type: 'lead.log', projectId, phase: 'agree', line }),
      });

      const normalized: BriefContent = { ...result.data, version: nextVersion };
      writeArtifactFile(project.path, briefFilePath, JSON.stringify(normalized, null, 2));

      this.db
        .update(sessions)
        .set({ cliSessionId: result.sessionId, updatedAt: new Date().toISOString() })
        .where(eq(sessions.id, session.id))
        .run();

      this.db
        .insert(briefs)
        .values({
          id: crypto.randomUUID(),
          projectId,
          version: nextVersion,
          status: 'draft',
          filePath: relBriefPath,
          createdAt: new Date().toISOString(),
          approvedAt: null,
        })
        .run();

      this.events?.emitEvent({ type: 'lead.turn_finished', projectId, phase: 'agree', ok: true });
      this.events?.emitEvent({ type: 'brief.updated', projectId, version: nextVersion });
      return this.getBriefByVersion(projectId, nextVersion);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.events?.emitEvent({
        type: 'lead.turn_finished',
        projectId,
        phase: 'agree',
        ok: false,
        error: msg,
      });
      throw err;
    }
  }

  approveBrief(projectId: string, version: number): BriefDTO {
    const row = this.db
      .select()
      .from(briefs)
      .where(and(eq(briefs.projectId, projectId), eq(briefs.version, version)))
      .get();
    if (!row) throw new Error(`Brief v${version} not found`);

    const now = new Date().toISOString();
    this.db
      .update(briefs)
      .set({ status: 'approved', approvedAt: row.approvedAt ?? now })
      .where(eq(briefs.id, row.id))
      .run();

    this.events?.emitEvent({ type: 'brief.updated', projectId, version });
    return this.getBriefByVersion(projectId, version);
  }

  private async generatePlanInner(projectId: string): Promise<PlanDTO> {
    const project = this.getProjectRow(projectId);
    const approvedBrief = this.db
      .select()
      .from(briefs)
      .where(and(eq(briefs.projectId, projectId), eq(briefs.status, 'approved')))
      .orderBy(desc(briefs.version))
      .get();

    if (!approvedBrief) {
      throw new Error('Approve a brief first before generating a plan.');
    }

    const briefDto = this.readBriefRow(project.path, approvedBrief);
    const session = this.getOrCreateLeadSession(projectId);
    const dalangDir = getProjectDalangDir(project.path);
    const planFilePath = path.join(dalangDir, 'plan.json');
    const relPlanPath = path.relative(project.path, planFilePath);

    const existingPlans = this.db
      .select()
      .from(plans)
      .where(eq(plans.projectId, projectId))
      .orderBy(desc(plans.version))
      .all();
    if (existingPlans[0]?.status === 'approved') {
      throw new Error(`Plan v${existingPlans[0].version} is approved and locked. It cannot be regenerated.`);
    }
    const nextPlanVersion = existingPlans.length > 0 ? existingPlans[0].version + 1 : 1;

    // The agent drafts into tmp so a failed run never clobbers the current plan.json.
    const draftFilePath = path.join(getProjectTmpDir(project.path), `plan-v${nextPlanVersion}.json`);
    const relDraftPath = path.relative(project.path, draftFilePath);

    const prompt = [
      `Break the approved project brief into concrete milestones and small, verifiable tasks.`,
      `Approved Brief (v${briefDto.version}):\n${JSON.stringify(briefDto.content, null, 2)}`,
      ``,
      `Task design rules:`,
      `- Each task needs an id like "T-001", "T-002", a milestone id ("M1", "M2"...), role ("engineer" or "qa"), complexity ("low", "medium", "high"), depends_on (array of task ids), goal, files_allowed, files_reference, acceptance_criteria, verify (exact test/check command), and needs_split (boolean).`,
      `- Set needs_split: true if a task is still too large for one focused coding run.`,
      `- Write the plan JSON directly to "${relDraftPath}" with version = ${nextPlanVersion} and brief_version = ${briefDto.version}.`,
      `- Task ids must be unique, every milestone must exist in "milestones", and every depends_on id must be another task in the plan with no cycles.`,
      `- Schema: ${JSON.stringify(z.toJSONSchema(PlanContractSchema))}`,
    ].join('\n');

    const adapter = this.registry.getAdapter(session.provider as ProviderId);
    this.events?.emitEvent({
      type: 'lead.turn_started',
      projectId,
      phase: 'list',
      provider: session.provider,
    });

    try {
      const result = await runContractTurn({
        adapter,
        projectPath: project.path,
        sessionId: session.cliSessionId,
        model: session.model,
        effort: 'high',
        prompt,
        targetFilePath: draftFilePath,
        schema: PlanContractSchema,
        schemaName: `plan-v${nextPlanVersion}`,
        onLogLine: (line) =>
          this.events?.emitEvent({ type: 'lead.log', projectId, phase: 'list', line }),
      });

      let currentSessionId = result.sessionId;
      const expandedTasks = await this.expandNeedsSplitTasks({
        adapter,
        projectPath: project.path,
        sessionId: currentSessionId,
        model: session.model,
        tasksList: result.data.tasks,
        onSessionId: (sid) => {
          currentSessionId = sid;
        },
        onLogLine: (line) =>
          this.events?.emitEvent({ type: 'lead.log', projectId, phase: 'list', line }),
      });

      const expandedIds = new Set(expandedTasks.map((t) => t.task.id));
      const finalCandidate: PlanContract = {
        version: nextPlanVersion,
        brief_version: briefDto.version,
        milestones: result.data.milestones,
        tasks: expandedTasks.map(({ task }) => ({
          ...task,
          depends_on: task.depends_on.filter((d) => d !== task.id && expandedIds.has(d)),
        })),
      };
      const finalContract = PlanContractSchema.parse(finalCandidate);
      writeArtifactFile(project.path, planFilePath, JSON.stringify(finalContract, null, 2));

      this.db
        .update(sessions)
        .set({ cliSessionId: currentSessionId, updatedAt: new Date().toISOString() })
        .where(eq(sessions.id, session.id))
        .run();

      const planId = crypto.randomUUID();
      const now = new Date().toISOString();
      this.db
        .insert(plans)
        .values({
          id: planId,
          projectId,
          briefId: approvedBrief.id,
          version: nextPlanVersion,
          status: 'draft',
          filePath: relPlanPath,
          createdAt: now,
          approvedAt: null,
        })
        .run();

      this.persistPlanTasks(
        planId,
        expandedTasks.map((item, i) => ({ ...item, task: finalContract.tasks[i] })),
      );
      this.syncPlanJsonFile(projectId, planId);

      this.events?.emitEvent({ type: 'lead.turn_finished', projectId, phase: 'list', ok: true });
      this.events?.emitEvent({ type: 'plan.updated', projectId });

      return this.getPlan(projectId)!;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.events?.emitEvent({
        type: 'lead.turn_finished',
        projectId,
        phase: 'list',
        ok: false,
        error: msg,
      });
      throw err;
    }
  }

  private async expandNeedsSplitTasks(opts: {
    adapter: ReturnType<ProviderRegistry['getAdapter']>;
    projectPath: string;
    sessionId: string | null;
    model: string | null;
    tasksList: PlanTaskContract[];
    onSessionId: (sid: string | null) => void;
    onLogLine?: (line: string) => void;
  }): Promise<Array<{ task: PlanTaskContract; splitDepth: number; parentExternalId: string | null }>> {
    let working: Array<{ task: PlanTaskContract; splitDepth: number; parentExternalId: string | null }> =
      opts.tasksList.map((t) => ({ task: t, splitDepth: 0, parentExternalId: null }));

    let sessionId = opts.sessionId;
    const usedIds = new Set(working.map((w) => w.task.id));
    let nextNumericId = this.findMaxTaskNumber(usedIds) + 1;

    for (let depth = 0; depth < MAX_SPLIT_DEPTH; depth++) {
      const toSplit = working.filter((item) => item.task.needs_split && item.splitDepth === depth);
      if (toSplit.length === 0) break;

      for (const item of toSplit) {
        const splitTargetFile = path.join(
          getProjectTmpDir(opts.projectPath),
          `split-${item.task.id}-d${depth + 1}.json`,
        );
        const relSplitFile = path.relative(opts.projectPath, splitTargetFile);

        const prompt = [
          `Task "${item.task.id}" (${item.task.title}) has needs_split: true.`,
          `Split this task into 2 to 4 smaller, concrete subtasks (depth ${depth + 1} of ${MAX_SPLIT_DEPTH}).`,
          depth + 1 >= MAX_SPLIT_DEPTH
            ? `This is the maximum split depth (${MAX_SPLIT_DEPTH}), so every subtask MUST set "needs_split": false.`
            : `Only set "needs_split": true if a subtask is still genuinely too large.`,
          `Original task:\n${JSON.stringify(item.task, null, 2)}`,
          `Write the result JSON directly to "${relSplitFile}".`,
          `Schema: ${JSON.stringify(z.toJSONSchema(TaskSplitOutputSchema))}`,
        ].join('\n');

        const splitRes = await runContractTurn({
          adapter: opts.adapter,
          projectPath: opts.projectPath,
          sessionId,
          model: opts.model,
          effort: 'high',
          prompt,
          targetFilePath: splitTargetFile,
          schema: TaskSplitOutputSchema,
          schemaName: `split-${item.task.id}-d${depth + 1}`,
          onLogLine: opts.onLogLine,
        });

        sessionId = splitRes.sessionId;
        opts.onSessionId(sessionId);

        const replacementIds: string[] = [];
        const newSubtasks = splitRes.data.subtasks.map((sub, idx) => {
          let subId = sub.id;
          if (!subId || usedIds.has(subId)) {
            subId = `T-${String(nextNumericId++).padStart(3, '0')}`;
          }
          usedIds.add(subId);
          replacementIds.push(subId);

          const inheritedDeps = idx === 0 && sub.depends_on.length === 0 ? item.task.depends_on : sub.depends_on;
          const forceNoSplit = depth + 1 >= MAX_SPLIT_DEPTH ? false : sub.needs_split;

          return {
            task: {
              ...sub,
              id: subId,
              milestone: sub.milestone || item.task.milestone,
              depends_on: inheritedDeps,
              needs_split: forceNoSplit,
            },
            splitDepth: depth + 1,
            parentExternalId: item.task.id,
          };
        });

        // Replace parent task with its subtasks and remap any depends_on pointing to parent task id.
        const nextWorking: typeof working = [];
        for (const w of working) {
          if (w.task.id === item.task.id) {
            nextWorking.push(...newSubtasks);
          } else {
            const remappedDeps = w.task.depends_on.flatMap((d) =>
              d === item.task.id ? replacementIds : [d],
            );
            nextWorking.push({
              ...w,
              task: { ...w.task, depends_on: [...new Set(remappedDeps)] },
            });
          }
        }
        working = nextWorking;
      }
    }

    // Ensure at MAX_SPLIT_DEPTH any leftover flag is sanitized to false in final plan.
    return working.map((w) =>
      w.splitDepth >= MAX_SPLIT_DEPTH && w.task.needs_split
        ? { ...w, task: { ...w.task, needs_split: false } }
        : w,
    );
  }

  private findMaxTaskNumber(ids: Set<string>): number {
    let max = 0;
    for (const id of ids) {
      const m = id.match(/(\d+)$/);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max;
  }

  private persistPlanTasks(
    planId: string,
    items: Array<{ task: PlanTaskContract; splitDepth: number; parentExternalId: string | null }>,
  ): void {
    const now = new Date().toISOString();
    const externalToUuid = new Map<string, string>();

    const prepared = items.map((item, idx) => {
      const uuid = crypto.randomUUID();
      externalToUuid.set(item.task.id, uuid);
      return {
        uuid,
        item,
        position: idx,
      };
    });

    for (const entry of prepared) {
      const { task, splitDepth, parentExternalId } = entry.item;
      const status: TaskStatus = task.needs_split ? 'needs_split' : 'ready';
      this.db
        .insert(tasks)
        .values({
          id: entry.uuid,
          planId,
          externalId: task.id,
          title: task.title,
          milestone: task.milestone,
          role: task.role,
          complexity: task.complexity,
          status,
          position: entry.position,
          goal: task.goal,
          filesAllowedJson: JSON.stringify(task.files_allowed),
          filesReferenceJson: JSON.stringify(task.files_reference),
          acceptanceCriteriaJson: JSON.stringify(task.acceptance_criteria),
          verify: task.verify,
          needsSplit: task.needs_split,
          splitDepth,
          parentTaskId: parentExternalId,
          profileOverride: null,
          reviewRounds: 0,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    for (const entry of prepared) {
      for (const depExt of entry.item.task.depends_on) {
        const depUuid = externalToUuid.get(depExt);
        if (depUuid && depUuid !== entry.uuid) {
          this.db
            .insert(taskDependencies)
            .values({ taskId: entry.uuid, dependsOnId: depUuid })
            .onConflictDoNothing()
            .run();
        }
      }
    }
  }

  getPlan(projectId: string): PlanDTO | null {
    const project = this.getProjectRow(projectId);
    const planRow = this.db
      .select()
      .from(plans)
      .where(eq(plans.projectId, projectId))
      .orderBy(desc(plans.version))
      .get();
    if (!planRow) return null;

    let milestones: PlanMilestone[] = [];
    const absPath = path.join(project.path, planRow.filePath);
    if (fs.existsSync(absPath)) {
      try {
        const parsed = JSON.parse(readArtifactFile(project.path, absPath)) as {
          milestones?: PlanMilestone[];
        };
        milestones = parsed.milestones ?? [];
      } catch {
        milestones = [];
      }
    }

    const taskRows = this.db
      .select()
      .from(tasks)
      .where(eq(tasks.planId, planRow.id))
      .orderBy(asc(tasks.position), asc(tasks.externalId))
      .all();

    const uuidToExternal = new Map(taskRows.map((t) => [t.id, t.externalId]));
    const planDeps =
      taskRows.length === 0
        ? []
        : this.db
            .select()
            .from(taskDependencies)
            .where(inArray(taskDependencies.taskId, taskRows.map((t) => t.id)))
            .all();
    const depsByTaskId = new Map<string, string[]>();
    for (const dep of planDeps) {
      const depExt = uuidToExternal.get(dep.dependsOnId);
      if (!depExt) continue;
      const list = depsByTaskId.get(dep.taskId) ?? [];
      list.push(depExt);
      depsByTaskId.set(dep.taskId, list);
    }

    if (milestones.length === 0 && taskRows.length > 0) {
      const seen = new Set<string>();
      for (const t of taskRows) {
        if (!seen.has(t.milestone)) {
          seen.add(t.milestone);
          milestones.push({ id: t.milestone, title: t.milestone, description: '' });
        }
      }
    }

    const taskDtos: TaskDTO[] = taskRows.map((row) => ({
      id: row.id,
      planId: row.planId,
      externalId: row.externalId,
      title: row.title,
      milestone: row.milestone,
      role: row.role as PlanTaskRole,
      complexity: row.complexity as TaskComplexity,
      status: row.status as TaskStatus,
      position: row.position,
      goal: row.goal,
      filesAllowed: JSON.parse(row.filesAllowedJson) as string[],
      filesReference: JSON.parse(row.filesReferenceJson) as string[],
      acceptanceCriteria: JSON.parse(row.acceptanceCriteriaJson) as string[],
      verify: row.verify,
      needsSplit: Boolean(row.needsSplit),
      splitDepth: row.splitDepth,
      parentTaskId: row.parentTaskId,
      profileOverride: row.profileOverride,
      reviewRounds: row.reviewRounds,
      branchName: row.branchName ?? null,
      mergeCommitSha: row.mergeCommitSha ?? null,
      rejectionNote: row.rejectionNote ?? null,
      prUrl: row.prUrl ?? null,
      pushedAt: row.pushedAt ?? null,
      dependsOn: depsByTaskId.get(row.id) ?? [],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));

    return {
      id: planRow.id,
      projectId: planRow.projectId,
      briefId: planRow.briefId,
      version: planRow.version,
      status: planRow.status as 'draft' | 'approved',
      filePath: planRow.filePath,
      milestones,
      tasks: taskDtos,
      createdAt: planRow.createdAt,
      approvedAt: planRow.approvedAt,
    };
  }

  createTask(projectId: string, input: CreateTaskInput): TaskDTO {
    const plan = this.getPlan(projectId);
    if (!plan) throw new Error('No plan exists yet. Generate a plan from an approved brief first.');
    if (plan.status === 'approved') throw new Error('Plan is approved and locked.');

    this.assertMilestone(plan, input.milestone);

    const existingNums = new Set(plan.tasks.map((t) => t.externalId));
    const nextNum = this.findMaxTaskNumber(existingNums) + 1;
    const externalId = `T-${String(nextNum).padStart(3, '0')}`;

    const uuid = crypto.randomUUID();
    const now = new Date().toISOString();
    const position = plan.tasks.length;

    this.db
      .insert(tasks)
      .values({
        id: uuid,
        planId: plan.id,
        externalId,
        title: input.title,
        milestone: input.milestone,
        role: input.role,
        complexity: input.complexity,
        status: this.statusFor(input.needsSplit, input.status),
        position,
        goal: input.goal,
        filesAllowedJson: JSON.stringify(input.filesAllowed),
        filesReferenceJson: JSON.stringify(input.filesReference),
        acceptanceCriteriaJson: JSON.stringify(input.acceptanceCriteria),
        verify: input.verify,
        needsSplit: input.needsSplit,
        splitDepth: 0,
        parentTaskId: null,
        profileOverride: input.profileOverride ?? null,
        reviewRounds: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    this.replaceTaskDependencies(plan.id, uuid, externalId, input.dependsOn);
    this.syncPlanJsonFile(projectId, plan.id);
    this.events?.emitEvent({ type: 'plan.updated', projectId });

    return this.getPlan(projectId)!.tasks.find((t) => t.id === uuid)!;
  }

  updateTask(projectId: string, taskId: string, input: UpdateTaskInput): TaskDTO {
    const plan = this.getPlan(projectId);
    if (!plan) throw new Error('Plan not found');
    if (plan.status === 'approved') throw new Error('Plan is approved and locked.');

    const target = plan.tasks.find((t) => t.id === taskId || t.externalId === taskId);
    if (!target) throw new Error(`Task not found: ${taskId}`);

    if (input.milestone !== undefined) this.assertMilestone(plan, input.milestone);

    if (input.dependsOn !== undefined) {
      this.replaceTaskDependencies(plan.id, target.id, target.externalId, input.dependsOn);
    }

    const nextNeedsSplit = input.needsSplit ?? target.needsSplit;
    const nextStatus =
      input.needsSplit !== undefined || input.status !== undefined
        ? this.statusFor(nextNeedsSplit, input.status ?? (target.status as EditableTaskStatus))
        : undefined;

    const now = new Date().toISOString();
    this.db
      .update(tasks)
      .set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.milestone !== undefined ? { milestone: input.milestone } : {}),
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.complexity !== undefined ? { complexity: input.complexity } : {}),
        ...(nextStatus !== undefined ? { status: nextStatus } : {}),
        ...(input.goal !== undefined ? { goal: input.goal } : {}),
        ...(input.filesAllowed !== undefined
          ? { filesAllowedJson: JSON.stringify(input.filesAllowed) }
          : {}),
        ...(input.filesReference !== undefined
          ? { filesReferenceJson: JSON.stringify(input.filesReference) }
          : {}),
        ...(input.acceptanceCriteria !== undefined
          ? { acceptanceCriteriaJson: JSON.stringify(input.acceptanceCriteria) }
          : {}),
        ...(input.verify !== undefined ? { verify: input.verify } : {}),
        ...(input.needsSplit !== undefined ? { needsSplit: input.needsSplit } : {}),
        ...(input.profileOverride !== undefined ? { profileOverride: input.profileOverride } : {}),
        updatedAt: now,
      })
      .where(eq(tasks.id, target.id))
      .run();

    this.syncPlanJsonFile(projectId, plan.id);
    this.events?.emitEvent({ type: 'plan.updated', projectId });

    return this.getPlan(projectId)!.tasks.find((t) => t.id === target.id)!;
  }

  deleteTask(projectId: string, taskId: string): void {
    const plan = this.getPlan(projectId);
    if (!plan) throw new Error('Plan not found');
    if (plan.status === 'approved') throw new Error('Plan is approved and locked.');

    const target = plan.tasks.find((t) => t.id === taskId || t.externalId === taskId);
    if (!target) throw new Error(`Task not found: ${taskId}`);

    this.db.delete(tasks).where(eq(tasks.id, target.id)).run();
    this.syncPlanJsonFile(projectId, plan.id);
    this.events?.emitEvent({ type: 'plan.updated', projectId });
  }

  reorderTasks(projectId: string, input: ReorderTasksInput): PlanDTO {
    const plan = this.getPlan(projectId);
    if (!plan) throw new Error('Plan not found');
    if (plan.status === 'approved') throw new Error('Plan is approved and locked.');

    const now = new Date().toISOString();
    for (const upd of input.updates) {
      this.db
        .update(tasks)
        .set({
          position: upd.position,
          ...(upd.status
            ? { status: upd.status, needsSplit: upd.status === 'needs_split' }
            : {}),
          updatedAt: now,
        })
        .where(and(eq(tasks.id, upd.id), eq(tasks.planId, plan.id)))
        .run();
    }

    this.syncPlanJsonFile(projectId, plan.id);
    this.events?.emitEvent({ type: 'plan.updated', projectId });
    return this.getPlan(projectId)!;
  }

  approvePlan(projectId: string): PlanDTO {
    const plan = this.getPlan(projectId);
    if (!plan) throw new Error('Plan not found');
    if (plan.status === 'approved') return plan;

    const unsplit = plan.tasks.filter((t) => t.needsSplit);
    if (unsplit.length > 0) {
      throw new Error(
        `Split or clear the needs-split flag on ${unsplit.map((t) => t.externalId).join(', ')} before approving.`,
      );
    }
    if (plan.tasks.length === 0) throw new Error('The plan has no tasks to approve.');

    const now = new Date().toISOString();
    this.db
      .update(plans)
      .set({ status: 'approved', approvedAt: plan.approvedAt ?? now })
      .where(eq(plans.id, plan.id))
      .run();

    this.db
      .update(tasks)
      .set({ status: 'approved', updatedAt: now })
      .where(eq(tasks.planId, plan.id))
      .run();

    this.syncPlanJsonFile(projectId, plan.id);
    this.events?.emitEvent({ type: 'plan.updated', projectId });
    return this.getPlan(projectId)!;
  }

  /** `needs_split` is both a flag and a kanban column, so the two must never disagree. */
  private statusFor(needsSplit: boolean, requested: EditableTaskStatus): TaskStatus {
    if (needsSplit) return 'needs_split';
    return requested === 'needs_split' ? 'ready' : requested;
  }

  private assertMilestone(plan: PlanDTO, milestone: string): void {
    if (!plan.milestones.some((m) => m.id === milestone)) {
      throw new Error(
        `Unknown milestone "${milestone}". Use one of: ${plan.milestones.map((m) => m.id).join(', ')}.`,
      );
    }
  }

  private replaceTaskDependencies(
    planId: string,
    taskUuid: string,
    taskExternalId: string,
    dependsOnExternalIds: string[],
  ): void {
    const planTasks = this.db.select().from(tasks).where(eq(tasks.planId, planId)).all();
    const extToUuid = new Map(planTasks.map((t) => [t.externalId, t.id]));
    const uuidToExt = new Map(planTasks.map((t) => [t.id, t.externalId]));

    const validDeps = [...new Set(dependsOnExternalIds)].filter(
      (ext) => ext !== taskExternalId && extToUuid.has(ext),
    );

    const allDeps = this.db
      .select()
      .from(taskDependencies)
      .where(inArray(taskDependencies.taskId, planTasks.map((t) => t.id)))
      .all();
    const edgeMap = new Map<string, string[]>();
    for (const t of planTasks) edgeMap.set(t.externalId, []);
    for (const d of allDeps) {
      const src = uuidToExt.get(d.taskId);
      const dst = uuidToExt.get(d.dependsOnId);
      if (src && dst) {
        edgeMap.get(src)?.push(dst);
      }
    }

    if (hasDependencyCycle(edgeMap, taskExternalId, validDeps)) {
      throw new Error(`Circular dependency detected involving ${taskExternalId}`);
    }

    this.db.delete(taskDependencies).where(eq(taskDependencies.taskId, taskUuid)).run();
    for (const depExt of validDeps) {
      const depUuid = extToUuid.get(depExt);
      if (depUuid) {
        this.db
          .insert(taskDependencies)
          .values({ taskId: taskUuid, dependsOnId: depUuid })
          .onConflictDoNothing()
          .run();
      }
    }
  }

  private syncPlanJsonFile(projectId: string, planId: string): void {
    const project = this.getProjectRow(projectId);
    const plan = this.getPlan(projectId);
    if (!plan || plan.id !== planId) return;

    const briefRow = this.db.select().from(briefs).where(eq(briefs.id, plan.briefId)).get();
    const contract: PlanContract = {
      version: plan.version,
      brief_version: briefRow?.version ?? 1,
      milestones: plan.milestones,
      tasks: plan.tasks.map((t) => ({
        id: t.externalId,
        title: t.title,
        milestone: t.milestone,
        role: t.role,
        complexity: t.complexity,
        depends_on: t.dependsOn,
        goal: t.goal,
        files_allowed: t.filesAllowed,
        files_reference: t.filesReference,
        acceptance_criteria: t.acceptanceCriteria,
        verify: t.verify,
        needs_split: t.needsSplit,
      })),
    };

    writeArtifactFile(project.path, path.join(project.path, plan.filePath), JSON.stringify(contract, null, 2));
  }

  private readBriefRow(projectPath: string, row: typeof briefs.$inferSelect): BriefDTO {
    const absPath = path.join(projectPath, row.filePath);
    const raw = JSON.parse(readArtifactFile(projectPath, absPath)) as unknown;
    const content = BriefContentSchema.parse(raw);
    return {
      id: row.id,
      projectId: row.projectId,
      version: row.version,
      status: row.status as 'draft' | 'approved',
      filePath: row.filePath,
      content,
      createdAt: row.createdAt,
      approvedAt: row.approvedAt,
    };
  }

  private formatUserDiscussMessage(input: DiscussMessageInput): string {
    if (!input.answers || input.answers.length === 0) {
      return input.message.trim();
    }
    const lines = [input.message.trim(), '', 'Structured answers:'];
    for (const ans of input.answers) {
      const parts = [...ans.selectedOptions];
      if (ans.customText.trim()) parts.push(ans.customText.trim());
      lines.push(`- [${ans.questionId}] ${ans.question}: ${parts.join(', ') || '(skipped)'}`);
    }
    return lines.join('\n');
  }
}
