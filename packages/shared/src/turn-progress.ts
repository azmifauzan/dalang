import { parseLiveReply } from './live-reply.js';
import type { ProviderId } from './schemas.js';

export type TurnPhase = 'starting' | 'resuming' | 'working' | 'streaming' | 'completed' | 'failed';

export type TurnRole = 'lead' | 'executor' | 'fix' | 'reviewer';

export type TurnStepKind = 'read' | 'search' | 'edit' | 'run' | 'think' | 'other';

export interface TurnStepDTO {
  id: string;
  kind: TurnStepKind;
  label: string;
  target?: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  durationMs?: number;
  exitCode?: number | null;
}

export interface TurnProgressEventPayload {
  projectId: string;
  sessionId?: string;
  runId: string;
  taskId?: string;
  taskExternalId?: string;
  role: TurnRole;
  profileName: string;
  provider: ProviderId;
  model: string | null;
  phase: TurnPhase;
  step?: TurnStepDTO;
  progressText?: string;
  startedAt: string;
}

export interface ParsedTurnSignal {
  phase?: TurnPhase;
  step?: Omit<TurnStepDTO, 'startedAt'>;
  progressText?: string;
  answerText?: string;
  textDelta?: string;
}

const MAX_SAFE_TARGET = 120;

function sanitizeTarget(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\b(Bearer\s+)[^\s"',;]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[a-zA-Z0-9_-]+/g, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return undefined;
  return clean.length > MAX_SAFE_TARGET ? `${clean.slice(0, MAX_SAFE_TARGET - 1)}…` : clean;
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function classifyTool(name: string, input: unknown, id = 'tool'): Omit<TurnStepDTO, 'startedAt'> {
  const args = isObj(input) ? input : {};
  const firstStr = Object.values(args).find((v) => typeof v === 'string' && v.trim());
  const target =
    sanitizeTarget(args.file_path) ??
    sanitizeTarget(args.path) ??
    sanitizeTarget(args.Path) ??
    sanitizeTarget(args.CommandLine) ??
    sanitizeTarget(args.command) ??
    sanitizeTarget(args.pattern) ??
    sanitizeTarget(args.query) ??
    sanitizeTarget(firstStr);
  const lower = name.toLowerCase();
  if (/read|view|open/.test(lower)) return { id, kind: 'read', label: 'Reading', target, status: 'running' };
  if (/grep|glob|find|search|list|^ls$/.test(lower)) return { id, kind: 'search', label: 'Searching', target, status: 'running' };
  if (/edit|write|patch|replace/.test(lower)) return { id, kind: 'edit', label: 'Editing', target, status: 'running' };
  if (/bash|run|exec|command|shell/.test(lower)) return { id, kind: 'run', label: 'Running', target, status: 'running' };
  const human = name.replace(/[_-]+/g, ' ').trim() || 'Tool';
  return { id, kind: 'other', label: human, target, status: 'running' };
}

/**
 * Extracts structured waiting-view signals (phase, step with safe target, progress text)
 * from a single provider or `[dalang]` log line.
 */
export function parseTurnLogSignal(rawLine: string): ParsedTurnSignal | null {
  const trimmed = rawLine.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\s+/, '').trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('[dalang] Preparing worktree:')) {
    return {
      phase: 'working',
      step: {
        id: 'setup-worktree',
        kind: 'run',
        label: 'Preparing worktree',
        target: sanitizeTarget(trimmed.slice('[dalang] Preparing worktree:'.length)),
        status: 'running',
      },
    };
  }
  if (trimmed.startsWith('[dalang] Running verify command:')) {
    return {
      phase: 'working',
      step: {
        id: 'verify',
        kind: 'run',
        label: 'Running verify',
        target: sanitizeTarget(trimmed.slice('[dalang] Running verify command:'.length)),
        status: 'running',
      },
    };
  }
  if (trimmed.startsWith('[dalang] Verify command exited with code ')) {
    const code = Number(trimmed.slice('[dalang] Verify command exited with code '.length).trim());
    return {
      phase: 'working',
      step: {
        id: 'verify',
        kind: 'run',
        label: 'Verify',
        status: code === 0 ? 'completed' : 'failed',
        exitCode: Number.isFinite(code) ? code : null,
      },
    };
  }

  if (!trimmed.startsWith('{')) return null;
  let ev: unknown;
  try {
    ev = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isObj(ev)) return null;

  // Claude stream-json init
  if (ev.type === 'system' && ev.subtype === 'init') {
    return { phase: 'working' };
  }

  // Claude stream-json assistant blocks
  if (ev.type === 'assistant' && isObj(ev.message) && Array.isArray(ev.message.content)) {
    for (let i = ev.message.content.length - 1; i >= 0; i--) {
      const block = ev.message.content[i];
      if (!isObj(block)) continue;
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        const id = typeof block.id === 'string' ? block.id : `tool-${i}`;
        return { phase: 'working', step: classifyTool(block.name, block.input, id) };
      }
      if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        return { phase: 'working', step: { id: 'thinking', kind: 'think', label: 'Thinking', status: 'running' } };
      }
      if (block.type === 'text' && typeof block.text === 'string') {
        const parsed = parseLiveReply(block.text);
        return {
          phase: parsed.answer ? 'streaming' : 'working',
          ...(parsed.progress ? { progressText: parsed.progress } : {}),
          ...(parsed.answer ? { answerText: parsed.answer } : {}),
        };
      }
    }
  }

  // Codex thread.started
  if (ev.type === 'thread.started') {
    return { phase: 'working' };
  }

  // Codex items
  if ((ev.type === 'item.started' || ev.type === 'item.updated' || ev.type === 'item.completed') && isObj(ev.item)) {
    const item = ev.item;
    const itemId = typeof item.id === 'string' ? item.id : `item-${String(item.type ?? 'step')}`;
    const done = ev.type === 'item.completed';
    const exitCode = typeof item.exit_code === 'number'
      ? item.exit_code
      : typeof item.exitCode === 'number'
        ? item.exitCode
        : null;
    const status: TurnStepDTO['status'] = done
      ? exitCode !== null && exitCode !== 0 ? 'failed' : 'completed'
      : 'running';

    if (item.type === 'command_execution') {
      return {
        phase: 'working',
        step: {
          id: itemId,
          kind: 'run',
          label: 'Running command',
          target: sanitizeTarget(item.command),
          status,
          exitCode,
        },
      };
    }
    if (item.type === 'file_change') {
      return {
        phase: 'working',
        step: {
          id: itemId,
          kind: 'edit',
          label: 'Editing files',
          target: sanitizeTarget(item.path ?? item.file),
          status,
        },
      };
    }
    if (item.type === 'reasoning') {
      return {
        phase: 'working',
        step: { id: itemId, kind: 'think', label: 'Thinking', status },
      };
    }
    if (item.type === 'mcp_tool_call') {
      return {
        phase: 'working',
        step: { ...classifyTool(String(item.tool ?? 'tool'), item.arguments, itemId), status },
      };
    }
    if (item.type === 'agent_message' && typeof item.text === 'string') {
      const parsed = parseLiveReply(item.text);
      return {
        phase: parsed.answer ? 'streaming' : 'working',
        ...(parsed.progress ? { progressText: parsed.progress } : {}),
        ...(parsed.answer ? { answerText: parsed.answer } : {}),
      };
    }
  }

  // Antigravity ACP updates
  if (ev.sessionUpdate === 'tool_call' || ev.sessionUpdate === 'tool_call_update') {
    const id = typeof ev.toolCallId === 'string' ? ev.toolCallId : 'acp-tool';
    const rawStatus = typeof ev.status === 'string' ? ev.status.toLowerCase() : 'in_progress';
    const status: TurnStepDTO['status'] =
      rawStatus === 'completed' || rawStatus === 'done'
        ? 'completed'
        : rawStatus === 'failed' || rawStatus === 'error'
          ? 'failed'
          : 'running';
    const base = classifyTool(String(ev.name ?? ev.title ?? 'tool'), ev.args ?? ev.rawInput, id);
    return {
      phase: 'working',
      step: { ...base, target: base.target ?? sanitizeTarget(ev.title), status },
    };
  }
  if (ev.sessionUpdate === 'agent_thought_chunk') {
    return { phase: 'working', step: { id: 'acp-think', kind: 'think', label: 'Thinking', status: 'running' } };
  }
  if (ev.sessionUpdate === 'agent_message_chunk') {
    return { phase: 'streaming' };
  }

  // Antigravity headless step_update
  if (ev.event === 'step_update' && isObj(ev.step_update)) {
    const step = ev.step_update;
    const type = typeof step.step_type === 'string' ? step.step_type : '';
    if (type === 'tool') {
      const state = typeof step.state === 'string' ? step.state : '';
      const status: TurnStepDTO['status'] = state === 'ACTIVE' ? 'running' : state === 'FAILED' ? 'failed' : 'completed';
      const params = isObj(step.tool_info) ? step.tool_info.parameters : undefined;
      return {
        phase: 'working',
        step: { ...classifyTool(String(step.tool_name ?? 'tool'), params, `step-${String(step.step_id ?? 'tool')}`), status },
      };
    }
    if (type === 'thinking') {
      return { phase: 'working', step: { id: 'agy-think', kind: 'think', label: 'Thinking', status: 'running' } };
    }
    if (type === 'agent_response') {
      const delta = typeof step.text_delta === 'string' ? step.text_delta : undefined;
      return {
        phase: 'streaming',
        ...(delta ? { textDelta: delta } : {}),
      };
    }
  }

  return null;
}
