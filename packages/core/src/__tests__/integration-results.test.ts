import { afterEach, describe, expect, it } from 'vitest';
import { analyzeIntegrationRunOutput } from '@dalang/shared';
import type { CliRunner, RunCommandResult } from '../adapters/types.js';
import { cleanupTempDirs, handleLeadCalls, handleVerifyAndReviewCalls, setupApprovedProject } from './exec-helpers.js';

afterEach(cleanupTempDirs);

describe('integration results (U8, B21)', () => {
  it('classifies test failure, timeout, and sandbox environment errors and detects unrun packages', () => {
    const env = analyzeIntegrationRunOutput(
      'failed',
      1,
      'Scope: 5 of 6 workspace projects\npackages/core test$ vitest run\nbwrap: No permissions to create a new namespace\npackages/core:\nERR_PNPM_RECURSIVE_RUN_FIRST_FAIL Command failed',
    );
    expect(env.failureKind).toBe('sandbox_environment');
    expect(env.canRerunOutsideSandbox).toBe(true);
    expect(env.environmentReason).toMatch(/bubblewrap namespace/i);
    expect(env.unrunPackages.length).toBeGreaterThan(0);

    const timeout = analyzeIntegrationRunOutput('failed', 124, '[dalang] Integration suite timed out.');
    expect(timeout.failureKind).toBe('timeout');
    expect(timeout.canRerunOutsideSandbox).toBe(false);

    const testFail = analyzeIntegrationRunOutput('failed', 1, 'FAIL src/foo.test.ts\nAssertionError: expected 1 to be 2');
    expect(testFail.failureKind).toBe('test_failure');
    expect(testFail.canRerunOutsideSandbox).toBe(false);
  });

  it('posts one stored result and one redacted chat report per integration run and requires explicit approval to bypass sandbox', async () => {
    let mode: 'pass' | 'test_fail' | 'sandbox_fail' | 'timeout' = 'sandbox_fail';
    const seenBypassCommands: Array<{ cmd: string; args: string[] }> = [];
    const runner: CliRunner = {
      async which(bin) {
        return `/usr/bin/${bin}`;
      },
      async run(cmd, args, opts): Promise<RunCommandResult> {
        const lead = handleLeadCalls(opts.cwd, args, opts);
        if (lead) return lead;
        if (args.join(' ').includes('Run supervision check')) {
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
        }
        seenBypassCommands.push({ cmd, args });
        if (mode === 'sandbox_fail') {
          return {
            exitCode: 1,
            stdout: 'Scope: 3 of 3 workspace projects\npackages/core test$ vitest run\nAuthorization: Bearer secret-xyz-123\npackages/core:\nERR_PNPM_RECURSIVE_RUN_FIRST_FAIL',
            stderr: 'bwrap: No permissions to create a new namespace',
            timedOut: false,
            idleTimedOut: false,
          };
        }
        if (mode === 'timeout') {
          return { exitCode: null, stdout: 'running...', stderr: '', timedOut: true, idleTimedOut: false };
        }
        if (mode === 'test_fail') {
          return { exitCode: 1, stdout: 'FAIL unit.test.ts', stderr: '', timedOut: false, idleTimedOut: false };
        }
        return { exitCode: 0, stdout: 'all tests passed', stderr: '', timedOut: false, idleTimedOut: false };
      },
    };

    const { conn, project, plan, leadSvc, execSvc } = await setupApprovedProject(runner);
    try {
      // 1. Sandbox failure: classified as environment problem, secrets redacted, one chat report posted
      const envRun = await execSvc.runIntegrationTests(project.id, {
        command: 'pnpm test',
        sessionId: plan.sessionId,
      });
      expect(envRun.status).toBe('failed');
      expect(envRun.failureKind).toBe('sandbox_environment');
      expect(envRun.canRerunOutsideSandbox).toBe(true);
      expect(envRun.output).not.toContain('secret-xyz-123');
      expect(envRun.output).toContain('[REDACTED]');
      expect(envRun.unrunPackages?.length).toBeGreaterThan(0);

      const msgsAfterEnv = leadSvc.getSessionDetail(project.id, plan.sessionId).messages
        .filter((m) => m.kind === 'status' && JSON.stringify(m.content).includes('integration_result'));
      expect(msgsAfterEnv).toHaveLength(1);
      expect(JSON.stringify(msgsAfterEnv[0].content)).toContain('Environment problem');
      expect(JSON.stringify(msgsAfterEnv[0].content)).not.toContain('secret-xyz-123');

      // 2. Refuses bypassSandbox without explicit allowUnconfined approval
      await expect(
        execSvc.runIntegrationTests(project.id, {
          command: 'pnpm test',
          sessionId: plan.sessionId,
          bypassSandbox: true,
          allowUnconfined: false,
        }),
      ).rejects.toThrow(/Explicit approval/);

      // 3. Explicit approval allows running outside sandbox (verifies command is /bin/sh, not bwrap, using fake runner)
      mode = 'pass';
      seenBypassCommands.length = 0;
      const outsideRun = await execSvc.runIntegrationTests(project.id, {
        command: 'pnpm test',
        sessionId: plan.sessionId,
        bypassSandbox: true,
        allowUnconfined: true,
      });
      expect(outsideRun.status).toBe('passed');
      expect(outsideRun.ranOutsideSandbox).toBe(true);
      expect(seenBypassCommands[0].cmd).not.toContain('bwrap');

      // 4. Timeout and normal test failure produce distinct classifications
      mode = 'timeout';
      const timeoutRun = await execSvc.runIntegrationTests(project.id, { command: 'pnpm test', sessionId: plan.sessionId });
      expect(timeoutRun.failureKind).toBe('timeout');
      expect(timeoutRun.exitCode).toBe(124);

      mode = 'test_fail';
      const testFailRun = await execSvc.runIntegrationTests(project.id, { command: 'pnpm test', sessionId: plan.sessionId });
      expect(testFailRun.failureKind).toBe('test_failure');

      const guard = await execSvc.getGuardState(project.id, plan.sessionId);
      expect(guard.integrationRuns).toHaveLength(4);
      expect(guard.integrationRuns.map((r) => r.failureKind)).toEqual(['test_failure', 'timeout', 'none', 'sandbox_environment']);
    } finally {
      conn.close();
    }
  });
});
