import fs from 'node:fs';
import path from 'node:path';
import { z, type ZodType } from 'zod';
import type { AdapterTurnResult, CliAdapter } from '../adapters/types.js';
import { ensureDir, getProjectLogsDir, getProjectTmpDir } from '../paths.js';

export interface RunContractOptions<T> {
  adapter: CliAdapter;
  projectPath: string;
  sessionId?: string | null;
  model?: string | null;
  effort?: 'low' | 'medium' | 'high';
  prompt: string;
  targetFilePath: string;
  schema: ZodType<T>;
  schemaName: string;
  maxRetries?: number;
  onLogLine?: (line: string) => void;
}

export interface RunContractResult<T> {
  data: T;
  sessionId: string | null;
  attempts: number;
  lastTurn: AdapterTurnResult;
}

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const loc = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `${loc}: ${issue.message}`;
    })
    .join('; ');
}

export async function runContractTurn<T>(
  options: RunContractOptions<T>,
): Promise<RunContractResult<T>> {
  const maxRetries = options.maxRetries ?? 2;
  const tmpDir = getProjectTmpDir(options.projectPath);
  const logsDir = getProjectLogsDir(options.projectPath);
  ensureDir(tmpDir);
  ensureDir(logsDir);
  ensureDir(path.dirname(options.targetFilePath));

  const jsonSchema = z.toJSONSchema(options.schema) as Record<string, unknown>;
  const schemaFilePath = path.join(tmpDir, `${options.schemaName}.schema.json`);
  fs.writeFileSync(schemaFilePath, JSON.stringify(jsonSchema, null, 2), 'utf8');

  const logFilePath = path.join(
    logsDir,
    `${options.schemaName}-${Date.now()}.log`,
  );

  // A file left by an earlier run would pass validation without the agent writing anything.
  fs.rmSync(options.targetFilePath, { force: true });

  let currentSessionId = options.sessionId ?? null;
  let currentPrompt = options.prompt;
  let lastError = 'Output file was not created';
  let lastTurn: AdapterTurnResult | null = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const outFilePath = path.join(tmpDir, `${options.schemaName}-attempt-${attempt}.txt`);

    const turn = await options.adapter.runTurn({
      projectPath: options.projectPath,
      prompt: currentPrompt,
      sessionId: currentSessionId,
      model: options.model,
      effort: options.effort ?? 'high',
      jsonSchema,
      schemaFilePath,
      outputFilePath: outFilePath,
      logFilePath,
      onLogLine: options.onLogLine,
    });

    lastTurn = turn;
    if (turn.sessionId) {
      currentSessionId = turn.sessionId;
    }

    if (fs.existsSync(options.targetFilePath)) {
      const rawContent = fs.readFileSync(options.targetFilePath, 'utf8').trim();
      try {
        const parsedJson: unknown = JSON.parse(rawContent);
        const validated = options.schema.safeParse(parsedJson);
        if (validated.success) {
          return {
            data: validated.data,
            sessionId: currentSessionId,
            attempts: attempt,
            lastTurn: turn,
          };
        }
        lastError = `Zod validation error: ${formatZodError(validated.error)}`;
      } catch (err) {
        lastError = `Invalid JSON in ${path.relative(options.projectPath, options.targetFilePath)}: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    } else {
      lastError = `Expected file was not written at ${path.relative(
        options.projectPath,
        options.targetFilePath,
      )}`;
    }

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

  throw new Error(
    `Agent output failed validation after ${maxRetries + 1} attempts: ${lastError}` +
      (lastTurn?.stderr ? ` (${lastTurn.stderr.slice(0, 200)})` : ''),
  );
}
