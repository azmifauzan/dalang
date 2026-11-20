/**
 * A readable view of what a CLI is doing, built from its raw log lines.
 * Each CLI writes its own JSON events (Claude Code stream-json, Codex JSONL, Antigravity step updates);
 * anything unrecognized is ignored, so the raw log stays available but never leads the screen.
 */
export type LiveActivityKind = 'read' | 'search' | 'run' | 'think' | 'other';

export interface LiveActivity {
  kind: LiveActivityKind;
  /** A file, pattern, command, or step name, shortened for display. */
  target?: string;
}

export interface LiveTurn {
  activity: LiveActivity | null;
  /** The answer so far, when the CLI streams plain text. */
  text: string;
}

export const EMPTY_LIVE_TURN: LiveTurn = { activity: null, text: '' };

// Long enough to keep a whole path; the screen shortens it after dropping the project folder.
const MAX_TARGET = 400;

function short(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const one = value.replace(/\s+/g, ' ').trim();
  return one.length > MAX_TARGET ? `${one.slice(0, MAX_TARGET - 1)}…` : one;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toolActivity(name: string, input: unknown): LiveActivity {
  const args = isRecord(input) ? input : {};
  // Claude names its arguments; other CLIs vary, so fall back to the first text argument.
  const firstText = Object.values(args).find((v) => typeof v === 'string' && v.trim());
  const target =
    short(args.file_path) ??
    short(args.path) ??
    short(args.pattern) ??
    short(args.query) ??
    short(args.command) ??
    short(firstText);
  const lower = name.toLowerCase();
  if (/read|view|open/.test(lower)) return { kind: 'read', target };
  if (/grep|glob|find|search|list|^ls$/.test(lower)) return { kind: 'search', target };
  if (/bash|run|exec|command|shell/.test(lower)) return { kind: 'run', target };
  return { kind: 'other', target: target ? `${humanize(name)} ${target}` : humanize(name) };
}

function humanize(stepType: string): string {
  return stepType.replace(/[_-]+/g, ' ').trim();
}

/** Only plain prose is worth showing live; a JSON reply is shown once it is finished and parsed. */
function looksLikeJson(text: string): boolean {
  return text.trimStart().startsWith('{');
}

export function applyLogLine(turn: LiveTurn, line: string): LiveTurn {
  if (!line.startsWith('{')) return turn;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return turn;
  }
  if (!isRecord(event)) return turn;

  // Antigravity: {"event":"step_update","step_update":{"step_type","state","text_delta"}}
  if (event.event === 'step_update' && isRecord(event.step_update)) {
    const step = event.step_update;
    const type = typeof step.step_type === 'string' ? step.step_type : '';
    if (type === 'user_input') return turn;
    if (type === 'tool') {
      if (step.state !== 'ACTIVE') return turn;
      const name = typeof step.tool_name === 'string' ? step.tool_name : '';
      const params = isRecord(step.tool_info) ? step.tool_info.parameters : undefined;
      return { ...turn, activity: toolActivity(name, params) };
    }
    if (type === 'agent_response') {
      const delta = typeof step.text_delta === 'string' ? step.text_delta : '';
      return { activity: null, text: turn.text + delta };
    }
    return type ? { ...turn, activity: { kind: 'other', target: humanize(type) } } : turn;
  }

  // Claude Code stream-json: assistant messages hold text and tool_use blocks.
  if (event.type === 'assistant' && isRecord(event.message) && Array.isArray(event.message.content)) {
    let next = turn;
    for (const block of event.message.content) {
      if (!isRecord(block)) continue;
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        next = { ...next, activity: toolActivity(block.name, block.input) };
      } else if (block.type === 'thinking') {
        next = { ...next, activity: { kind: 'think' } };
      } else if (block.type === 'text' && typeof block.text === 'string') {
        next = { activity: null, text: next.text ? `${next.text}\n\n${block.text}` : block.text };
      }
    }
    return next;
  }

  // Codex JSONL: items such as command_execution, reasoning, and agent_message.
  if (isRecord(event.item) && typeof event.item.type === 'string') {
    const item = event.item;
    if (item.type === 'command_execution') {
      return { ...turn, activity: { kind: 'run', target: short(item.command) } };
    }
    if (item.type === 'reasoning') return { ...turn, activity: { kind: 'think' } };
    if (item.type === 'agent_message' && typeof item.text === 'string') {
      return { activity: null, text: item.text };
    }
  }

  return turn;
}

/** The text to show while the turn runs, or an empty string when it would be raw JSON. */
export function displayLiveText(turn: LiveTurn): string {
  return looksLikeJson(turn.text) ? '' : turn.text;
}
