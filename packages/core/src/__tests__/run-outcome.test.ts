import { describe, expect, it } from 'vitest';
import { describeRunOutcome } from '../services/run-outcome.js';

const t = (externalId: string, status: string, delegationDepth = 0) => ({ externalId, status, delegationDepth });

describe('describeRunOutcome', () => {
  it('says nothing while work still moves', () => {
    expect(describeRunOutcome([t('a', 'done'), t('b', 'running')])).toBeNull();
    expect(describeRunOutcome([t('a', 'done'), t('b', 'reviewing')])).toBeNull();
    // Auto merges a passed task on its own; otherwise the merge prompt is already showing.
    expect(describeRunOutcome([t('a', 'awaiting_merge'), t('b', 'review_failed')])).toBeNull();
    expect(describeRunOutcome([])).toBeNull();
  });

  it('reports a finished run, ignoring subtasks', () => {
    expect(describeRunOutcome([t('a', 'done'), t('a.1', 'failed', 1)])).toEqual({
      event: 'run_finished',
      summary: 'Run finished: all 1 task(s) are done.',
      outcome: { done: 1, total: 1, reviewFailed: [], failed: [], waiting: [] },
    });
  });

  it('names the blocking tasks and the next step when the run stops early', () => {
    const outcome = describeRunOutcome(
      [t('a', 'done'), t('b', 'review_failed'), t('c', 'failed'), t('e', 'approved')],
    );
    expect(outcome?.event).toBe('run_stopped');
    expect(outcome?.outcome).toEqual({ done: 1, total: 4, reviewFailed: ['b'], failed: ['c'], waiting: ['e'] });
    expect(outcome?.summary.split('\n')).toEqual([
      'Run stopped: 1 of 4 task(s) done. No other task can start.',
      'Review failed after the last round: b. Retry them, or ask the Lead to split them into smaller tasks.',
      'Failed or stopped: c. Retry or Resume them.',
      'Not started, waiting on the tasks above: e.',
    ]);
  });
});
