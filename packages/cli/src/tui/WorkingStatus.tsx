import React, { useState } from 'react';
import { Box, Text, useAnimation, useIsScreenReaderEnabled } from 'ink';

const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface WorkingRunItem {
  key: string;
  actor: string;
  model?: string | null;
  phase?: string;
  activity: string;
  progressText?: string;
  completedSteps?: number;
  startedAt?: string;
  waiting?: boolean;
  hint?: string;
}

export function WorkingStatus({
  actor,
  model,
  phase,
  activity,
  progressText,
  completedSteps = 0,
  startedAt,
  others,
  hint,
  waiting = false,
  runs,
}: {
  actor: string;
  model?: string | null;
  phase?: string;
  activity: string;
  progressText?: string;
  completedSteps?: number;
  startedAt?: string;
  others: number;
  hint?: string;
  waiting?: boolean;
  runs?: WorkingRunItem[];
}) {
  const screenReader = useIsScreenReaderEnabled();
  const [mountedAt] = useState(Date.now);
  const { frame } = useAnimation({ interval: screenReader ? 1000 : 120 });
  const now = Date.now();
  const formatElapsed = (iso?: string) => {
    const start = iso ? Date.parse(iso) : mountedAt;
    const seconds = Math.max(0, Math.floor((now - (Number.isFinite(start) ? start : mountedAt)) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };

  const items: WorkingRunItem[] =
    runs && runs.length > 0
      ? runs
      : [{ key: 'primary', actor, model, phase, activity, progressText, completedSteps, startedAt, waiting, hint }];

  return (
    <Box flexDirection="column" paddingX={1}>
      {items.map((item, idx) => (
        <Box key={item.key} flexDirection="column">
          <Text color={item.waiting ? 'cyan' : 'yellow'} wrap="truncate-end">
            {screenReader ? '' : item.waiting ? '◷ ' : `${frames[frame % frames.length]} `}
            {item.waiting ? 'WAITING · ' : item.phase === 'resuming' ? 'RESUMING · ' : ''}
            {formatElapsed(item.startedAt)} · <Text bold>{item.actor}</Text>
            {item.model ? <Text dimColor>{` [${item.model}]`}</Text> : null}
            {idx === 0 && !runs && others > 0 ? ` +${others}` : ''} · {item.activity}
            {item.completedSteps && item.completedSteps > 0 ? (
              <Text dimColor>{` (${item.completedSteps} done)`}</Text>
            ) : null}
            {item.hint ? <Text dimColor>{` · ${item.hint}`}</Text> : null}
          </Text>
          {item.progressText ? (
            <Text dimColor wrap="truncate-end">
              {'  '}
              {item.progressText}
            </Text>
          ) : null}
        </Box>
      ))}
    </Box>
  );
}
