import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  ReviewContractSchema,
  type AgentProfileDTO,
  type ReviewContract,
  type TaskDTO,
  type TaskResultContract,
} from '@dalang/shared';
import type { AdapterTurnResult } from '../adapters/types.js';
import { readArtifactFile } from '../safe-fs.js';
import { formatZodError } from './contract.js';
import { readFileFromGitCommit } from './git.js';

const MAX_VERIFY_OUTPUT_CHARS = 6_000;
const MAX_DIFF_PROMPT_CHARS = 14_000;

export async function readArtifactWithGitFallback(
  projectPath: string,
  relPath: string,
  commitSha?: string | null,
): Promise<string | null> {
  const absPath = path.join(projectPath, relPath);
  if (fs.existsSync(absPath)) {
    try {
      return readArtifactFile(projectPath, absPath);
    } catch {
      // Fall back to git object store if file on disk is missing or unreadable.
    }
  }
  if (commitSha) {
    return readFileFromGitCommit(projectPath, commitSha, relPath);
  }
  return null;
}

export function tailOutput(text: string, limit: number = MAX_VERIFY_OUTPUT_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `... [truncated]\n${trimmed.slice(trimmed.length - limit)}`;
}

/**
 * Extract JSON from a read-only agent's final response when it cannot write files to disk.
 */
export function extractJsonCandidate(turn: AdapterTurnResult): unknown | undefined {
  if (turn.structuredOutput !== undefined) {
    return turn.structuredOutput;
  }
  const text = turn.text.trim();
  if (!text) return undefined;

  try {
    return JSON.parse(text);
  } catch {
    // Try fenced JSON block or outermost JSON object.
  }

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // Continue to brace scan.
    }
  }

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function validateReviewTurnOutput(opts: {
  projectPath: string;
  expectedTaskId: string;
  verifyExitCode: number;
  turn: AdapterTurnResult;
}): { ok: true; data: ReviewContract } | { ok: false; error: string } {
  // Reviews are read-only, so the verdict comes from the reply only: the verify command runs agent-written
  // code with write access and could plant a review.json on disk.
  const parsed = extractJsonCandidate(opts.turn);
  if (parsed === undefined) {
    return { ok: false, error: 'Reviewer did not return valid JSON matching ReviewContractSchema.' };
  }

  const validated = ReviewContractSchema.safeParse(parsed);
  if (!validated.success) {
    return { ok: false, error: `Zod validation error: ${formatZodError(validated.error)}` };
  }
  if (validated.data.task_id !== opts.expectedTaskId) {
    return {
      ok: false,
      error: `Review task_id "${validated.data.task_id}" does not match expected "${opts.expectedTaskId}".`,
    };
  }
  if (opts.verifyExitCode !== 0 && validated.data.status === 'pass') {
    return {
      ok: false,
      error: `The verify command exited with ${opts.verifyExitCode}, so review status must be "fail" with findings.`,
    };
  }

  return {
    ok: true,
    data: {
      ...validated.data,
      verify_exit_code: opts.verifyExitCode,
    },
  };
}

export function buildReviewPrompt(opts: {
  task: TaskDTO;
  profile: AgentProfileDTO;
  relReviewPath: string;
  round: number;
  maxRounds: number;
  verifyExitCode: number;
  verifyOutput: string;
  changedFiles: string[];
  scopeWarnings: string[];
  rawDiff: string;
  coderResult: TaskResultContract | null;
}): string {
  const jsonSchema = z.toJSONSchema(ReviewContractSchema);
  const isReadOnly = opts.profile.permissionMode === 'read-only';
  const diffSnippet =
    opts.rawDiff.length > MAX_DIFF_PROMPT_CHARS
      ? `${opts.rawDiff.slice(0, MAX_DIFF_PROMPT_CHARS)}\n\n... [diff truncated for prompt; inspect repository files directly if needed]`
      : opts.rawDiff;

  return [
    `You are performing code review round ${opts.round} of ${opts.maxRounds} for task ${opts.task.externalId}: "${opts.task.title}".`,
    opts.profile.rolePrompt ? `Role instructions: ${opts.profile.rolePrompt}` : '',
    isReadOnly
      ? `Permission mode: READ-ONLY. Do NOT modify or create any files in the repository.`
      : `Do not modify application source files; only write the review output.`,
    ``,
    `Task Goal:`,
    opts.task.goal,
    ``,
    `Allowed files (files_allowed):`,
    opts.task.filesAllowed.length > 0 ? opts.task.filesAllowed.map((f) => `- ${f}`).join('\n') : '- (project workspace)',
    ``,
    `Acceptance criteria:`,
    opts.task.acceptanceCriteria.map((c) => `- ${c}`).join('\n'),
    ``,
    `Verify command executed by DALANG:`,
    `Command: ${opts.task.verify}`,
    `Exit code: ${opts.verifyExitCode}`,
    `Verify output:`,
    opts.verifyOutput || '(no output)',
    ``,
    `Changed files (${opts.changedFiles.length}):`,
    opts.changedFiles.length > 0 ? opts.changedFiles.map((f) => `- ${f}`).join('\n') : '- (none)',
    ``,
    `Scope violations against files_allowed:`,
    opts.scopeWarnings.length > 0 ? opts.scopeWarnings.map((w) => `- ${w}`).join('\n') : '- None',
    ``,
    opts.coderResult ? `Coder result summary:\n${opts.coderResult.summary}` : '',
    ``,
    `Unified diff:`,
    diffSnippet || '(empty diff)',
    ``,
    `Review requirements:`,
    `- Verify every acceptance criterion against the diff and repository files.`,
    `- If verify exit code is non-zero, status MUST be "fail".`,
    `- If files were modified outside files_allowed without justification, record a finding and fail.`,
    `- Record concrete, actionable findings with severity ("critical" | "major" | "minor" | "info"), file path, and note.`,
    ``,
    isReadOnly
      ? `Output ONLY a single valid JSON object in your final response (no prose outside the JSON) matching this JSON Schema:`
      : `Write a valid JSON file directly to "${opts.relReviewPath}" matching this JSON Schema:`,
    JSON.stringify(jsonSchema, null, 2),
    ``,
    `Set "task_id" to "${opts.task.externalId}", "verify_exit_code" to ${opts.verifyExitCode}, and "status" to "pass" or "fail".`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildFixPrompt(opts: {
  task: TaskDTO;
  profile: AgentProfileDTO;
  relResultPath: string;
  round: number;
  review: ReviewContract;
  verifyOutput: string;
  scopeWarnings: string[];
}): string {
  const jsonSchema = z.toJSONSchema(
    z.object({
      task_id: z.string(),
      status: z.enum(['completed', 'blocked', 'failed']),
      changed_files: z.array(z.string()),
      summary: z.string(),
      notes: z.array(z.string()),
      blockers: z.array(z.string()),
      verify_command: z.string().optional(),
      verify_exit_code: z.number().int().nullable().optional(),
    }),
  );

  const findingsText =
    opts.review.findings.length > 0
      ? opts.review.findings
          .map((f) => `- [${f.severity}] ${f.file ? `${f.file}: ` : ''}${f.note}`)
          .join('\n')
      : '- (no structured findings listed; check verify output below)';

  return [
    `Review round ${opts.round} FAILED for task ${opts.task.externalId}: "${opts.task.title}". Fix the issues and re-verify.`,
    opts.profile.rolePrompt ? `Role instructions: ${opts.profile.rolePrompt}` : '',
    ``,
    `Review findings to resolve:`,
    findingsText,
    ``,
    opts.scopeWarnings.length > 0
      ? `Scope warnings (revert or justify edits outside files_allowed):\n${opts.scopeWarnings.map((w) => `- ${w}`).join('\n')}\n`
      : '',
    `Last verify command (${opts.task.verify}) exited with ${opts.review.verify_exit_code}:`,
    opts.verifyOutput || '(no output)',
    ``,
    `Allowed files:`,
    opts.task.filesAllowed.length > 0 ? opts.task.filesAllowed.map((f) => `- ${f}`).join('\n') : '- (project workspace)',
    ``,
    `Run "${opts.task.verify}" after fixing, then write the updated result JSON to "${opts.relResultPath}" matching:`,
    JSON.stringify(jsonSchema, null, 2),
    `Set "task_id" to "${opts.task.externalId}".`,
  ]
    .filter(Boolean)
    .join('\n');
}
