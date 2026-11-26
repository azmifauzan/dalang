import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProviderId } from '@dalang/shared';
import { redactSecrets } from '../adapters/logger.js';
import type { CliRunner, RunCommandOptions, RunCommandResult } from '../adapters/types.js';
import {
  detectProviderFromCommand,
  extractPromptAndModel,
  unwrapSandboxArgs,
  type ReplayTurnEntry,
} from './replay-runner.js';

/**
 * One recorded provider CLI invocation. The `match`, `stdoutLines`, `stderrLines`, and `exitCode`
 * fields form a `ReplayTurnEntry`, so a recording can be pasted into a replay transcript as is.
 */
export interface CliRecording extends ReplayTurnEntry {
  recordedAt: string;
  provider: ProviderId;
  command: string;
  args: string[];
  cwd: string;
  promptHead: string;
  durationMs: number;
  /** Milliseconds from spawn to the first stdout line; null when the CLI printed nothing. */
  firstStdoutMs: number | null;
  /** Milliseconds from spawn for each entry of `stdoutLines`. */
  stdoutTimesMs: number[];
  stdinData?: string;
  /** Writes made through `onSpawn().writeStdin` (session protocols: stream-json, app-server, ACP). */
  stdinWrites: Array<{ atMs: number; data: string }>;
  timedOut: boolean;
  idleTimedOut: boolean;
  aborted: boolean;
}

const SECRET_ENV_KEY = /TOKEN|SECRET|PASSWORD|API_KEY|AUTH/i;
const MAX_ARG_CHARS = 4000;

function secretsFrom(env: Record<string, string | undefined> | undefined): string[] {
  if (!env) return [];
  return Object.entries(env)
    .filter(([key, value]) => SECRET_ENV_KEY.test(key) && typeof value === 'string' && value.length >= 8)
    .map(([, value]) => value as string);
}

/**
 * Wraps the real runner and saves every claude, codex, and agy invocation to `dir` as JSON, one file
 * per invocation. Other commands (git, verify shells, gh) pass through unrecorded. Recording never
 * changes the run: a failed write only prints a warning.
 */
export class RecordingCliRunner implements CliRunner {
  readonly supportsInteractiveStdin: boolean | undefined;

  constructor(
    private readonly inner: CliRunner,
    private readonly dir: string,
  ) {
    this.supportsInteractiveStdin = inner.supportsInteractiveStdin;
  }

  which(binary: string): Promise<string | null> {
    return this.inner.which(binary);
  }

  async run(command: string, args: string[], options: RunCommandOptions): Promise<RunCommandResult> {
    const { innerCommand, innerArgs } = unwrapSandboxArgs(command, args);
    const provider = detectProviderFromCommand(innerCommand);
    if (!provider) return this.inner.run(command, args, options);

    const secrets = secretsFrom(options.env);
    const redact = (text: string) => redactSecrets(text, secrets);
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const stdoutLines: string[] = [];
    const stdoutTimesMs: number[] = [];
    const stderrLines: string[] = [];
    const stdinWrites: CliRecording['stdinWrites'] = [];

    const wrapped: RunCommandOptions = {
      ...options,
      onStdoutLine: (line) => {
        stdoutLines.push(redact(line));
        stdoutTimesMs.push(elapsed());
        options.onStdoutLine?.(line);
      },
      onStderrLine: (line) => {
        stderrLines.push(redact(line));
        options.onStderrLine?.(line);
      },
      onSpawn: options.onSpawn
        ? (controls) =>
            options.onSpawn!({
              ...controls,
              writeStdin: (data) => {
                stdinWrites.push({ atMs: elapsed(), data: redact(data) });
                controls.writeStdin(data);
              },
            })
        : undefined,
    };

    const result = await this.inner.run(command, args, wrapped);

    const { prompt, model } = extractPromptAndModel(provider, innerArgs);
    const recording: CliRecording = {
      recordedAt: new Date().toISOString(),
      provider,
      command: path.basename(innerCommand),
      args: innerArgs.map((a) => redact(a.length > MAX_ARG_CHARS ? `${a.slice(0, MAX_ARG_CHARS)}…` : a)),
      cwd: options.cwd,
      promptHead: redact(prompt.slice(0, 300)),
      durationMs: elapsed(),
      firstStdoutMs: stdoutTimesMs[0] ?? null,
      match: { provider, ...(model ? { model } : {}) },
      stdoutLines,
      stdoutTimesMs,
      stderrLines,
      exitCode: result.exitCode ?? 1,
      ...(options.stdinData ? { stdinData: redact(options.stdinData) } : {}),
      stdinWrites,
      timedOut: result.timedOut,
      idleTimedOut: result.idleTimedOut,
      aborted: result.aborted === true,
    };
    this.save(recording);
    return result;
  }

  private save(recording: CliRecording): void {
    const stamp = recording.recordedAt.replace(/[:.]/g, '-');
    const file = path.join(this.dir, `${stamp}-${recording.provider}-${crypto.randomUUID().slice(0, 8)}.json`);
    fs.promises
      .mkdir(this.dir, { recursive: true, mode: 0o700 })
      // Recordings hold prompts and code, so only the user can read them.
      .then(() => fs.promises.writeFile(file, JSON.stringify(recording, null, 2), { mode: 0o600 }))
      .catch((err: unknown) => {
        console.warn(`[dalang] could not save CLI recording: ${(err as Error).message}`);
      });
  }
}
