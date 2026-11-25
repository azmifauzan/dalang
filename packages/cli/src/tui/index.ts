import React from 'react';
import { render } from 'ink';
import { startDalangServer } from '@dalang/server';
import { probeServerHealth, RoomApiClient } from './client.js';
import { openTextInPager } from './format.js';
import { mouseEnabled } from './mouse.js';
import { RoomApp } from './RoomApp.js';

export interface StartTerminalRoomOptions {
  port: number;
  staticDir?: string;
  cwd?: string;
  openBrowser: (url: string) => void;
}

export async function startTerminalRoom(options: StartTerminalRoomOptions): Promise<void> {
  const { port, staticDir, openBrowser } = options;
  const cwd = options.cwd ?? process.cwd();

  const existing = await probeServerHealth(port);
  let embeddedClose: (() => Promise<void>) | null = null;
  let embedded = false;

  if (!existing) {
    const started = await startDalangServer({ port, staticDir });
    embeddedClose = started.close;
    embedded = true;
  }

  const client = new RoomApiClient(port);

  const runPagerWithCleanTty = async (
    content: string,
    label: string,
  ): Promise<{ ok: boolean; error?: string }> => {
    const wasRaw = Boolean(process.stdin.isTTY && (process.stdin as NodeJS.ReadStream).isRaw);
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    // Clear alternate / current screen region cleanly before launching pager
    if (process.stdout.isTTY) {
      process.stdout.write('\x1b[2J\x1b[H');
    }
    try {
      return openTextInPager(content, label);
    } finally {
      process.stdin.resume();
      if (wasRaw && process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
        process.stdin.setRawMode(true);
      }
    }
  };

  let closed = false;
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    if (embeddedClose) {
      await embeddedClose().catch(() => undefined);
      embeddedClose = null;
    }
  };

  const inst = render(
    React.createElement(RoomApp, {
      client,
      embedded,
      cwd,
      openBrowser,
      onOpenPager: runPagerWithCleanTty,
      enableMouse: Boolean(process.stdout.isTTY) && mouseEnabled(),
    }),
    // Redraw only changed lines, and allow 60 frames a second so a keystroke is not held behind a
    // streaming redraw. Measured with scripts/tui-bench.mjs; see docs/TUI_PERFORMANCE.md.
    { exitOnCtrlC: false, incrementalRendering: true, maxFps: 60 },
  );

  const onSignal = () => {
    inst.unmount();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    await inst.waitUntilExit();
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await cleanup();
  }
}
