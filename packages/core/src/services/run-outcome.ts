import type { RoomReportContent, RunOutcomeTaskSummaryDTO, TaskResultSummaryDTO } from '@dalang/shared';

export interface OutcomeTask {
  externalId: string;
  title?: string;
  status: string;
  delegationDepth: number;
  summary?: string | null;
}

export interface BuildTaskResultSummaryInput {
  taskId: string;
  externalId: string;
  title: string;
  outcome: TaskResultSummaryDTO['outcome'];
  summary?: string | null;
  failureReason?: string | null;
  changedFiles?: Array<{ path: string; additions: number; deletions: number }>;
  verifyCommand?: string | null;
  verifyExitCode?: number | null;
  verifySkipped?: boolean;
  reviewStatus?: 'pass' | 'fail' | null;
  reviewRound?: number | null;
  findingsCount?: number | null;
  durationMs?: number | null;
  outputKind?: 'files' | 'answer';
}

export function buildTaskResultSummary(input: BuildTaskResultSummaryInput): TaskResultSummaryDTO {
  const whatWasDone =
    input.summary?.trim() ||
    input.failureReason?.trim() ||
    (input.outcome === 'completed' ? 'Task finished.' : 'Task did not finish.');

  const verifyResult =
    input.verifySkipped || !input.verifyCommand
      ? 'skipped (no verify command)'
      : input.verifyExitCode === null || input.verifyExitCode === undefined
        ? `not recorded (${input.verifyCommand})`
        : input.verifyExitCode === 0
          ? `passed (exit 0): ${input.verifyCommand}`
          : `failed (exit ${input.verifyExitCode}): ${input.verifyCommand}`;

  const reviewResult =
    input.reviewStatus && input.reviewRound
      ? `round ${input.reviewRound} ${input.reviewStatus === 'pass' ? 'passed' : 'failed'} (${input.findingsCount ?? 0} finding(s))`
      : null;

  let nextStep: string;
  if (input.outcome === 'completed') {
    nextStep =
      input.reviewStatus === 'pass'
        ? input.outputKind === 'answer'
          ? 'Review and accept the answer in Guard or with /accept.'
          : 'Inspect /diff and merge in Guard or with /merge.'
        : 'Pending review before merge.';
  } else if (input.outcome === 'review_failed') {
    nextStep = 'Use Continue Fixing to address the open review findings on this branch, or inspect /diff.';
  } else if (input.outcome === 'stopped') {
    nextStep = 'Use Continue / Resume to pick up on this branch, or Retry to start over.';
  } else {
    nextStep = 'Check the failure reason above, then Continue / Resume or ask the Lead to revise the task.';
  }

  return {
    taskId: input.taskId,
    externalId: input.externalId,
    title: input.title,
    outcome: input.outcome,
    whatWasDone,
    changedFiles: input.changedFiles ?? [],
    verifyResult,
    reviewResult,
    durationMs: input.durationMs ?? null,
    nextStep,
  };
}

const list = (tasks: OutcomeTask[]) => tasks.map((t) => t.externalId).join(', ');

/**
 * The closing note for a plan whose run has stopped: nothing is running and nothing else can start.
 * Repeats the overall outcome and one summary line per task from stored data (U5, B17).
 */
export function describeRunOutcome(
  allTasks: OutcomeTask[],
): Pick<RoomReportContent, 'event' | 'summary' | 'outcome'> | null {
  const tasks = allTasks.filter((t) => t.delegationDepth === 0);
  if (tasks.length === 0) return null;
  const by = (...statuses: string[]) => tasks.filter((t) => statuses.includes(t.status));
  if (by('running', 'reviewing', 'awaiting_merge').length > 0) return null;

  const done = by('done');
  const reviewFailed = by('review_failed');
  const failed = by('failed', 'stopped');
  const waiting = by('approved', 'ready', 'draft', 'needs_split');
  const ids = (items: OutcomeTask[]) => items.map((t) => t.externalId);
  const taskSummaries: RunOutcomeTaskSummaryDTO[] = tasks.map((t) => ({
    externalId: t.externalId,
    title: t.title ?? t.externalId,
    status: t.status,
    summary: t.summary?.trim() || t.status,
  }));
  const perTaskLines = taskSummaries.map(
    (t) => `- [${t.externalId}] ${t.title} — ${t.status}${t.summary && t.summary !== t.status ? `: ${t.summary}` : ''}`,
  );
  const outcome = {
    done: done.length,
    total: tasks.length,
    reviewFailed: ids(reviewFailed),
    failed: ids(failed),
    waiting: ids(waiting),
    taskSummaries,
  };

  if (done.length === tasks.length) {
    return {
      event: 'run_finished',
      summary: [`Run finished: all ${tasks.length} task(s) are done.`, ...perTaskLines].join('\n'),
      outcome,
    };
  }

  const lines = [`Run stopped: ${done.length} of ${tasks.length} task(s) done. No other task can start.`];
  if (reviewFailed.length > 0) {
    lines.push(
      `Review failed after the last round: ${list(reviewFailed)}. Use Continue Fixing on their branch, Retry them, or ask the Lead to split them into smaller tasks.`,
    );
  }
  if (failed.length > 0) lines.push(`Failed or stopped: ${list(failed)}. Continue, Retry, or Resume them.`);
  if (waiting.length > 0) lines.push(`Not started, waiting on the tasks above: ${list(waiting)}.`);
  lines.push(...perTaskLines);
  return { event: 'run_stopped', summary: lines.join('\n'), outcome };
}
