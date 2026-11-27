#!/usr/bin/env node
// Reads CLI recordings saved with DALANG_RECORD_DIR.
//   node packages/core/scripts/recordings.mjs summary <dir>
//   node packages/core/scripts/recordings.mjs transcript <dir> <name> [--provider codex] > transcript.json
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function isFiniteNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseFrame(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return line;
    }
  }
  return line;
}

function recordingLabel(recording) {
  if (typeof recording?.file === 'string' && recording.file.length > 0) {
    return recording.file;
  }
  if (typeof recording?.id === 'string' && recording.id.length > 0) {
    return recording.id;
  }
  return 'recording';
}

function collectRawStdinText(recording) {
  if (Array.isArray(recording?.events) && recording.events.length > 0) {
    return recording.events
      .filter((event) => event && event.direction === 'stdin' && typeof event.data === 'string')
      .map((event) => event.data)
      .join('');
  }
  if (Array.isArray(recording?.stdinWrites)) {
    return recording.stdinWrites
      .filter((write) => write && typeof write.data === 'string')
      .map((write) => write.data)
      .join('');
  }
  return '';
}

/**
 * Reassembles chunked stdin writes into complete newline-delimited frames.
 * A frame inherits the `atMs` of the write chunk that completed it (never fabricating a missing timestamp).
 */
export function reassembleStdinWrites(rawWrites) {
  if (!Array.isArray(rawWrites) || rawWrites.length === 0) return [];

  const frames = [];
  let buffer = '';
  let lastWriteAtMs;

  for (const write of rawWrites) {
    if (!write || typeof write.data !== 'string') continue;
    const atMs = isFiniteNonNegativeNumber(write.atMs) ? write.atMs : undefined;
    lastWriteAtMs = atMs;
    buffer += write.data;
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      if (part.trim().length > 0) {
        frames.push({
          data: part,
          ...(atMs !== undefined ? { atMs } : {}),
        });
      }
    }
  }

  const trailing = buffer.trim();
  if (trailing.length > 0) {
    frames.push({
      data: trailing,
      ...(lastWriteAtMs !== undefined ? { atMs: lastWriteAtMs } : {}),
    });
  }

  return frames;
}

// Health checks (version, models, auth, usage, codex rate-limit probes) are short probes, not turns.
export function isTurnRecording(recording) {
  const args = Array.isArray(recording?.args) ? recording.args : [];
  if (/--version|^models$|auth status|login status|debug models|\/usage|--bare/.test(args.join(' '))) {
    return false;
  }
  if (recording?.provider === 'codex' && args[0] === 'app-server') {
    const stdinText = collectRawStdinText(recording);
    if (stdinText.includes('account/rateLimits/read') && !/thread\/(start|resume)/.test(stdinText)) {
      return false;
    }
  }
  return true;
}

function buildExitEntry(recording) {
  return {
    type: 'exit',
    exitCode: typeof recording?.exitCode === 'number' ? recording.exitCode : 0,
    ...(recording?.timedOut ? { timedOut: true } : {}),
    ...(recording?.idleTimedOut ? { idleTimedOut: true } : {}),
    ...(recording?.aborted ? { aborted: true } : {}),
  };
}

function hasNonEmptyStdinWrites(recording) {
  return reassembleStdinWrites(recording?.stdinWrites).length > 0;
}

function hasNonEmptyEventsStdin(events) {
  let buffer = '';
  for (const event of events) {
    if (event.direction !== 'stdin') continue;
    buffer += event.data;
    if (buffer.trim().length > 0) return true;
  }
  return false;
}

function validateEventsArray(recording) {
  const label = recordingLabel(recording);
  const events = recording.events;
  if (!Array.isArray(events)) {
    throw new Error(`Cannot convert recording "${label}": events must be an array.`);
  }

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (!event || typeof event !== 'object') {
      throw new Error(`Cannot convert recording "${label}": invalid event at index ${i}.`);
    }
    if (event.direction !== 'stdin' && event.direction !== 'stdout' && event.direction !== 'stdin_end') {
      throw new Error(
        `Cannot convert recording "${label}": invalid event direction at index ${i} (expected "stdin", "stdout", or "stdin_end").`,
      );
    }
    if (event.direction === 'stdin_end') {
      if (event.data !== undefined && event.data !== '') {
        throw new Error(`Cannot convert recording "${label}": stdin_end event at index ${i} must not carry data.`);
      }
    } else if (typeof event.data !== 'string') {
      throw new Error(`Cannot convert recording "${label}": event data at index ${i} must be a string.`);
    }
    if (event.atMs !== undefined && !isFiniteNonNegativeNumber(event.atMs)) {
      throw new Error(
        `Cannot convert recording "${label}": invalid event timestamp at index ${i} (expected non-negative finite number).`,
      );
    }
  }

  const hasStdinInWrites = hasNonEmptyStdinWrites(recording);
  const eventsStdinText = events
    .filter((event) => event.direction === 'stdin')
    .map((event) => event.data)
    .join('');
  if (hasStdinInWrites) {
    const writesStdinText = recording.stdinWrites
      .filter((write) => write && typeof write.data === 'string')
      .map((write) => write.data)
      .join('');
    if (eventsStdinText !== writesStdinText) {
      throw new Error(
        `Cannot convert interactive recording "${label}": events stdin payload does not match stdinWrites.`,
      );
    }
  }

  const stdoutLines = Array.isArray(recording.stdoutLines) ? recording.stdoutLines : [];
  const eventsStdoutLines = events
    .filter((event) => event.direction === 'stdout')
    .map((event) => event.data);
  if (
    stdoutLines.length > 0 &&
    (eventsStdoutLines.length !== stdoutLines.length ||
      eventsStdoutLines.some((line, index) => line !== stdoutLines[index]))
  ) {
    throw new Error(
      `Cannot convert recording "${label}": events stdout lines do not match stdoutLines.`,
    );
  }

  return events;
}

function convertOrderedEventsToEntries(events, recording) {
  const label = recordingLabel(recording);
  const entries = [];
  let stdinBuffer = '';
  let lastStdinAtMs;
  let lastEmittedAtMs = 0;
  let sawStdoutAfterPendingStdin = false;

  const pushInbound = (line, atMs) => {
    if (stdinBuffer.trim().length > 0) {
      sawStdoutAfterPendingStdin = true;
    }
    let afterMs;
    if (atMs !== undefined && lastEmittedAtMs !== undefined) {
      const delta = atMs - lastEmittedAtMs;
      if (Number.isFinite(delta) && delta > 0) {
        afterMs = delta;
      }
    }
    entries.push({
      type: 'emit_inbound',
      frame: parseFrame(line),
      ...(afterMs !== undefined ? { afterMs } : {}),
    });
    lastEmittedAtMs = atMs;
  };

  for (const event of events) {
    const atMs = event.atMs !== undefined ? event.atMs : undefined;
    if (event.direction === 'stdin') {
      lastStdinAtMs = atMs;
      stdinBuffer += event.data;
      const parts = stdinBuffer.split(/\r?\n/);
      stdinBuffer = parts.pop() ?? '';
      let emittedAny = false;
      for (const part of parts) {
        if (part.trim().length > 0) {
          entries.push({
            type: 'expect_outbound',
            frame: parseFrame(part),
          });
          emittedAny = true;
        }
      }
      if (emittedAny) {
        lastEmittedAtMs = atMs;
      }
      if (parts.length > 0 || stdinBuffer.trim().length === 0) {
        sawStdoutAfterPendingStdin = false;
      }
    } else if (event.direction === 'stdin_end') {
      const trailing = stdinBuffer.trim();
      stdinBuffer = '';
      sawStdoutAfterPendingStdin = false;
      if (trailing.length > 0) {
        entries.push({
          type: 'expect_outbound',
          frame: parseFrame(trailing),
        });
        lastEmittedAtMs = atMs;
      }
    } else {
      pushInbound(event.data, atMs);
    }
  }

  const trailing = stdinBuffer.trim();
  if (trailing.length > 0) {
    if (sawStdoutAfterPendingStdin) {
      throw new Error(
        `Cannot convert interactive recording "${label}": unterminated stdin frame is followed by stdout without a newline or stdin_end event, so its cross-direction position cannot be determined.`,
      );
    }
    entries.push({
      type: 'expect_outbound',
      frame: parseFrame(trailing),
    });
    lastEmittedAtMs = lastStdinAtMs;
  }

  entries.push(buildExitEntry(recording));
  return entries;
}

function findUnterminatedTrailingStdinStartMs(rawWrites) {
  if (!Array.isArray(rawWrites) || rawWrites.length === 0) return null;
  let buffer = '';
  let pendingStartAtMs = null;
  for (const write of rawWrites) {
    if (!write || typeof write.data !== 'string') continue;
    const atMs = isFiniteNonNegativeNumber(write.atMs) ? write.atMs : undefined;
    const prevHadContent = buffer.trim().length > 0;
    buffer += write.data;
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? '';
    if (parts.length > 0) {
      pendingStartAtMs = buffer.trim().length > 0 ? (atMs ?? 0) : null;
    } else if (!prevHadContent && buffer.trim().length > 0) {
      pendingStartAtMs = atMs ?? 0;
    }
  }
  return buffer.trim().length > 0 ? pendingStartAtMs : null;
}

function mergeLegacyInteractiveStreams(recording) {
  const label = recordingLabel(recording);
  const rawWrites = Array.isArray(recording.stdinWrites) ? recording.stdinWrites : [];
  const stdinFrames = reassembleStdinWrites(rawWrites);
  const stdoutLines = Array.isArray(recording.stdoutLines) ? recording.stdoutLines : [];

  // Single-direction interactive recording (e.g. client wrote stdin then process exited with no stdout).
  if (stdoutLines.length === 0) {
    let prevStdinAtMs;
    for (let i = 0; i < rawWrites.length; i++) {
      const w = rawWrites[i];
      if (!w || typeof w.data !== 'string' || w.atMs === undefined) continue;
      if (!isFiniteNonNegativeNumber(w.atMs)) {
        throw new Error(
          `Cannot convert interactive recording "${label}": invalid stdinWrites[${i}].atMs without an ordered events log.`,
        );
      }
      if (prevStdinAtMs !== undefined && w.atMs < prevStdinAtMs) {
        throw new Error(
          `Cannot convert interactive recording "${label}": non-monotonic stdinWrites timestamps (${w.atMs}ms < ${prevStdinAtMs}ms) without an ordered events log.`,
        );
      }
      prevStdinAtMs = w.atMs;
    }
    return stdinFrames.map((frame) => ({
      direction: 'stdin',
      data: `${frame.data}\n`,
      ...(frame.atMs !== undefined ? { atMs: frame.atMs } : {}),
    }));
  }

  // Both stdin and stdout are present without an explicit `events` log: require complete,
  // monotonic, non-colliding timestamps so we never guess cross-direction ordering.
  const stdoutTimesMs = recording.stdoutTimesMs;
  if (!Array.isArray(stdoutTimesMs) || stdoutTimesMs.length !== stdoutLines.length) {
    throw new Error(
      `Cannot convert interactive recording "${label}": missing or incomplete stdoutTimesMs without an ordered events log.`,
    );
  }

  const stdoutTimestampSet = new Set();
  for (let i = 0; i < stdoutTimesMs.length; i++) {
    const t = stdoutTimesMs[i];
    if (!isFiniteNonNegativeNumber(t)) {
      throw new Error(
        `Cannot convert interactive recording "${label}": invalid stdoutTimesMs[${i}] without an ordered events log.`,
      );
    }
    if (i > 0 && t < stdoutTimesMs[i - 1]) {
      throw new Error(
        `Cannot convert interactive recording "${label}": non-monotonic stdoutTimesMs timestamps (${t}ms < ${stdoutTimesMs[i - 1]}ms) without an ordered events log.`,
      );
    }
    stdoutTimestampSet.add(t);
  }

  let prevRawWriteAtMs;
  for (let i = 0; i < rawWrites.length; i++) {
    const w = rawWrites[i];
    if (!w || typeof w.data !== 'string') continue;
    if (!isFiniteNonNegativeNumber(w.atMs)) {
      throw new Error(
        `Cannot convert interactive recording "${label}": missing or invalid stdinWrites[${i}].atMs without an ordered events log.`,
      );
    }
    if (prevRawWriteAtMs !== undefined && w.atMs < prevRawWriteAtMs) {
      throw new Error(
        `Cannot convert interactive recording "${label}": non-monotonic stdinWrites timestamps (${w.atMs}ms < ${prevRawWriteAtMs}ms) without an ordered events log.`,
      );
    }
    prevRawWriteAtMs = w.atMs;
  }

  for (let i = 0; i < stdinFrames.length; i++) {
    const frame = stdinFrames[i];
    if (!isFiniteNonNegativeNumber(frame.atMs)) {
      throw new Error(
        `Cannot convert interactive recording "${label}": missing timestamp for assembled stdin frame ${i} without an ordered events log.`,
      );
    }
    if (stdoutTimestampSet.has(frame.atMs)) {
      throw new Error(
        `Cannot convert interactive recording "${label}": ambiguous cross-direction ordering at ${frame.atMs}ms (stdin and stdout share the same timestamp without an ordered events log).`,
      );
    }
  }

  const unterminatedStartMs = findUnterminatedTrailingStdinStartMs(rawWrites);
  if (unterminatedStartMs !== null && stdinFrames.length > 0) {
    const hasStdoutAtOrAfter = stdoutTimesMs.some((t) => t >= unterminatedStartMs);
    if (hasStdoutAtOrAfter) {
      throw new Error(
        `Cannot convert interactive recording "${label}": unterminated stdin frame is followed by stdout without a newline or stdin_end event, so its cross-direction position cannot be determined.`,
      );
    }
  }

  const merged = [];
  let si = 0;
  let oi = 0;
  while (si < stdinFrames.length && oi < stdoutLines.length) {
    if (stdinFrames[si].atMs < stdoutTimesMs[oi]) {
      merged.push({
        direction: 'stdin',
        data: `${stdinFrames[si].data}\n`,
        atMs: stdinFrames[si].atMs,
      });
      si += 1;
    } else {
      merged.push({
        direction: 'stdout',
        data: stdoutLines[oi],
        atMs: stdoutTimesMs[oi],
      });
      oi += 1;
    }
  }
  while (si < stdinFrames.length) {
    merged.push({
      direction: 'stdin',
      data: `${stdinFrames[si].data}\n`,
      atMs: stdinFrames[si].atMs,
    });
    si += 1;
  }
  while (oi < stdoutLines.length) {
    merged.push({
      direction: 'stdout',
      data: stdoutLines[oi],
      atMs: stdoutTimesMs[oi],
    });
    oi += 1;
  }

  return merged;
}

/**
 * Converts one CLI recording into a linear replay script of `expect_outbound`, `emit_inbound`
 * (with optional `afterMs`), and `exit` entries following T3 Code's linear replay format.
 * Throws a clear error when an interactive recording lacks a trustworthy cross-direction order.
 */
export function convertRecordingToReplayEntries(recording) {
  if (recording?.events !== undefined) {
    const events = validateEventsArray(recording);
    return convertOrderedEventsToEntries(events, recording);
  }

  if (hasNonEmptyStdinWrites(recording)) {
    const merged = mergeLegacyInteractiveStreams(recording);
    return convertOrderedEventsToEntries(merged, recording);
  }

  const stdoutLines = Array.isArray(recording?.stdoutLines) ? recording.stdoutLines : [];
  const stdoutTimesMs = Array.isArray(recording?.stdoutTimesMs) ? recording.stdoutTimesMs : [];
  const events = stdoutLines.map((line, i) => ({
    direction: 'stdout',
    data: line,
    ...(isFiniteNonNegativeNumber(stdoutTimesMs[i]) ? { atMs: stdoutTimesMs[i] } : {}),
  }));
  return convertOrderedEventsToEntries(events, recording);
}

function isInteractiveRecording(recording) {
  if (recording?.events !== undefined) {
    const events = validateEventsArray(recording);
    return hasNonEmptyEventsStdin(events);
  }
  return hasNonEmptyStdinWrites(recording);
}

function deriveStdoutLines(recording) {
  if (Array.isArray(recording?.stdoutLines)) {
    return recording.stdoutLines;
  }
  if (Array.isArray(recording?.events)) {
    return recording.events
      .filter((event) => event && event.direction === 'stdout' && typeof event.data === 'string')
      .map((event) => event.data);
  }
  return [];
}

/**
 * Converts one recording into a ReplayTranscript turn entry.
 * Interactive recordings include the linear `entries` script (`expect_outbound`, `emit_inbound`, `exit`).
 * Non-interactive recordings preserve the existing `stdoutLines`/`stderrLines`/`exitCode` turn format.
 */
export function recordingToTranscriptTurn(recording) {
  const id =
    typeof recording?.file === 'string'
      ? recording.file.replace(/\.json$/, '')
      : (recording?.id ?? 'recorded-turn');
  const match = recording?.match ?? (recording?.provider ? { provider: recording.provider } : undefined);
  const interactive = isInteractiveRecording(recording);
  const stdoutLines = deriveStdoutLines(recording);
  const stderrLines = Array.isArray(recording?.stderrLines) ? recording.stderrLines : [];
  const exitCode = typeof recording?.exitCode === 'number' ? recording.exitCode : 0;

  return {
    id,
    ...(match ? { match } : {}),
    ...(recording?.files ? { files: recording.files } : {}),
    ...(recording?.deleteFiles ? { deleteFiles: recording.deleteFiles } : {}),
    ...(typeof recording?.delayMs === 'number' ? { delayMs: recording.delayMs } : {}),
    ...(recording?.reusable ? { reusable: true } : {}),
    ...(interactive ? { entries: convertRecordingToReplayEntries(recording) } : {}),
    stdoutLines,
    stderrLines,
    exitCode,
  };
}

export function buildTranscriptFromRecordings(recordings, options = {}) {
  const { name = 'recorded', description = 'Recorded transcript', provider = null } =
    typeof options === 'string'
      ? { name: options, description: 'Recorded transcript', provider: null }
      : options;

  const turns = recordings
    .filter((r) => isTurnRecording(r) && (!provider || r.provider === provider))
    .map(recordingToTranscriptTurn);

  return {
    name,
    description,
    turns,
  };
}

function main() {
  const [cmd, dir, name, ...rest] = process.argv.slice(2);
  if (!cmd || !dir || !fs.existsSync(dir)) {
    console.error('usage: recordings.mjs summary <dir> | transcript <dir> <name> [--provider <id>]');
    process.exit(2);
  }

  const recordings = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));

  const pct = (values, p) => {
    const v = values.filter((x) => typeof x === 'number').sort((a, b) => a - b);
    return v.length ? v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))] : null;
  };

  if (cmd === 'summary') {
    const groups = new Map();
    for (const r of recordings) {
      const args = Array.isArray(r.args) ? r.args : [];
      const key = `${r.provider} ${isTurnRecording(r) ? `${r.command ?? ''} ${args[0] ?? ''}`.trim() : 'health'}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    const rows = [...groups].map(([key, rs]) => ({
      key,
      n: rs.length,
      failed: rs.filter((r) => r.exitCode !== 0 || r.timedOut || r.idleTimedOut).length,
      first_out_p50_ms: pct(rs.map((r) => r.firstStdoutMs), 50),
      first_out_max_ms: pct(rs.map((r) => r.firstStdoutMs), 100),
      total_p50_s: (pct(rs.map((r) => r.durationMs), 50) ?? 0) / 1000,
      total_max_s: (pct(rs.map((r) => r.durationMs), 100) ?? 0) / 1000,
    }));
    console.table(rows);
    const bad = recordings.filter((r) => r.exitCode !== 0 || r.timedOut || r.idleTimedOut);
    for (const r of bad) {
      console.log(`\n${r.file}: exit=${r.exitCode} timedOut=${r.timedOut} idle=${r.idleTimedOut}`);
      for (const line of (r.stderrLines ?? []).slice(-3)) console.log(`  stderr: ${line.slice(0, 240)}`);
    }
  } else if (cmd === 'transcript') {
    const tail = name !== undefined ? [name, ...rest] : [];
    const pi = tail.indexOf('--provider');
    const only = pi >= 0 ? (tail[pi + 1] ?? null) : null;
    const positionalName = pi === 0 ? 'recorded' : (name ?? 'recorded');
    try {
      const transcript = buildTranscriptFromRecordings(recordings, {
        name: positionalName,
        description: `Recorded from ${dir}`,
        provider: only,
      });
      process.stdout.write(`${JSON.stringify(transcript, null, 2)}\n`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  } else {
    console.error(`unknown command ${cmd}`);
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
