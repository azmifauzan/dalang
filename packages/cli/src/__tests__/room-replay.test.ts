import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildSharedParityTranscript,
  PARITY_SCENARIOS,
  ReplayCliRunner,
} from '@dalang/core';
import { startDalangServer } from '@dalang/server';
import { isPtySupported, spawnInPty } from './helpers/pty.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = path.resolve(here, '../../bin/dalang.js');
const REQUIRE_PARITY = process.env.DALANG_REQUIRE_PARITY === '1';

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

describe('Room PTY parity replay suite (PRD v0.15 R5d)', () => {
  it('runs the shared PARITY_SCENARIOS transcript in a real PTY terminal room', async () => {
    const ptyReady = isPtySupported();
    const cliBuilt = fs.existsSync(CLI_ENTRY);
    if (!ptyReady || !cliBuilt) {
      if (REQUIRE_PARITY) {
        throw new Error(
          `DALANG_REQUIRE_PARITY=1 requires a Linux PTY (ptyReady=${ptyReady}) and built CLI (${CLI_ENTRY}, exists=${cliBuilt}).`,
        );
      }
      return;
    }

    const dbDir = makeTempDir('dalang-pty-db-');
    const projDir = path.join(makeTempDir('dalang-pty-proj-'), 'parity-app');
    const transcript = buildSharedParityTranscript();
    const runner = new ReplayCliRunner(transcript);

    const server = await startDalangServer({
      port: 0,
      dbPath: path.join(dbDir, 'dalang.db'),
      runner,
    });

    try {
      const apiJson = async <T>(p: string, init?: RequestInit): Promise<T> => {
        const res = await fetch(`${server.url}${p}`, {
          ...init,
          headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
        });
        const data = (await res.json()) as T;
        if (!res.ok) throw new Error(`HTTP ${res.status} on ${p}: ${JSON.stringify(data)}`);
        return data;
      };

      // Seed one project so the room attaches directly without entering the first-run wizard.
      await apiJson('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ mode: 'create', name: 'Parity App', path: projDir }),
      });

      const port = new URL(server.url).port;
      const pty = spawnInPty(process.execPath, [CLI_ENTRY, 'room', '--port', port], {
        cwd: projDir,
        cols: 110,
        rows: 34,
      });

      try {
        // Wait for the terminal room to attach to the seeded project.
        await pty.waitFor('Parity App', 15_000);

        // Scenario 1: ask-chat-and-model
        await pty.sendLine('/mode ask');
        await pty.waitFor('Composer mode set to [ask]', 10_000);
        await pty.sendLine('PARITY_ASK_HELLO');
        await pty.waitFor(PARITY_SCENARIOS[0].expectedReplyText!, 15_000);

        // Scenario 2: structured-question-answer
        await pty.sendLine('PARITY_PICK_DB');
        await pty.waitFor('Storage engine', 15_000);
        await pty.waitFor('1. PostgreSQL', 10_000);
        await pty.sendLine('1');
        await pty.waitFor(PARITY_SCENARIOS[1].expectedReplyText!, 15_000);

        // Scenario 3: profile-advanced-settings
        await pty.sendLine('/profile set executor-light parallel 3');
        await pty.waitFor('Updated profile "executor-light"', 10_000);
        const { profiles } = await apiJson<{ profiles: Array<{ name: string; maxParallel: number }> }>('/api/profiles');
        expect(profiles.find((p) => p.name === 'executor-light')?.maxParallel).toBe(3);

        // Scenario 4: statistics-overview
        await pty.sendLine('/stats');
        await pty.waitFor('Usage statistics', 10_000);

        // Scenario 5: triage-preview-and-start
        await pty.sendLine('/triage sample issue');
        await pty.waitFor('Triage preview', 10_000);
        await pty.sendLine('y');
        await pty.waitFor(PARITY_SCENARIOS[4].expectedReplyText!, 15_000);

        // Clean exit
        await pty.sendLine('/exit');
      } finally {
        await pty.close();
      }
    } finally {
      await server.close();
    }
  }, 60_000);
});
