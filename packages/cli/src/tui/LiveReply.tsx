import React, { memo, useMemo, useSyncExternalStore } from 'react';
import { Box, Text } from 'ink';
import { liveReplyText } from '@dalang/shared';
import { markdownRows } from './markdown.js';

interface LiveEntry {
  phase: string;
  raw: string;
}

/**
 * Reply text that an Ask turn is still writing, per session. It lives outside React state so a
 * stream of `lead.text` events redraws only the live box, not the whole room.
 */
export function createLiveReplyStore() {
  const entries = new Map<string, LiveEntry>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  return {
    append(sessionId: string, phase: string, text: string, reset: boolean) {
      const prev = reset ? undefined : entries.get(sessionId);
      entries.set(sessionId, { phase, raw: (prev?.raw ?? '') + text });
      notify();
    },
    clear(sessionId?: string) {
      if (sessionId === undefined) {
        if (entries.size === 0) return;
        entries.clear();
      } else if (!entries.delete(sessionId)) {
        return;
      }
      notify();
    },
    get(sessionId: string | null): LiveEntry | undefined {
      return sessionId ? entries.get(sessionId) : undefined;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type LiveReplyStore = ReturnType<typeof createLiveReplyStore>;

/** Whether the session has readable reply text yet; the room re-renders only when this flips. */
export function useHasLiveReply(store: LiveReplyStore, sessionId: string | null): boolean {
  return useSyncExternalStore(store.subscribe, () => {
    const entry = store.get(sessionId);
    return entry ? liveReplyText(entry.raw).trim() !== '' : false;
  });
}

/** The reply being written, as its last `rows` lines plus an author line. */
export const LiveReply = memo(function LiveReply({ store, sessionId, rows, width }: {
  store: LiveReplyStore;
  sessionId: string;
  rows: number;
  width: number;
}) {
  const entry = useSyncExternalStore(store.subscribe, () => store.get(sessionId));
  const raw = entry?.raw ?? '';
  // ponytail: re-parses the whole reply on each batch (at most 20 per second); cache finished
  // paragraphs if replies grow past tens of KB.
  const lines = useMemo(() => markdownRows(liveReplyText(raw), width).slice(-rows), [raw, rows, width]);
  const author = entry?.phase.startsWith('ask:') ? `@${entry.phase.slice(4)}` : 'Lead';
  return (
    <Box flexDirection="column" paddingX={1} height={rows + 1} overflow="hidden">
      <Box gap={1}>
        <Text bold color="cyan">{author}</Text>
        <Text dimColor>writing...</Text>
      </Box>
      {lines.map((line, idx) => (
        <Text key={idx} wrap="truncate-end">
          {'  '}
          {line}
        </Text>
      ))}
    </Box>
  );
});
