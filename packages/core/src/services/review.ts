import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  ReviewContractSchema,
  type AgentProfileDTO,
  type ReviewContract,
  type TaskDTO,
  type TaskResultContract,
  type UiLanguage,
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
  verifyExitCode: number | null;
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
  if (opts.verifyExitCode !== null && opts.verifyExitCode !== 0 && validated.data.status === 'pass') {
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

/**
 * What the reviewer checks, given to the executor of a medium or high task and of every fix round (B25, P1). In the v0.15 run 13 of 16
 * tasks failed their first review, and each fix round cost another executor run and review.
 */
export function selfReviewBlock(isAnswer: boolean): string {
  return [
    `Before you write the result, review your own work as the independent reviewer will. It fails the task for any unmet acceptance criterion and for any critical or major defect:`,
    `- Check each acceptance criterion against your actual ${isAnswer ? 'answer' : 'changes'}, one by one, not against your plan.`,
    isAnswer
      ? `- Check facts, references, and every part of the question the goal asks about.`
      : `- Check edge cases and error paths (empty, missing, invalid, boundary values, concurrency or restarts where they apply), callers of what you changed, and that new behaviour has tests that would fail without your change.`,
    `- Fix what you find now. The reviewer gives no credit for intent.`,
  ].join('\n');
}

export function buildReviewPrompt(opts: {
  task: TaskDTO;
  profile: AgentProfileDTO;
  relReviewPath: string;
  round: number;
  maxRounds: number;
  verifyExitCode: number | null;
  verifyOutput: string;
  changedFiles: string[];
  scopeWarnings: string[];
  rawDiff: string;
  answerContent?: string | null;
  relAnswerPath?: string | null;
  coderResult: TaskResultContract | null;
  language?: UiLanguage;
}): string {
  const jsonSchema = z.toJSONSchema(ReviewContractSchema);
  const isReadOnly = opts.profile.permissionMode === 'read-only';
  const isAnswer = opts.task.output === 'answer';
  const hasVerify = Boolean(opts.task.verify?.trim());
  const diffSnippet =
    opts.rawDiff.length > MAX_DIFF_PROMPT_CHARS
      ? `${opts.rawDiff.slice(0, MAX_DIFF_PROMPT_CHARS)}\n\n... [diff truncated for prompt; inspect repository files directly if needed]`
      : opts.rawDiff;
  const answerText = opts.answerContent ?? '';
  const answerSnippet =
    answerText.length > MAX_DIFF_PROMPT_CHARS
      ? `${answerText.slice(0, MAX_DIFF_PROMPT_CHARS)}\n\n... [answer truncated for prompt; inspect ${opts.relAnswerPath ?? 'answer.md'} directly if needed]`
      : answerText;
  const languageLine =
    opts.language === 'id'
      ? `Language: Write the review "summary" and each finding "note" in clear, natural Indonesian (Bahasa Indonesia). Keep JSON keys, enum values ("pass", "fail", severities), file paths, and code identifiers in English.`
      : `Language: Write the review "summary" and each finding "note" in clear English. Keep JSON keys, enum values, file paths, and code identifiers in English.`;

  const openingLine = isAnswer
    ? `You are performing review round ${opts.round} of ${opts.maxRounds} for answer task ${opts.task.externalId}: "${opts.task.title}".`
    : hasVerify
      ? `You are performing code review round ${opts.round} of ${opts.maxRounds} for task ${opts.task.externalId}: "${opts.task.title}".`
      : `You are performing review round ${opts.round} of ${opts.maxRounds} for task ${opts.task.externalId}: "${opts.task.title}".`;

  const verifyBlock = hasVerify
    ? [
        `Verify command executed by DALANG:`,
        `Command: ${opts.task.verify}`,
        `Exit code: ${opts.verifyExitCode}`,
        `Verify output:`,
        opts.verifyOutput || '(no output)',
      ].join('\n')
    : `Verify step: skipped (no verify command configured for this task). Judge every acceptance criterion directly from the result and project files.`;

  const scopeBlock = isAnswer
    ? [
        `Task output kind: answer.`,
        `This task must leave all project files unchanged and write its answer to "${opts.relAnswerPath ?? '.dalang/tasks/' + opts.task.externalId + '/answer.md'}".`,
        `DALANG orchestration files under ".dalang/" (including result.json and answer.md) are expected and not scope violations.`,
      ].join('\n')
    : [
        `Allowed files (files_allowed):`,
        opts.task.filesAllowed.length > 0 ? opts.task.filesAllowed.map((f) => `- ${f}`).join('\n') : '- (project workspace)',
        `DALANG requires the executor to write "${opts.relReviewPath.replace(/review\.json$/, 'result.json')}" as orchestration metadata, even when the task says only one project file may change. This required result file is not a scope violation. Do not ask the executor to remove it. Other changes outside files_allowed still require justification.`,
      ].join('\n');

  const workArtifactBlock = isAnswer
    ? [
        `Answer content (${opts.relAnswerPath ?? 'answer.md'}):`,
        answerSnippet || '(empty answer)',
      ].join('\n')
    : [
        `Unified diff:`,
        diffSnippet || '(empty diff)',
      ].join('\n');

  const verifyExitLiteral = opts.verifyExitCode === null ? 'null' : String(opts.verifyExitCode);

  return [
    openingLine,
    languageLine,
    opts.profile.rolePrompt ? `Role instructions: ${opts.profile.rolePrompt}` : '',
    isReadOnly
      ? `Permission mode: READ-ONLY. Do NOT modify or create any files in the project.`
      : `Do not modify project files; only write the review output.`,
    ``,
    `Task Goal:`,
    opts.task.goal,
    ``,
    scopeBlock,
    ``,
    `Acceptance criteria:`,
    opts.task.acceptanceCriteria.map((c) => `- ${c}`).join('\n'),
    ``,
    verifyBlock,
    ``,
    `Changed project files (${opts.changedFiles.length}):`,
    opts.changedFiles.length > 0 ? opts.changedFiles.map((f) => `- ${f}`).join('\n') : '- (none)',
    ``,
    isAnswer ? `Scope violations (project files modified by an answer task):` : `Scope violations against files_allowed:`,
    opts.scopeWarnings.length > 0 ? opts.scopeWarnings.map((w) => `- ${w}`).join('\n') : '- None',
    ``,
    opts.coderResult ? `Executor result summary:\n${opts.coderResult.summary}` : '',
    ``,
    workArtifactBlock,
    ``,
    `Review requirements:`,
    isAnswer
      ? `- Verify every acceptance criterion directly against the answer text and project files.`
      : hasVerify
        ? `- Verify every acceptance criterion against the diff and project files.`
        : `- No verify command was run. Judge every acceptance criterion directly from the diff and project files.`,
    hasVerify ? `- If verify exit code is non-zero, status MUST be "fail".` : '',
    hasVerify && isReadOnly
      ? `- DALANG already ran the verify command in this worktree; its real output is above. Do not run it or other commands that write files again: this workspace is read-only, so they fail for that reason alone.`
      : '',
    isAnswer
      ? `- If any project file outside .dalang/ was modified, record a finding and fail.`
      : `- If files were modified outside files_allowed without justification, record a finding and fail.`,
    `- Record concrete, actionable findings with severity ("critical" | "major" | "minor" | "info"), file path, and note.`,
    `- In "unverified", list each thing you could not check yourself (for example how a page renders, an image you could not open, behaviour that needs a live service). Use an empty list only when you checked everything.`,
    ``,
    isReadOnly
      ? `Output ONLY a single valid JSON object in your final response (no prose outside the JSON) matching this JSON Schema:`
      : `Write a valid JSON file directly to "${opts.relReviewPath}" matching this JSON Schema:`,
    JSON.stringify(jsonSchema, null, 2),
    ``,
    `Set "task_id" to "${opts.task.externalId}", "verify_exit_code" to ${verifyExitLiteral}, and "status" to "pass" or "fail".`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildFixPrompt(opts: {
  task: TaskDTO;
  profile: AgentProfileDTO;
  relResultPath: string;
  relAnswerPath?: string | null;
  round: number;
  review: ReviewContract;
  verifyOutput: string;
  scopeWarnings: string[];
}): string {
  const isAnswer = opts.task.output === 'answer';
  const hasVerify = Boolean(opts.task.verify?.trim());
  const jsonSchema = z.toJSONSchema(
    z.object({
      task_id: z.string(),
      status: z.enum(['completed', 'blocked', 'failed']),
      changed_files: z.array(z.string()),
      summary: z.string(),
      answer: z.string().optional(),
      notes: z.array(z.string()),
      blockers: z.array(z.string()),
      verify_command: z.string().nullable().optional(),
      verify_exit_code: z.number().int().nullable().optional(),
    }),
  );

  const findingsText =
    opts.review.findings.length > 0
      ? opts.review.findings
          .map((f) => `- [${f.severity}] ${f.file ? `${f.file}: ` : ''}${f.note}`)
          .join('\n')
      : hasVerify
        ? '- (no structured findings listed; check verify output below)'
        : '- (no structured findings listed; re-check every acceptance criterion)';

  const verifySection = hasVerify
    ? `Last verify command (${opts.task.verify}) exited with ${opts.review.verify_exit_code}:\n${opts.verifyOutput || '(no output)'}`
    : `No verify command is configured for this task; review failed against the acceptance criteria above.`;

  const scopeSection = isAnswer
    ? `Answer task rule: leave all project files unchanged (revert any accidental edits outside .dalang/) and write the revised answer to "${opts.relAnswerPath ?? '.dalang/tasks/' + opts.task.externalId + '/answer.md'}".`
    : `Allowed files:\n${opts.task.filesAllowed.length > 0 ? opts.task.filesAllowed.map((f) => `- ${f}`).join('\n') : '- (project workspace)'}${opts.task.filesAllowed.length > 0 ? '\nIf the task cannot be finished without changing a file outside these patterns, do not change it: set \"status\" to \"blocked\", list the files in \"needs_files\", and explain why in \"blockers\". DALANG asks the user to allow them.' : ''}`;

  const finishLine = isAnswer
    ? `Update "${opts.relAnswerPath ?? '.dalang/tasks/' + opts.task.externalId + '/answer.md'}"${hasVerify ? ` and run "${opts.task.verify}"` : ''}, then write the updated result JSON to "${opts.relResultPath}" (including "answer") matching:`
    : hasVerify
      ? `Run "${opts.task.verify}" after fixing, then write the updated result JSON to "${opts.relResultPath}" matching:`
      : `Re-check every acceptance criterion after fixing, then write the updated result JSON to "${opts.relResultPath}" matching:`;

  return [
    `Review round ${opts.round} FAILED for task ${opts.task.externalId}: "${opts.task.title}". Fix the issues and re-check.`,
    opts.profile.rolePrompt ? `Role instructions: ${opts.profile.rolePrompt}` : '',
    ``,
    `Review findings to resolve:`,
    findingsText,
    ``,
    opts.scopeWarnings.length > 0
      ? `Scope warnings (${isAnswer ? 'revert all edits to project files outside .dalang/' : 'revert or justify edits outside files_allowed'}):\n${opts.scopeWarnings.map((w) => `- ${w}`).join('\n')}\n`
      : '',
    verifySection,
    ``,
    scopeSection,
    ``,
    `Fix the cause of each finding, not only the example it names: the next review checks the same places again.`,
    selfReviewBlock(isAnswer),
    ``,
    finishLine,
    JSON.stringify(jsonSchema, null, 2),
    `Set "task_id" to "${opts.task.externalId}".`,
  ]
    .filter(Boolean)
    .join('\n');
}
