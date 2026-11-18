import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AdapterTurnResult, CliAdapter } from '../adapters/types.js';
import { runContractTurn } from '../services/contract.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function adapterThatWrites(write: ((target: string) => void) | null, target: string): CliAdapter {
  const turn: AdapterTurnResult = { text: '', sessionId: 's1', exitCode: 0, stdout: '', stderr: '' };
  return {
    id: 'claude-code',
    displayName: 'fake',
    binary: 'fake',
    checkStatus: async () => {
      throw new Error('unused');
    },
    getUsage: async () => {
      throw new Error('unused');
    },
    runTurn: async () => {
      write?.(target);
      return turn;
    },
  };
}

describe('runContractTurn', () => {
  it('rejects a valid file left over from an earlier run when the agent writes nothing', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'dalang-contract-'));
    tempDirs.push(project);
    const target = path.join(project, '.dalang', 'out.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ ok: true }));

    await expect(
      runContractTurn({
        adapter: adapterThatWrites(null, target),
        projectPath: project,
        prompt: 'write it',
        targetFilePath: target,
        schema: z.object({ ok: z.boolean() }),
        schemaName: 'out',
        maxRetries: 0,
      }),
    ).rejects.toThrow(/not written/i);
  });

  it('accepts the file when the agent writes it this run', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'dalang-contract-'));
    tempDirs.push(project);
    const target = path.join(project, '.dalang', 'out.json');

    const result = await runContractTurn({
      adapter: adapterThatWrites((t) => fs.writeFileSync(t, JSON.stringify({ ok: true })), target),
      projectPath: project,
      prompt: 'write it',
      targetFilePath: target,
      schema: z.object({ ok: z.boolean() }),
      schemaName: 'out',
    });
    expect(result.data).toEqual({ ok: true });
  });
});
