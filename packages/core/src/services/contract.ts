import fs from 'node:fs';
import path from 'node:path';
import { z, type ZodType } from 'zod';
import type { EffortLevel } from '@dalang/shared';
import type { AdapterTurnResult, CliAdapter, TurnTokenUsage } from '../adapters/types.js';
import { getProjectLogsDir, getProjectTmpDir } from '../paths.js';
import { ensureProjectDir, readArtifactFile, removeArtifactFile } from '../safe-fs.js';
import { mergeTokenUsage } from './pricing.js';

export interface RunContractOptions<T> {
  adapter: CliAdapter;
  projectPath: string;
  sessionId?: string | null;
  model?: string | null;
  effort?: EffortLevel;
  prompt: string;
  targetFilePath: string;
  schema: ZodType<T>;
  schemaName: string;
  maxRetries?: number;
  logsDir?: string;
  tmpDir?: string;
  onLogLine?: (line: string) => void;
}

export interface RunContractResult<T> {
  data: T;
  sessionId: string | null;
  attempts: number;
  lastTurn: AdapterTurnResult;
  usage?: TurnTokenUsage;
  logFilePath: string;
}

function isLink(target: string): boolean {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const loc = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `${loc}: ${issue.message}`;
    })
    .join('; ');
}

type Validation<T> = { ok: true; data: T } | { ok: false; error: string };

function readAndValidate<T>(options: RunContractOptions<T>): Validation<T> {
  const rel = path.relative(options.projectPath, options.targetFilePath);
  if (!fs.existsSync(options.targetFilePath) && !isLink(options.targetFilePath)) {
    return { ok: false, error: `Expected file was not written at ${rel}` };
  }

  let raw: string;
  try {
    raw = readArtifactFile(options.projectPath, options.targetFilePath).trim();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The parser message can quote file content, so it is never sent back to the agent.
    return { ok: false, error: `${rel} is not valid JSON.` };
  }

  const validated = options.schema.safeParse(parsed);
  return validated.success
    ? { ok: true, data: validated.data }
    : { ok: false, error: `Zod validation error: ${formatZodError(validated.error)}` };
}

export async function runContractTurn<T>(
  options: RunContractOptions<T>,
): Promise<RunContractResult<T>> {
  const maxRetries = options.maxRetries ?? 2;
  const tmpDir = options.tmpDir ?? getProjectTmpDir(options.projectPath);
  const logsDir = options.logsDir ?? getProjectLogsDir(options.projectPath);
  ensureProjectDir(options.projectPath, tmpDir);
  ensureProjectDir(options.projectPath, logsDir);
  ensureProjectDir(options.projectPath, path.dirname(options.targetFilePath));

  // The schema goes into the retry prompt only. The CLIs' own schema flags constrain the final chat
  // message (and reject optional or defaulted fields), while the contract is the file the agent writes.
  const jsonSchema = z.toJSONSchema(options.schema);

  const logFilePath = path.join(
    logsDir,
    `${options.schemaName}-${Date.now()}.log`,
  );

  // A file left by an earlier run would pass validation without the agent writing anything.
  removeArtifactFile(options.projectPath, options.targetFilePath);

  let currentSessionId = options.sessionId ?? null;
  let currentPrompt = options.prompt;
  let lastError = 'Output file was not created';
  let lastTurn: AdapterTurnResult | null = null;
  let totalUsage: TurnTokenUsage | undefined;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const outFilePath = path.join(tmpDir, `${options.schemaName}-attempt-${attempt}.txt`);

    let turn: AdapterTurnResult;
    try {
      turn = await options.adapter.runTurn({
        projectPath: options.projectPath,
        prompt: currentPrompt,
        sessionId: currentSessionId,
        model: options.model,
        effort: options.effort ?? 'high',
        outputFilePath: outFilePath,
        logFilePath,
        onLogLine: options.onLogLine,
      });
    } catch (err) {
      if (err && typeof err === 'object') {
        Object.assign(err, { usage: totalUsage, logFilePath });
      }
      throw err;
    }

    lastTurn = turn;
    totalUsage = mergeTokenUsage(totalUsage, turn.usage);
    if (turn.sessionId) {
      currentSessionId = turn.sessionId;
    }

    const outcome = readAndValidate(options);
    if (outcome.ok) {
      return {
        data: outcome.data,
        sessionId: currentSessionId,
        attempts: attempt,
        lastTurn: turn,
        ...(totalUsage ? { usage: totalUsage } : {}),
        logFilePath,
      };
    }
    lastError = outcome.error;

    if (attempt <= maxRetries) {
      const relTarget = path.relative(options.projectPath, options.targetFilePath);
      currentPrompt = [
        `Your previous output failed contract validation:`,
        `${lastError}`,
        ``,
        `Please fix the JSON and write a valid JSON file directly to "${relTarget}" matching this JSON Schema:`,
        JSON.stringify(jsonSchema, null, 2),
      ].join('\n');
    }
  }

  const finalErr = new Error(
    `Agent output failed validation after ${maxRetries + 1} attempts: ${lastError}` +
      (lastTurn?.stderr ? ` (${lastTurn.stderr.slice(0, 200)})` : ''),
  );
  Object.assign(finalErr, { usage: totalUsage, logFilePath });
  throw finalErr;
}
