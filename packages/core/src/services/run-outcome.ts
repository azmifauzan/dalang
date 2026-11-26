import type { RoomReportContent } from '@dalang/shared';

interface OutcomeTask {
  externalId: string;
  status: string;
  delegationDepth: number;
}

const list = (tasks: OutcomeTask[]) => tasks.map((t) => t.externalId).join(', ');

/**
 * The closing note for a plan whose run has stopped: nothing is running and nothing else can start.
 * The room and the web UI show it, and the Lead reads it in its transcript on the next turn.
 * Returns null while work is still moving: a task runs, is reviewed, or waits for a merge (Auto merges
 * it, and otherwise the merge prompt is already on screen).
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
  const ids = (list: OutcomeTask[]) => list.map((t) => t.externalId);
  const outcome = {
    done: done.length,
    total: tasks.length,
    reviewFailed: ids(reviewFailed),
    failed: ids(failed),
    waiting: ids(waiting),
  };
  if (done.length === tasks.length) {
    return { event: 'run_finished', summary: `Run finished: all ${tasks.length} task(s) are done.`, outcome };
  }

  const lines = [`Run stopped: ${done.length} of ${tasks.length} task(s) done. No other task can start.`];
  if (reviewFailed.length > 0) {
    lines.push(
      `Review failed after the last round: ${list(reviewFailed)}. Retry them, or ask the Lead to split them into smaller tasks.`,
    );
  }
  if (failed.length > 0) lines.push(`Failed or stopped: ${list(failed)}. Retry or Resume them.`);
  if (waiting.length > 0) lines.push(`Not started, waiting on the tasks above: ${list(waiting)}.`);
  return { event: 'run_stopped', summary: lines.join('\n'), outcome };
}
