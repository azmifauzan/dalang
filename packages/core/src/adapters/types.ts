import type { EffortLevel, ProviderId, ProviderStatus, ProviderUsage } from '@dalang/shared';

export interface RunCommandOptions {
  cwd: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  stdinData?: string;
  interactiveStdin?: boolean;
  onSpawn?: (controls: { writeStdin: (data: string) => void; endStdin: () => void; kill: () => void }) => void;
  env?: Record<string, string | undefined>;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export interface RunCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  idleTimedOut: boolean;
}

export interface CliRunner {
  which(binary: string): Promise<string | null>;
  run(command: string, args: string[], options: RunCommandOptions): Promise<RunCommandResult>;
}

export interface AdapterTurnOptions {
  projectPath: string;
  prompt: string;
  sessionId?: string | null;
  model?: string | null;
  effort?: EffortLevel;
  outputFilePath?: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  logFilePath?: string;
  onLogLine?: (line: string) => void;
}

export interface AdapterTurnResult {
  text: string;
  sessionId: string | null;
  structuredOutput?: unknown;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  logFilePath?: string;
}

export interface CliAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly binary: string;
  checkStatus(): Promise<ProviderStatus>;
  getUsage(): Promise<ProviderUsage>;
  runTurn(options: AdapterTurnOptions): Promise<AdapterTurnResult>;
}
