import React from 'react';
import { spawn } from 'node:child_process';
import { render } from 'ink';
import { ensureServer, serverLogPath, wasStoppedOnPurpose } from '../daemon.js';
import { probeServerHealth, RoomApiClient } from './client.js';
import { openTextInPager } from './format.js';
import { mouseEnabled } from './mouse.js';
import { RoomApp, type RoomAppProps } from './RoomApp.js';

export interface StartTerminalRoomOptions {
  port: number;
  staticDir?: string;
  cwd?: string;
  openBrowser: (url: string) => void;
}

export async function startTerminalRoom(options: StartTerminalRoomOptions): Promise<void> {
  const { port, openBrowser } = options;
  const cwd = options.cwd ?? process.cwd();
  let initialRoom: RoomAppProps['initialRoom'];
  try {
    if (process.env.DALANG_RESTART_ROOM) initialRoom = JSON.parse(process.env.DALANG_RESTART_ROOM);
  } catch {
    // A malformed restart state opens the room normally.
  }
  delete process.env.DALANG_RESTART_ROOM;
  let restartRoom: RoomAppProps['initialRoom'];

  // The server runs in the background and no room owns it: closing this one stops nothing (B30).
  const { notice } = await ensureServer(port);
  /** Called while the room cannot reach the server. Returns what to tell the user, or null. */
  const recoverServer = async (): Promise<string | null> => {
    if (await probeServerHealth(port)) return null;
    if (wasStoppedOnPurpose()) return 'The DALANG server was stopped with `dalang stop`. Type /restart to start it again.';
    try {
      const again = await ensureServer(port);
      return again.started
        ? `The DALANG server had stopped, so it was started again; interrupted tasks continue. Its log: ${serverLogPath()}`
        : again.notice;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

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

  const inst = render(
    React.createElement(RoomApp, {
      client,
      cwd,
      startupNotice: notice,
      recoverServer,
      openBrowser,
      onOpenPager: runPagerWithCleanTty,
      initialRoom,
      onRequestRestart: (room) => { restartRoom = room; },
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
  }
  if (restartRoom) {
    const env = { ...process.env, DALANG_RESTART_ROOM: JSON.stringify(restartRoom) };
    const args = [...process.execArgv, ...process.argv.slice(1)];
    if (process.platform !== 'win32' && typeof process.execve === 'function') {
      process.execve(process.execPath, [process.execPath, ...args], env);
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, args, { stdio: 'inherit', env });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        process.exitCode = code ?? (signal ? 1 : 0);
        resolve();
      });
    });
  }
}
