import crypto from 'node:crypto';
import fs from 'node:fs';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  TaskResearchContractSchema,
  type ContextNoteInput,
  type ProviderId,
  type ReviewFinding,
  type SessionContextItemDTO,
  type SessionContextItemKind,
  type TaskComplexity,
  type TaskDTO,
  type TaskHandoffDTO,
  type TaskHandoffTrigger,
  type TaskOutputKind,
  type TaskResearchDTO,
  type TaskResultContract,
} from '@dalang/shared';
import type { DalangDb } from '../db/client.js';
import { sessionContextItems, taskHandoffs } from '../db/schema.js';
import { readArtifactFile } from '../safe-fs.js';

/**
 * Stated prompt size budgets for v0.15.1 (C1–C3).
 * Every executor prompt stays strictly within EXECUTOR_PROMPT_MAX_CHARS.
 */
export const EXECUTOR_PROMPT_MAX_CHARS = 24_000;
export const SESSION_CONTEXT_MAX_CHARS = 3_000;
export const HANDOFF_CONTEXT_MAX_CHARS = 2_500;
export const RESEARCH_REVIEW_MAX_CHARS = 2_000;

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'before', 'between', 'build', 'check', 'code',
  'create', 'each', 'file', 'files', 'from', 'have', 'into', 'just', 'make', 'more',
  'must', 'need', 'only', 'other', 'over', 'should', 'some', 'such', 'task', 'tasks',
  'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through',
  'under', 'update', 'using', 'when', 'where', 'which', 'while', 'with', 'without', 'work',
]);

function normalizePath(p: string): string {
  return p.trim().replace(/^\.\//, '').replace(/\\/g, '/').replace(/\/+$/, '');
}

function simpleGlobToRegex(pattern: string): RegExp {
  const normalized = normalizePath(pattern);
  let regexStr = '^';
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        if (normalized[i + 2] === '/') {
          regexStr += '(?:.*/)?';
          i += 2;
        } else {
          regexStr += '.*';
          i += 1;
        }
      } else {
        regexStr += '[^/]*';
      }
    } else if (ch === '?') {
      regexStr += '[^/]';
    } else {
      regexStr += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  regexStr += '$';
  return new RegExp(regexStr);
}

function filesOverlap(itemFiles: readonly string[], taskPatterns: readonly string[]): number {
  if (itemFiles.length === 0 || taskPatterns.length === 0) return 0;
  const normTask = taskPatterns.map(normalizePath).filter(Boolean);
  const taskRegexes = normTask.map(simpleGlobToRegex);
  let matches = 0;
  for (const rawFile of itemFiles) {
    const file = normalizePath(rawFile);
    if (!file) continue;
    const matched = normTask.some((pat, idx) => {
      if (pat === file) return true;
      if (taskRegexes[idx].test(file)) return true;
      if (file.includes('*') && simpleGlobToRegex(file).test(pat)) return true;
      // Same directory prefix overlap for concrete files
      const fileDir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
      const patDir = pat.includes('/') && !pat.includes('*') ? pat.slice(0, pat.lastIndexOf('/')) : '';
      return Boolean(fileDir && patDir && fileDir === patDir);
    });
    if (matched) matches += 1;
  }
  return matches;
}

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  const matches = text.toLowerCase().match(/[a-z0-9_-]{4,}/g) ?? [];
  for (const token of matches) {
    if (!STOP_WORDS.has(token)) out.add(token);
  }
  return out;
}

function parseJsonStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function toSessionContextDTO(row: typeof sessionContextItems.$inferSelect): SessionContextItemDTO {
  return {
    id: row.id,
    projectId: row.projectId,
    sessionId: row.sessionId,
    taskId: row.taskId ?? null,
    taskExternalId: row.taskExternalId ?? null,
    runId: row.runId ?? null,
    kind: (row.kind === 'finding' ? 'finding' : 'decision') as SessionContextItemKind,
    summary: row.summary,
    rationale: row.rationale ?? null,
    files: parseJsonStringArray(row.filesJson),
    createdAt: row.createdAt,
  };
}

function toTaskHandoffDTO(row: typeof taskHandoffs.$inferSelect): TaskHandoffDTO {
  return {
    id: row.id,
    projectId: row.projectId,
    sessionId: row.sessionId ?? null,
    taskId: row.taskId,
    runId: row.runId ?? null,
    trigger: row.trigger as TaskHandoffTrigger,
    provider: row.provider as ProviderId,
    model: row.model ?? null,
    whatDone: row.whatDone,
    whatLeft: row.whatLeft,
    why: row.why,
    changedFiles: parseJsonStringArray(row.changedFilesJson),
    createdAt: row.createdAt,
  };
}

// ─── C1: Shared Decisions & Findings ─────────────────────────────────────────

export function normalizeContextNotes(
  items: readonly ContextNoteInput[] | undefined,
  defaultFiles: readonly string[],
): Array<{ summary: string; rationale: string | null; files: string[] }> {
  if (!items || items.length === 0) return [];
  const fallbackFiles = [...new Set(defaultFiles.map(normalizePath).filter((f) => f && !f.startsWith('.dalang/')))];
  const normalized: Array<{ summary: string; rationale: string | null; files: string[] }> = [];
  for (const item of items) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (!trimmed) continue;
      normalized.push({
        summary: trimmed.slice(0, 400),
        rationale: null,
        files: fallbackFiles.slice(0, 12),
      });
    } else if (item && typeof item === 'object') {
      const summary = item.summary.trim().slice(0, 400);
      if (!summary) continue;
      const rationaleRaw = (item.why ?? item.detail ?? '').trim();
      const files = item.files && item.files.length > 0
        ? [...new Set(item.files.map(normalizePath).filter((f) => f && !f.startsWith('.dalang/')))].slice(0, 12)
        : fallbackFiles.slice(0, 12);
      normalized.push({
        summary,
        rationale: rationaleRaw ? rationaleRaw.slice(0, 400) : null,
        files,
      });
    }
  }
  return normalized;
}

export function recordSessionContextFromResult(
  db: DalangDb,
  opts: {
    projectId: string;
    sessionId: string;
    taskId: string;
    taskExternalId: string;
    runId: string;
    result: TaskResultContract;
    changedFiles: readonly string[];
  },
): SessionContextItemDTO[] {
  const defaultFiles = opts.changedFiles.length > 0 ? opts.changedFiles : opts.result.changed_files;
  const decisions = normalizeContextNotes(opts.result.decisions, defaultFiles).map((item) => ({
    kind: 'decision' as const,
    ...item,
  }));
  const findings = normalizeContextNotes(opts.result.findings, defaultFiles).map((item) => ({
    kind: 'finding' as const,
    ...item,
  }));
  const allEntries = [...decisions, ...findings];
  if (allEntries.length === 0) return [];

  const existing = db
    .select({ kind: sessionContextItems.kind, summary: sessionContextItems.summary })
    .from(sessionContextItems)
    .where(eq(sessionContextItems.sessionId, opts.sessionId))
    .all();
  const seenKeys = new Set(existing.map((e) => `${e.kind}:${e.summary.trim().toLowerCase()}`));

  const inserted: SessionContextItemDTO[] = [];
  const baseTime = Date.now();
  let offset = 0;

  for (const entry of allEntries) {
    const key = `${entry.kind}:${entry.summary.trim().toLowerCase()}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const id = crypto.randomUUID();
    const createdAt = new Date(baseTime + offset++).toISOString();
    const row = {
      id,
      projectId: opts.projectId,
      sessionId: opts.sessionId,
      taskId: opts.taskId,
      taskExternalId: opts.taskExternalId,
      runId: opts.runId,
      kind: entry.kind,
      summary: entry.summary,
      rationale: entry.rationale,
      filesJson: JSON.stringify(entry.files),
      createdAt,
    };
    db.insert(sessionContextItems).values(row).run();
    inserted.push(toSessionContextDTO(row));
  }

  return inserted;
}

export function listSessionContextItems(db: DalangDb, sessionId: string): SessionContextItemDTO[] {
  const rows = db
    .select()
    .from(sessionContextItems)
    .where(eq(sessionContextItems.sessionId, sessionId))
    .orderBy(desc(sessionContextItems.createdAt))
    .all();
  return rows.map(toSessionContextDTO);
}

export function deleteSessionContextItem(db: DalangDb, sessionId: string, itemId: string): boolean {
  const existing = db
    .select({ id: sessionContextItems.id })
    .from(sessionContextItems)
    .where(and(eq(sessionContextItems.sessionId, sessionId), eq(sessionContextItems.id, itemId)))
    .get();
  if (!existing) return false;
  db.delete(sessionContextItems)
    .where(and(eq(sessionContextItems.sessionId, sessionId), eq(sessionContextItems.id, itemId)))
    .run();
  return true;
}

export function selectRelevantSessionContext(
  items: readonly SessionContextItemDTO[],
  task: Pick<
    TaskDTO,
    'id' | 'externalId' | 'title' | 'goal' | 'filesAllowed' | 'filesReference' | 'acceptanceCriteria' | 'dependsOn'
  >,
  maxChars: number = SESSION_CONTEXT_MAX_CHARS,
): { selected: SessionContextItemDTO[]; formattedBlock: string } {
  if (items.length === 0 || maxChars <= 0) {
    return { selected: [], formattedBlock: '' };
  }

  const taskPatterns = [...task.filesAllowed, ...task.filesReference];
  const taskTokens = tokenize(
    [task.title, task.goal, ...task.acceptanceCriteria].join(' '),
  );
  const depSet = new Set(task.dependsOn ?? []);

  const scored: Array<{ item: SessionContextItemDTO; score: number }> = [];
  for (const item of items) {
    if (item.taskId && item.taskId === task.id) continue;
    let score = 0;
    score += filesOverlap(item.files, taskPatterns) * 10;
    if (item.taskExternalId && depSet.has(item.taskExternalId)) {
      score += 5;
    }
    const itemTokens = tokenize(`${item.summary} ${item.rationale ?? ''}`);
    let tokenMatches = 0;
    for (const tok of itemTokens) {
      if (taskTokens.has(tok)) tokenMatches += 1;
    }
    score += tokenMatches * 2;
    if (score > 0) {
      scored.push({ item, score });
    }
  }

  if (scored.length === 0) {
    return { selected: [], formattedBlock: '' };
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.item.createdAt.localeCompare(a.item.createdAt);
  });

  const header = 'Shared decisions and findings from earlier tasks in this session (stay consistent unless the goal requires changing them):';
  const lines: string[] = [header];
  let totalLen = header.length;
  const selected: SessionContextItemDTO[] = [];

  for (const { item } of scored) {
    const tag = item.kind === 'decision' ? 'DECISION' : 'FINDING';
    const src = item.taskExternalId ? `[${item.taskExternalId}] ` : '';
    const why = item.rationale ? ` — ${item.rationale}` : '';
    const filesPart = item.files.length > 0 ? ` (files: ${item.files.slice(0, 4).join(', ')})` : '';
    let line = `- [${tag}] ${src}${item.summary}${why}${filesPart}`;
    if (line.length > 420) {
      line = `${line.slice(0, 417)}...`;
    }
    if (totalLen + 1 + line.length > maxChars) {
      break;
    }
    lines.push(line);
    totalLen += 1 + line.length;
    selected.push(item);
  }

  if (selected.length === 0) {
    return { selected: [], formattedBlock: '' };
  }
  return { selected, formattedBlock: lines.join('\n') };
}

// ─── C2: Research Before Editing (Medium & High Tasks) ───────────────────────

export function requiresPreEditResearch(task: Pick<TaskDTO, 'complexity' | 'output'>): boolean {
  return task.complexity === 'medium' || task.complexity === 'high';
}

export function buildPreEditResearchInstruction(relResearchPath: string, isAnswer: boolean): string {
  return [
    `Pre-edit research (required before ${isAnswer ? 'writing your answer' : 'editing project files'}):`,
    `- First inspect the relevant files once and write a concise JSON research note to "${relResearchPath}" (and optionally include it under "research" in result.json) with:`,
    `  { "understanding": "<what the existing code does and what you will change>", "files_to_change": ["<relative paths>"], "edge_cases": ["<edge cases, callers, and error paths>"] }`,
    `- Keep it focused so you do not re-read the same files repeatedly. DALANG stores this research with the run and shares it with the reviewer.`,
  ].join('\n');
}

export function extractOrSynthesizeTaskResearch(opts: {
  worktreePath: string;
  absResearchPath: string;
  task: Pick<TaskDTO, 'complexity' | 'output' | 'title' | 'goal'>;
  result: TaskResultContract | null;
  changedFiles: readonly string[];
}): TaskResearchDTO | null {
  const now = new Date().toISOString();

  // 1. Prefer explicit research.json written before editing.
  if (fs.existsSync(opts.absResearchPath)) {
    try {
      const raw = readArtifactFile(opts.worktreePath, opts.absResearchPath).trim();
      if (raw) {
        const parsed = TaskResearchContractSchema.safeParse(JSON.parse(raw));
        if (parsed.success) {
          return {
            understanding: parsed.data.understanding,
            filesToChange: parsed.data.files_to_change,
            edgeCases: parsed.data.edge_cases,
            recordedAt: now,
            source: 'executor',
            warning: null,
          };
        }
      }
    } catch {
      // Fall through to result.json.research or synthesized fallback.
    }
  }

  // 2. Fallback to research embedded in result.json.
  if (opts.result?.research) {
    return {
      understanding: opts.result.research.understanding,
      filesToChange: opts.result.research.files_to_change,
      edgeCases: opts.result.research.edge_cases,
      recordedAt: now,
      source: 'executor',
      warning: null,
    };
  }

  // 3. Only medium/high tasks require pre-edit research.
  if (!requiresPreEditResearch(opts.task)) {
    return null;
  }

  // DALANG enforces visibility even when the executor skipped writing research.json.
  const files = opts.changedFiles.filter((f) => !f.startsWith('.dalang/'));
  return {
    understanding: opts.result?.summary?.trim() || opts.task.title,
    filesToChange: files,
    edgeCases: [],
    recordedAt: now,
    source: 'synthesized',
    warning: 'Executor did not write a pre-edit research note before editing.',
  };
}

export function parseStoredTaskResearch(raw: string | null | undefined): TaskResearchDTO | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TaskResearchDTO>;
    if (typeof parsed.understanding !== 'string' || !parsed.understanding.trim()) return null;
    return {
      understanding: parsed.understanding,
      filesToChange: Array.isArray(parsed.filesToChange)
        ? parsed.filesToChange.filter((v): v is string => typeof v === 'string')
        : [],
      edgeCases: Array.isArray(parsed.edgeCases)
        ? parsed.edgeCases.filter((v): v is string => typeof v === 'string')
        : [],
      recordedAt: typeof parsed.recordedAt === 'string' ? parsed.recordedAt : '',
      source: parsed.source === 'synthesized' ? 'synthesized' : 'executor',
      warning: typeof parsed.warning === 'string' ? parsed.warning : null,
    };
  } catch {
    return null;
  }
}

export function formatResearchForReview(
  research: TaskResearchDTO | null | undefined,
  maxChars: number = RESEARCH_REVIEW_MAX_CHARS,
): string {
  if (!research) return '';
  const lines = [
    `Executor pre-edit research (${research.source === 'executor' ? 'written before editing' : 'synthesized — executor skipped research.json'}):`,
    `Understanding: ${research.understanding}`,
    research.filesToChange.length > 0 ? `Planned files: ${research.filesToChange.join(', ')}` : '',
    research.edgeCases.length > 0
      ? `Edge cases considered:\n${research.edgeCases.map((e) => `- ${e}`).join('\n')}`
      : '',
    research.warning ? `Note: ${research.warning}` : '',
  ].filter(Boolean);
  const full = lines.join('\n');
  if (full.length <= maxChars) return full;
  return `${full.slice(0, Math.max(0, maxChars - 20))}\n... [truncated]`;
}

// ─── C3: Handoff Notes ───────────────────────────────────────────────────────

export function recordTaskHandoff(
  db: DalangDb,
  opts: {
    projectId: string;
    sessionId: string | null;
    taskId: string;
    runId: string | null;
    trigger: TaskHandoffTrigger;
    provider: ProviderId;
    model?: string | null;
    result?: TaskResultContract | null;
    changedFiles?: readonly string[];
    failureReason?: string | null;
    openFindings?: readonly ReviewFinding[];
  },
): TaskHandoffDTO {
  const files = [
    ...new Set(
      (opts.changedFiles && opts.changedFiles.length > 0
        ? opts.changedFiles
        : opts.result?.changed_files ?? []
      )
        .map(normalizePath)
        .filter((f) => f && !f.startsWith('.dalang/')),
    ),
  ].slice(0, 25);

  const explicit = opts.result?.handoff;
  const whatDone =
    explicit?.what_done?.trim() ||
    opts.result?.summary?.trim() ||
    (files.length > 0
      ? `Partial edits on ${files.slice(0, 6).join(', ')}${files.length > 6 ? ` (+${files.length - 6} more)` : ''}.`
      : 'No completed file edits recorded before the run ended.');

  const findingLines = (opts.openFindings ?? [])
    .slice(0, 5)
    .map((f) => `[${f.severity}] ${f.file ? `${f.file}: ` : ''}${f.note}`);
  const blockerLines = (opts.result?.blockers ?? []).slice(0, 5);
  const whatLeft =
    explicit?.what_left?.trim() ||
    (findingLines.length > 0
      ? `Resolve open review findings: ${findingLines.join(' | ')}`
      : blockerLines.length > 0
        ? `Unblock and finish: ${blockerLines.join('; ')}`
        : opts.trigger === 'fix_round'
          ? 'Re-verify changes and confirm all review findings are resolved.'
          : 'Finish remaining acceptance criteria, run verify, and write result.json.');

  const defaultWhyByTrigger: Record<TaskHandoffTrigger, string> = {
    stopped: 'Run stopped before completion.',
    failed: 'Executor run failed before completion.',
    fix_round: 'Fix round ended and handed back for verification/review.',
    review_failed: 'Review failed and stopped at the merge gate.',
    provider_switch: 'Primary provider failed; handing off to backup provider.',
    restart: 'DALANG server restarted while the task was running.',
  };
  const why =
    explicit?.why?.trim() ||
    opts.failureReason?.trim() ||
    defaultWhyByTrigger[opts.trigger];

  const row = {
    id: crypto.randomUUID(),
    projectId: opts.projectId,
    sessionId: opts.sessionId,
    taskId: opts.taskId,
    runId: opts.runId,
    trigger: opts.trigger,
    provider: opts.provider,
    model: opts.model ?? null,
    whatDone: whatDone.slice(0, 1200),
    whatLeft: whatLeft.slice(0, 1200),
    why: why.slice(0, 1200),
    changedFilesJson: JSON.stringify(files),
    createdAt: new Date().toISOString(),
  };

  db.insert(taskHandoffs).values(row).run();
  return toTaskHandoffDTO(row);
}

export function listTaskHandoffs(db: DalangDb, taskId: string, limit: number = 10): TaskHandoffDTO[] {
  const rows = db
    .select()
    .from(taskHandoffs)
    .where(eq(taskHandoffs.taskId, taskId))
    .orderBy(desc(taskHandoffs.createdAt))
    .limit(limit)
    .all();
  return rows.map(toTaskHandoffDTO);
}

export function getLatestTaskHandoff(db: DalangDb, taskId: string): TaskHandoffDTO | null {
  const row = db
    .select()
    .from(taskHandoffs)
    .where(eq(taskHandoffs.taskId, taskId))
    .orderBy(desc(taskHandoffs.createdAt))
    .limit(1)
    .get();
  return row ? toTaskHandoffDTO(row) : null;
}

export function getLatestTaskHandoffsMap(db: DalangDb, taskIds: readonly string[]): Map<string, TaskHandoffDTO> {
  const map = new Map<string, TaskHandoffDTO>();
  if (taskIds.length === 0) return map;
  const rows = db
    .select()
    .from(taskHandoffs)
    .where(inArray(taskHandoffs.taskId, [...taskIds]))
    .orderBy(desc(taskHandoffs.createdAt))
    .all();
  for (const row of rows) {
    if (!map.has(row.taskId)) {
      map.set(row.taskId, toTaskHandoffDTO(row));
    }
  }
  return map;
}

export function formatHandoffsForPrompt(
  handoffs: readonly TaskHandoffDTO[],
  maxChars: number = HANDOFF_CONTEXT_MAX_CHARS,
): string {
  if (handoffs.length === 0 || maxChars <= 0) return '';
  const header = 'Handoff notes from previous attempt(s) on this task (use this to continue without repeating completed work):';
  const blocks: string[] = [header];
  let totalLen = header.length;

  for (const h of handoffs.slice(0, 3)) {
    const providerLabel = h.model ? `${h.provider} · ${h.model}` : h.provider;
    const filesLine = h.changedFiles.length > 0 ? `\n  Changed files: ${h.changedFiles.slice(0, 8).join(', ')}` : '';
    let entry = [
      `- [${h.trigger}] (${providerLabel}):`,
      `  Done: ${h.whatDone}`,
      `  Left: ${h.whatLeft}`,
      `  Why: ${h.why}${filesLine}`,
    ].join('\n');
    if (entry.length > maxChars - totalLen - 1) {
      const remaining = maxChars - totalLen - 20;
      if (remaining < 120) break;
      entry = `${entry.slice(0, remaining)}...`;
    }
    blocks.push(entry);
    totalLen += 1 + entry.length;
  }

  return blocks.length > 1 ? blocks.join('\n') : '';
}

// ─── Stated Executor Prompt Size Limit Enforcement ───────────────────────────

/**
 * Guarantees every executor prompt stays strictly within `maxChars` while
 * preserving the opening task framing and the closing JSON schema / task_id footer.
 */
export function enforceExecutorPromptLimit(
  prompt: string,
  maxChars: number = EXECUTOR_PROMPT_MAX_CHARS,
): string {
  if (prompt.length <= maxChars) return prompt;
  const marker = `\n\n... [prompt middle truncated to stay within ${maxChars} char limit] ...\n\n`;
  if (maxChars <= marker.length + 64) {
    return prompt.slice(0, maxChars);
  }
  const available = maxChars - marker.length;
  // Preserve up to 4,500 chars of the tail (JSON Schema + task_id instructions) and the rest from the head.
  const tailBudget = Math.min(4_500, Math.floor(available * 0.35));
  const headBudget = available - tailBudget;
  return `${prompt.slice(0, headBudget)}${marker}${prompt.slice(prompt.length - tailBudget)}`;
}
