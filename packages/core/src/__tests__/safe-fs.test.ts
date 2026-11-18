import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PlanTaskContractSchema } from '@dalang/shared';
import type { AdapterTurnResult, CliAdapter } from '../adapters/types.js';
import { ensureProjectDir, readArtifactFile, writeArtifactFile } from '../safe-fs.js';
import { runContractTurn } from '../services/contract.js';

const tempDirs: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const project = tmp('dalang-sfs-');
  const outside = tmp('dalang-outside-');
  const victim = path.join(outside, 'victim.txt');
  fs.writeFileSync(victim, 'SECRET-CONTENT');
  fs.mkdirSync(path.join(project, '.dalang'), { recursive: true });
  return { project, outside, victim };
}

describe('safe artifact I/O (an agent can plant symlinks in the project)', () => {
  it('replaces a symlink at the target instead of writing through it', () => {
    const { project, victim } = setup();
    const target = path.join(project, '.dalang', 'plan.json');
    fs.symlinkSync(victim, target);

    writeArtifactFile(project, target, '{"ok":true}');

    expect(fs.readFileSync(victim, 'utf8')).toBe('SECRET-CONTENT');
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('{"ok":true}');
  });

  it('refuses a symlink when asked to keep user-owned links', () => {
    const { project, victim } = setup();
    const target = path.join(project, 'PROJECT.md');
    fs.symlinkSync(victim, target);
    expect(() => writeArtifactFile(project, target, 'x', 'refuse')).toThrow(/symlink/);
    expect(fs.readFileSync(victim, 'utf8')).toBe('SECRET-CONTENT');
  });

  it('refuses a .dalang folder that points outside the project', () => {
    const project = tmp('dalang-sfs-');
    const outside = tmp('dalang-outside-');
    fs.symlinkSync(outside, path.join(project, '.dalang'));
    expect(() => ensureProjectDir(project, path.join(project, '.dalang', 'tmp'))).toThrow(/outside the project/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('refuses to read a symlinked artifact', () => {
    const { project, victim } = setup();
    const target = path.join(project, '.dalang', 'brief.v1.json');
    fs.symlinkSync(victim, target);
    expect(() => readArtifactFile(project, target)).toThrow(/not a regular file/);
  });

  it('never echoes a planted file back to the agent in a retry prompt', async () => {
    const { project, victim } = setup();
    const target = path.join(project, '.dalang', 'out.json');
    const prompts: string[] = [];
    const adapter: CliAdapter = {
      id: 'claude-code',
      displayName: 'fake',
      binary: 'fake',
      checkStatus: async () => {
        throw new Error('unused');
      },
      getUsage: async () => {
        throw new Error('unused');
      },
      runTurn: async (opts): Promise<AdapterTurnResult> => {
        prompts.push(opts.prompt);
        fs.rmSync(target, { force: true });
        fs.symlinkSync(victim, target);
        return { text: '', sessionId: 's', exitCode: 0, stdout: '', stderr: '' };
      },
    };

    await expect(
      runContractTurn({
        adapter,
        projectPath: project,
        prompt: 'write it',
        targetFilePath: target,
        schema: z.object({ ok: z.boolean() }),
        schemaName: 'out',
        maxRetries: 1,
      }),
    ).rejects.toThrow(/not a regular file/);
    expect(prompts.join('\n')).not.toContain('SECRET-CONTENT');
  });

  it('rejects task ids that could escape a file name', () => {
    const base = {
      title: 't',
      milestone: 'M1',
      goal: 'g',
      acceptance_criteria: ['c'],
      verify: 'true',
    };
    expect(PlanTaskContractSchema.safeParse({ ...base, id: '../../etc/x' }).success).toBe(false);
    expect(PlanTaskContractSchema.safeParse({ ...base, id: 'T-002a' }).success).toBe(true);
  });
});
