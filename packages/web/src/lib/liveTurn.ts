import { liveReplyText, parseLiveReply, parseTurnLogSignal, type TurnPhase, type TurnProgressEventPayload, type TurnStepDTO } from '@dalang/shared';

export type LiveActivityKind = 'read' | 'search' | 'edit' | 'run' | 'think' | 'other';

export interface LiveActivity {
  kind: LiveActivityKind;
  target?: string;
}

export interface LiveTurn {
  role?: string;
  profileName?: string;
  model?: string | null;
  phase: TurnPhase;
  activity: LiveActivity | null;
  steps: TurnStepDTO[];
  progressMessages: string[];
  /** Raw streamed answer text (may contain JSON contract wrapper; `displayLiveText` extracts the readable reply). */
  text: string;
}

export const EMPTY_LIVE_TURN: LiveTurn = {
  phase: 'starting',
  activity: null,
  steps: [],
  progressMessages: [],
  text: '',
};

function upsertStep(steps: TurnStepDTO[], incoming: TurnStepDTO): TurnStepDTO[] {
  const idx = steps.findIndex((s) => s.id === incoming.id);
  if (idx === -1) {
    return [...steps.slice(-24), incoming];
  }
  const prev = steps[idx];
  const merged: TurnStepDTO = {
    ...prev,
    ...incoming,
    target: incoming.target ?? prev.target,
    startedAt: prev.startedAt,
    durationMs:
      incoming.durationMs ??
      (incoming.status !== 'running'
        ? Math.max(0, Date.now() - Date.parse(prev.startedAt))
        : prev.durationMs),
  };
  const next = [...steps];
  next[idx] = merged;
  return next;
}

function appendProgress(list: string[], msg: string): string[] {
  const clean = msg.trim();
  if (!clean) return list;
  if (list[list.length - 1] === clean) return list;
  return [...list.slice(-15), clean];
}

export function applyTurnProgress(turn: LiveTurn, event: TurnProgressEventPayload): LiveTurn {
  let steps = turn.steps;
  let activity = turn.activity;
  if (event.step) {
    steps = upsertStep(steps, event.step);
    activity =
      event.step.status === 'running'
        ? { kind: event.step.kind, target: event.step.target ?? event.step.label }
        : activity;
  }
  const progressMessages = event.progressText
    ? appendProgress(turn.progressMessages, event.progressText)
    : turn.progressMessages;

  return {
    ...turn,
    role: event.role,
    profileName: event.profileName,
    model: event.model,
    phase: event.phase,
    activity,
    steps,
    progressMessages,
  };
}

export function applyTextDelta(turn: LiveTurn, chunk: string, reset = false): LiveTurn {
  const raw = reset ? chunk : turn.text + chunk;
  const parsed = parseLiveReply(raw);
  const progressMessages = parsed.progress
    ? appendProgress(turn.progressMessages, parsed.progress)
    : turn.progressMessages;
  return {
    ...turn,
    phase: parsed.answer.trim() ? 'streaming' : turn.phase === 'starting' ? 'working' : turn.phase,
    activity: parsed.answer.trim() ? null : turn.activity,
    progressMessages,
    text: raw,
  };
}

export function applyLogLine(turn: LiveTurn, line: string): LiveTurn {
  const signal = parseTurnLogSignal(line);
  if (!signal) return turn;
  const nowIso = new Date().toISOString();
  let steps = turn.steps;
  let activity = turn.activity;
  if (signal.step) {
    const step: TurnStepDTO = { ...signal.step, startedAt: nowIso };
    steps = upsertStep(steps, step);
    activity =
      step.status === 'running'
        ? { kind: step.kind, target: step.target ?? step.label }
        : activity;
  }
  const progressMessages = signal.progressText
    ? appendProgress(turn.progressMessages, signal.progressText)
    : turn.progressMessages;
  const text = signal.textDelta
    ? turn.text + signal.textDelta
    : signal.answerText && !turn.text
      ? signal.answerText
      : turn.text;

  return {
    ...turn,
    phase: signal.phase ?? turn.phase,
    activity,
    steps,
    progressMessages,
    text,
  };
}

/** The text to show while the turn runs, or an empty string when it would be raw JSON. */
export function displayLiveText(turn: LiveTurn): string {
  return liveReplyText(turn.text);
}
