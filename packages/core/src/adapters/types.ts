import type { ChatImage, EffortLevel, ProviderId, ProviderStatus, ProviderUsage } from '@dalang/shared';

export interface RunCommandOptions {
  cwd: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
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
  aborted?: boolean;
}

export interface CliRunner {
  which(binary: string): Promise<string | null>;
  run(command: string, args: string[], options: RunCommandOptions): Promise<RunCommandResult>;
}

export interface AdapterTurnOptions {
  projectPath: string;
  prompt: string;
  images?: TurnImage[];
  sessionId?: string | null;
  model?: string | null;
  effort?: EffortLevel;
  permissionMode?: 'workspace-write' | 'read-only' | 'accept-edits';
  configDir?: string | null;
  outputFilePath?: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  logFilePath?: string;
  onLogLine?: (line: string) => void;
}

export interface TurnImage {
  mimeType: ChatImage['mimeType'];
  data: Buffer;
}

export interface TurnTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  model?: string | null;
}

export interface AdapterTurnResult {
  text: string;
  sessionId: string | null;
  structuredOutput?: unknown;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  logFilePath?: string;
  aborted?: boolean;
  rateLimitReason?: string;
  usage?: TurnTokenUsage;
}

export interface CliAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly binary: string;
  checkStatus(configDir?: string | null): Promise<ProviderStatus>;
  getUsage(configDir?: string | null): Promise<ProviderUsage>;
  runTurn(options: AdapterTurnOptions): Promise<AdapterTurnResult>;
}
