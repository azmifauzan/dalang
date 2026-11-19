import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, describe, expect, it } from 'vitest';
import { parseAgyModelsOutput } from '../adapters/antigravity.js';
import { ClaudeCodeAdapter, parseClaudeInitializeModels } from '../adapters/claude.js';
import { parseCodexModelsJson } from '../adapters/codex.js';
import {
  buildMacOsSeatbeltProfile,
  buildProviderAccountEnv,
  detectSandboxEngine,
  wrapWithBwrap,
  wrapWithSandbox,
} from '../adapters/sandbox.js';
import type { CliRunner, RunCommandResult } from '../adapters/types.js';
import {
  createGitCheckpoint,
  createHiddenCheckpointRef,
  ensureMainBaseline,
  getHeadCommit,
  listHiddenCheckpointRefs,
} from '../services/git.js';
import { estimateApiEquivalentCostUsd } from '../services/pricing.js';

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

describe('v0.5 macOS sandbox-exec parity with bwrap', () => {
  const darwinRunner: CliRunner = {
    async which(bin) {
      if (bin === 'sandbox-exec') return '/usr/bin/sandbox-exec';
      return null;
    },
    async run(): Promise<RunCommandResult> {
      throw new Error('unused');
    },
  };

  it('detects sandbox-exec on darwin and bwrap on linux', async () => {
    const darwin = await detectSandboxEngine(darwinRunner, 'darwin');
    expect(darwin).toEqual({ engine: 'sandbox-exec', binaryPath: '/usr/bin/sandbox-exec' });

    const linuxRunner: CliRunner = {
      async which(bin) {
        return bin === 'bwrap' ? '/usr/bin/bwrap' : null;
      },
      async run(): Promise<RunCommandResult> {
        throw new Error('unused');
      },
    };
    const linux = await detectSandboxEngine(linuxRunner, 'linux');
    expect(linux).toEqual({ engine: 'bwrap', binaryPath: '/usr/bin/bwrap' });

    const win = await detectSandboxEngine(linuxRunner, 'win32');
    expect(win).toEqual({ engine: 'none', binaryPath: null });
  });

  it('enforces project-only writes, read-only mode, credential read denial, .git/hooks protection, and custom configDir', async () => {
    const proj = makeTempDir('dalang-macos-sb-');
    const customConfig = path.join(makeTempDir('dalang-cfg-'), 'claude-acct2');
    fs.mkdirSync(path.join(proj, '.git', 'hooks'), { recursive: true });

    const rw = await wrapWithSandbox(
      darwinRunner,
      'claude-code',
      proj,
      '/usr/local/bin/claude',
      ['-p', 'hi'],
      { platform: 'darwin', configDir: customConfig },
    );
    expect(rw.sandboxed).toBe(true);
    expect(rw.engine).toBe('sandbox-exec');
    expect(rw.command).toBe('/usr/bin/sandbox-exec');
    expect(rw.args[0]).toBe('-p');
    const sbpl = rw.args[1];
    expect(sbpl).toContain('(deny file-write*)');
    expect(sbpl).toContain(`(allow file-write* (subpath "${proj}"))`);
    expect(sbpl).toContain(`(allow file-write* (subpath "${customConfig}"))`);
    expect(sbpl).toContain(`(deny file-write* (subpath "${path.join(proj, '.git', 'hooks')}"))`);
    expect(sbpl).toContain('.ssh');
    expect(sbpl).toContain('.gnupg');
    expect(sbpl).toContain('.aws');
    expect(sbpl).toContain('.git-credentials');
    expect(sbpl).toContain('.netrc');

    // Read-only mode must NOT grant file-write on the project directory.
    const roProfile = buildMacOsSeatbeltProfile('codex', proj, { readOnly: true });
    expect(roProfile).toContain('(deny file-write*)');
    expect(roProfile).not.toContain(`(allow file-write* (subpath "${proj}"))`);

    // Worktree `.git` link file must be protected from writes.
    const wtDir = makeTempDir('dalang-macos-wt-');
    fs.writeFileSync(path.join(wtDir, '.git'), 'gitdir: /tmp/main/.git/worktrees/t1\n');
    const wtProfile = buildMacOsSeatbeltProfile('claude-code', wtDir);
    expect(wtProfile).toContain(`(deny file-write* (literal "${path.join(wtDir, '.git')}"))`);
  });

  it('mounts custom configDir writable and exports provider env vars in bwrap', async () => {
    if (process.platform !== 'linux') return;
    const proj = makeTempDir('dalang-bwrap-acct-');
    const customDir = path.join(makeTempDir('dalang-bwrap-cfg-'), 'codex-acct2');
    const linuxRunner: CliRunner = {
      async which(bin) {
        return bin === 'bwrap' ? '/usr/bin/bwrap' : null;
      },
      async run(): Promise<RunCommandResult> {
        throw new Error('unused');
      },
    };
    const inv = await wrapWithBwrap(linuxRunner, 'codex', proj, '/usr/bin/codex', ['exec'], {
      configDir: customDir,
    });
    expect(inv.sandboxed).toBe(true);
    expect(inv.args).toContain(customDir);
    expect(inv.args).toContain('CODEX_HOME');
    expect(buildProviderAccountEnv('claude-code', '/tmp/c2')).toEqual({ CLAUDE_CONFIG_DIR: '/tmp/c2' });
    expect(buildProviderAccountEnv('codex', '/tmp/x2')).toEqual({ CODEX_HOME: '/tmp/x2' });
    expect(buildProviderAccountEnv('antigravity', '/tmp/a2')).toMatchObject({ AGY_CONFIG_DIR: '/tmp/a2' });
  });
});

describe('v0.5 rich model parsing & pricing', () => {
  it('parses Claude initialize models with [1m] variants, effort levels including max, and flags', () => {
    const stdout = JSON.stringify({
      type: 'control_response',
      response: {
        response: {
          models: [
            { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default' },
            {
              value: 'opus',
              resolvedModel: 'claude-opus-5-5',
              displayName: 'Opus',
              description: 'Opus 5.5 · $4/$20 per Mtok',
              supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
              supportsFastMode: true,
              supportsAdaptiveThinking: true,
            },
            {
              value: 'claude-fable-5-2[1m]',
              resolvedModel: 'claude-fable-5-2',
              displayName: 'Fable',
              description: 'Fable 5.2 · 1M context',
              supportedEffortLevels: ['low', 'medium', 'high', 'max'],
              supportsFastMode: false,
            },
          ],
        },
      },
    });
    const parsed = parseClaudeInitializeModels(stdout);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      id: 'claude-opus-5-5',
      value: 'opus',
      displayName: 'Opus',
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      supportsFastMode: true,
      supportsThinking: true,
      variants: [],
    });
    expect(parsed[1]).toMatchObject({
      id: 'claude-fable-5-2',
      value: 'claude-fable-5-2',
      displayName: 'Fable',
      variants: [{ id: '1m', label: '1M context', value: 'claude-fable-5-2[1m]' }],
    });
  });

  it('parses Codex debug models and Antigravity models with display names and effort levels', () => {
    const codexParsed = parseCodexModelsJson(
      JSON.stringify({
        models: [
          {
            slug: 'gpt-6.2-sol',
            display_name: 'GPT-6.2-Sol',
            description: 'Fast coding model',
            visibility: 'list',
            default_reasoning_level: 'low',
            supported_reasoning_levels: [
              { effort: 'low' },
              { effort: 'medium' },
              { effort: 'high' },
              { effort: 'xhigh' },
              { effort: 'max' },
              { effort: 'ultra' },
            ],
          },
          { slug: 'hidden-model', visibility: 'hide' },
        ],
      }),
    );
    expect(codexParsed).toHaveLength(1);
    expect(codexParsed[0]).toMatchObject({
      id: 'gpt-6.2-sol',
      displayName: 'GPT-6.2-Sol',
      description: 'Fast coding model',
      defaultEffort: 'low',
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    });

    const agyParsed = parseAgyModelsOutput(
      [
        'Fetching available models...',
        'gemini-4-neon-low\tGemini 4 Neon (Low)',
        'gemini-4-neon-high\tGemini 4 Neon (High)',
        'gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)',
        'gemini-pro-orchestrator-neon\tOrchestrator (Neon)',
      ].join('\n'),
    );
    expect(agyParsed).toHaveLength(2);
    expect(agyParsed[0]).toMatchObject({
      id: 'gemini-4-neon',
      displayName: 'Gemini 4 Neon',
      supportedEffortLevels: ['low', 'high', 'xhigh'],
      defaultEffort: 'high',
    });
    expect(agyParsed[1]).toMatchObject({
      id: 'gemini-pro-orchestrator-neon',
      displayName: 'Orchestrator (Neon)',
      supportedEffortLevels: [],
      defaultEffort: null,
    });
  });

  it('prefers CLI-reported cost and falls back to API-equivalent pricing estimate', () => {
    const exact = estimateApiEquivalentCostUsd({
      provider: 'claude-code',
      model: 'claude-opus-5-5',
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reportedCostUsd: 0.042,
    });
    expect(exact).toEqual({ costUsd: 0.042, source: 'cli' });

    const est = estimateApiEquivalentCostUsd({
      provider: 'codex',
      model: 'gpt-6.2-sol',
      inputTokens: 100_000,
      outputTokens: 50_000,
      cacheReadTokens: 500_000,
      cacheWriteTokens: 0,
    });
    expect(est.source).toBe('estimated');
    expect(est.costUsd).toBeGreaterThan(0);
  });
});

describe('v0.5 side-effect-free health checks & hidden checkpoint refs', () => {
  it('runs Claude model discovery with --bare --no-session-persistence from tmpdir', async () => {
    const seen: Array<{ args: string[]; cwd: string }> = [];
    const runner: CliRunner = {
      async which(b) {
        return `/usr/bin/${b}`;
      },
      async run(_cmd, args, opts): Promise<RunCommandResult> {
        seen.push({ args, cwd: opts.cwd });
        if (args[0] === '--version') return { exitCode: 0, stdout: '2.0.0', stderr: '', timedOut: false, idleTimedOut: false };
        if (args[0] === 'auth') return { exitCode: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: '', timedOut: false, idleTimedOut: false };
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
      },
    };
    await new ClaudeCodeAdapter(runner).checkStatus();
    const initCall = seen.find((c) => c.args.includes('--input-format'));
    expect(initCall).toBeDefined();
    expect(initCall!.args).toContain('--bare');
    expect(initCall!.args).toContain('--no-session-persistence');
    expect(initCall!.cwd).toBe(os.tmpdir());
  });

  it('verifies real claude --bare skips project SessionStart hooks when claude is installed', () => {
    let claudeExists = false;
    try {
      execFileSync('which', ['claude'], { stdio: 'ignore' });
      claudeExists = true;
    } catch {
      claudeExists = false;
    }
    if (!claudeExists) return;

    const dir = makeTempDir('dalang-bare-hook-');
    const marker = path.join(dir, 'hook-triggered.txt');
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch "${marker}"` }] }] },
      }),
    );

    execFileSync(
      'claude',
      ['-p', '--bare', '--no-session-persistence', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
      {
        input: `${JSON.stringify({ type: 'control_request', request_id: 'bare-check', request: { subtype: 'initialize' } })}\n`,
        cwd: dir,
        encoding: 'utf8',
        timeout: 15_000,
      },
    );
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('snapshots dirty repo state into refs/dalang/checkpoints/* without polluting main branch commits', async () => {
    const repo = makeTempDir('dalang-hidden-ref-');
    const git = simpleGit(repo);
    await git.init(['--initial-branch=main']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# hello\n');
    const initial = await createGitCheckpoint(repo, 'initial');

    // Make an uncommitted change on main.
    fs.writeFileSync(path.join(repo, 'draft.txt'), 'uncommitted draft\n');
    const baseline = await ensureMainBaseline(repo, 'main');
    expect(baseline.baseMainSha).toBe(initial.commitSha);
    expect(baseline.checkpointRef).toMatch(/^refs\/dalang\/checkpoints\/baseline-/);

    // HEAD on main must NOT have advanced!
    expect(await getHeadCommit(repo)).toBe(initial.commitSha);

    const hidden = await createHiddenCheckpointRef(repo, 'test-snap', 'dalang: hidden test');
    const refs = await listHiddenCheckpointRefs(repo);
    expect(refs.some((r) => r.refName === hidden.refName && r.sha === hidden.commitSha)).toBe(true);
    // Hidden commit contains draft.txt even though HEAD does not.
    const captured = await git.raw(['show', `${hidden.refName}:draft.txt`]);
    expect(captured.trim()).toBe('uncommitted draft');
  });
});
