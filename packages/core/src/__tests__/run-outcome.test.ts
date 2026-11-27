import { describe, expect, it } from 'vitest';
import { buildTaskResultSummary, describeRunOutcome } from '../services/run-outcome.js';

describe('result summary and run outcome (U5, B17)', () => {
  it('builds a structured task result summary from stored data for completed, failed, and legacy records', () => {
    const passed = buildTaskResultSummary({
      taskId: 't1',
      externalId: 'T-001',
      title: 'Add health check',
      outcome: 'completed',
      summary: 'Implemented /api/health endpoint and unit test.',
      changedFiles: [
        { path: 'src/health.ts', additions: 24, deletions: 2 },
        { path: 'src/health.test.ts', additions: 31, deletions: 0 },
      ],
      verifyCommand: 'pnpm test',
      verifyExitCode: 0,
      reviewStatus: 'pass',
      reviewRound: 1,
      findingsCount: 0,
      durationMs: 12_400,
    });
    expect(passed).toMatchObject({
      externalId: 'T-001',
      outcome: 'completed',
      whatWasDone: 'Implemented /api/health endpoint and unit test.',
      verifyResult: 'passed (exit 0): pnpm test',
      reviewResult: 'round 1 passed (0 finding(s))',
      durationMs: 12_400,
    });
    expect(passed.changedFiles).toHaveLength(2);
    expect(passed.nextStep).toMatch(/merge/i);

    const reviewFailed = buildTaskResultSummary({
      taskId: 't2',
      externalId: 'T-002',
      title: 'Refactor auth',
      outcome: 'review_failed',
      failureReason: 'Missing token expiry test',
      verifyCommand: 'pnpm test',
      verifyExitCode: 1,
      reviewStatus: 'fail',
      reviewRound: 2,
      findingsCount: 2,
    });
    expect(reviewFailed.verifyResult).toContain('failed (exit 1)');
    expect(reviewFailed.reviewResult).toContain('round 2 failed (2 finding(s))');
    expect(reviewFailed.nextStep).toMatch(/Continue Fixing/i);

    // Legacy record with minimal fields produces clean defaults without error
    const legacy = buildTaskResultSummary({
      taskId: 't3',
      externalId: 'T-003',
      title: 'Old task',
      outcome: 'completed',
    });
    expect(legacy.whatWasDone).toBe('Task finished.');
    expect(legacy.changedFiles).toEqual([]);
    expect(legacy.verifyResult).toContain('skipped');
    expect(legacy.reviewResult).toBeNull();
    expect(legacy.durationMs).toBeNull();
  });

  it('includes overall outcome and one summary line per task in run_finished and run_stopped', () => {
    const finished = describeRunOutcome([
      { externalId: 'T-001', title: 'First task', status: 'done', delegationDepth: 0, summary: 'Added API' },
      { externalId: 'T-002', title: 'Second task', status: 'done', delegationDepth: 0, summary: 'Added UI' },
    ]);
    expect(finished?.event).toBe('run_finished');
    expect(finished?.summary).toContain('[T-001] First task — done: Added API');
    expect(finished?.summary).toContain('[T-002] Second task — done: Added UI');
    expect(finished?.outcome?.taskSummaries).toHaveLength(2);

    const stopped = describeRunOutcome([
      { externalId: 'T-001', title: 'First task', status: 'done', delegationDepth: 0, summary: 'Done' },
      { externalId: 'T-002', title: 'Broken task', status: 'review_failed', delegationDepth: 0, summary: '1 finding left' },
      { externalId: 'T-003', title: 'Blocked task', status: 'approved', delegationDepth: 0 },
    ]);
    expect(stopped?.event).toBe('run_stopped');
    expect(stopped?.summary).toContain('1 of 3 task(s) done');
    expect(stopped?.summary).toContain('[T-002] Broken task — review_failed: 1 finding left');
    expect(stopped?.summary).toContain('[T-003] Blocked task — approved');
  });
});
