import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliRunner, RunCommandResult } from '../adapters/types.js';
import { shouldAutoFixAfterReview } from '../services/review.js';
import {
  cleanupTempDirs,
  handleLeadCalls,
  handleVerifyAndReviewCalls,
  setupApprovedProject,
} from './exec-helpers.js';

afterEach(cleanupTempDirs);

describe('Light review policy for low complexity and Quick tasks (PRD v0.15 P2)', () => {
  it('enforces shouldAutoFixAfterReview rules across complexity and session mode', () => {
    expect(shouldAutoFixAfterReview({ complexity: 'low', sessionMode: 'full', round: 1, maxRounds: 2 })).toBe(false);
    expect(shouldAutoFixAfterReview({ complexity: 'medium', sessionMode: 'quick', round: 1, maxRounds: 2 })).toBe(false);
    expect(shouldAutoFixAfterReview({ complexity: 'high', sessionMode: 'quick', round: 1, maxRounds: 3 })).toBe(false);
    expect(shouldAutoFixAfterReview({ complexity: 'medium', sessionMode: 'full', round: 1, maxRounds: 2 })).toBe(true);
    expect(shouldAutoFixAfterReview({ complexity: 'high', sessionMode: 'auto', round: 1, maxRounds: 2 })).toBe(true);
    expect(shouldAutoFixAfterReview({ complexity: 'medium', sessionMode: 'full', round: 2, maxRounds: 2 })).toBe(false);
  });

  it('stops a low-complexity task at review_failed after 1 review round without running an automatic fix round', async () => {
    let fixRounds = 0;
    let reviewRounds = 0;
    const runner: CliRunner = {
      async which(bin) {
        return `/usr/bin/${bin}`;
      },
      async run(cmd, args, opts): Promise<RunCommandResult> {
        const lead = handleLeadCalls(opts.cwd, args, opts);
        if (lead) return lead;
        const prompt = args.join(' ');
        if (/code review round/i.test(prompt)) {
          reviewRounds += 1;
          const review = handleVerifyAndReviewCalls(cmd, args, opts, 'fail');
          if (review) return review;
        }
        const verify = handleVerifyAndReviewCalls(cmd, args, opts, 'fail');
        if (verify) return verify;
        if (/Review round \d+ FAILED/i.test(prompt)) {
          fixRounds += 1;
        }
        const match = prompt.match(/(\.dalang\/(?:sessions\/[A-Za-z0-9_-]+\/)?tasks\/([A-Za-z0-9_-]+)\/result\.json)/);
        if (match) {
          fs.mkdirSync(path.join(opts.cwd, 'src'), { recursive: true });
          fs.writeFileSync(path.join(opts.cwd, 'src', 'small.ts'), 'export const x = 1;\n');
          fs.mkdirSync(path.dirname(path.join(opts.cwd, match[1])), { recursive: true });
          fs.writeFileSync(
            path.join(opts.cwd, match[1]),
            JSON.stringify({
              task_id: match[2],
              status: 'completed',
              changed_files: ['src/small.ts'],
              summary: 'Done small task',
              notes: [],
              blockers: [],
              verify_exit_code: 0,
            }),
          );
        }
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
      },
    };

    const { conn, project, execSvc, leadSvc, plan } = await setupApprovedProject(runner, [
      { id: 'T-001', title: 'Small low task', complexity: 'low', files_allowed: ['src/**'] },
    ]);

    try {
      await execSvc.startExecution(project.id, { allowUnconfined: true });
      await execSvc.waitForProjectExecution(project.id);

      expect(reviewRounds).toBe(1);
      expect(fixRounds).toBe(0);
      const updated = leadSvc.getPlan(project.id, plan.sessionId)?.tasks.find((t) => t.externalId === 'T-001');
      expect(updated?.status).toBe('review_failed');
      expect(updated?.reviewRounds).toBe(1);
    } finally {
      conn.close();
    }
  });
});
