import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDalangServer } from '../app.js';
import type { CliRunner, RunCommandResult } from '@dalang/core';

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('local triage diagnostics (F6)', () => {
  it('collects redacted doctor checks, server log tail, and recording summary and requires explicit confirmation to start Ask triage', async () => {
    const dataDir = makeTempDir('dalang-triage-data-');
    const repoDir = makeTempDir('dalang-triage-repo-');
    const recDir = makeTempDir('dalang-triage-rec-');
    fs.writeFileSync(
      path.join(dataDir, 'server.log'),
      'boot ok\nAuthorization: Bearer top-secret-token-999\nsk-live-secret-123456\nerror: sample failure\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(recDir, '001-codex.json'),
      JSON.stringify({ provider: 'codex', command: 'codex', exitCode: 1, durationMs: 2500 }),
      'utf8',
    );
    const prevRecordDir = process.env.DALANG_RECORD_DIR;
    process.env.DALANG_RECORD_DIR = recDir;

    const promptsSeen: string[] = [];
    const runner: CliRunner = {
      async which(bin) {
        return `/usr/bin/${bin}`;
      },
      async run(_cmd, args, opts): Promise<RunCommandResult> {
        promptsSeen.push(args.join(' '));
        const line = JSON.stringify({
          type: 'result',
          session_id: 'triage-s1',
          result: JSON.stringify({
            answer: 'Local diagnosis complete. Before opening any GitHub issue, please confirm the exact title and body.',
          }),
        });
        opts.onStdoutLine?.(line);
        return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
      },
    };

    const server = await createDalangServer({
      dbPath: path.join(dataDir, 'dalang.db'),
      runner,
      enableScheduler: false,
    });
    try {
      // 1. Preview returns redacted diagnostics without calling any provider
      const previewRes = await server.app.inject({ method: 'GET', url: '/api/triage/preview' });
      expect(previewRes.statusCode).toBe(200);
      const { preview } = previewRes.json() as {
        preview: {
          version: string;
          os: string;
          doctorChecks: Array<{ id: string }>;
          serverLogTail: string;
          recordingSummary: string | null;
          promptPreview: string;
        };
      };
      expect(preview.version).toBeTruthy();
      expect(preview.os).toBeTruthy();
      expect(preview.doctorChecks.map((c) => c.id)).toContain('node');
      expect(preview.serverLogTail).toContain('[REDACTED]');
      expect(preview.serverLogTail).not.toContain('top-secret-token-999');
      expect(preview.serverLogTail).not.toContain('sk-live-secret-123456');
      expect(preview.recordingSummary).toContain('001-codex.json');
      expect(promptsSeen).toHaveLength(0);

      // 2. Starting triage without explicit confirmed: true is rejected
      const projRes = await server.app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { mode: 'create', name: 'Triage Repo', path: repoDir, initGitIfMissing: true },
      });
      const { project } = projRes.json() as { project: { id: string } };

      const unconfirmed = await server.app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/triage`,
        payload: { confirmed: false, note: 'Something failed' },
      });
      expect(unconfirmed.statusCode).toBe(400);
      expect(promptsSeen).toHaveLength(0);

      // 3. Confirmed triage opens a local Ask session with redacted diagnostics and instructs asking before opening an issue
      const started = await server.app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/triage`,
        payload: { confirmed: true, note: 'Codex timed out on Ask' },
      });
      expect(started.statusCode).toBe(200);
      const startedBody = started.json() as { session: { mode: string }; preview: { serverLogTail: string } };
      expect(startedBody.session.mode).toBe('ask');
      expect(promptsSeen).toHaveLength(1);
      expect(promptsSeen[0]).toContain('Codex timed out on Ask');
      expect(promptsSeen[0]).toContain('Do NOT open a GitHub issue');
      expect(promptsSeen[0]).not.toContain('top-secret-token-999');
    } finally {
      if (prevRecordDir === undefined) delete process.env.DALANG_RECORD_DIR;
      else process.env.DALANG_RECORD_DIR = prevRecordDir;
      await server.close();
    }
  });
});
