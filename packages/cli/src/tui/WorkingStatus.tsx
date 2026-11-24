import React, { useState } from 'react';
import { Box, Text, useAnimation, useIsScreenReaderEnabled } from 'ink';

const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function WorkingStatus({ actor, activity, startedAt, others }: {
  actor: string;
  activity: string;
  startedAt?: string;
  others: number;
}) {
  const screenReader = useIsScreenReaderEnabled();
  const [mountedAt] = useState(Date.now);
  const { frame } = useAnimation({ interval: screenReader ? 1000 : 120 });
  const start = startedAt ? Date.parse(startedAt) : mountedAt;
  const seconds = Math.max(0, Math.floor((Date.now() - (Number.isFinite(start) ? start : mountedAt)) / 1000));
  const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  return (
    <Box paddingX={1}>
      <Text color="yellow" wrap="truncate-end">
        {screenReader ? '' : `${frames[frame % frames.length]} `}{elapsed} · <Text bold>{actor}</Text>
        {others > 0 ? ` +${others}` : ''} · {activity}
      </Text>
    </Box>
  );
}
