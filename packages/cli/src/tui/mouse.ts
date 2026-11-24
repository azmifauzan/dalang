import { useEffect } from 'react';
import { useStdin, useStdout } from 'ink';

/**
 * Mouse wheel scrolling for the room. The room draws one window of the timeline, so the terminal's own
 * scrollback has nothing to show; asking the terminal to report wheel turns lets the room scroll itself.
 * Reporting also stops the terminal's plain click-and-drag text selection (hold Shift to select in most
 * terminals). `DALANG_NO_MOUSE=1` turns it off.
 */
const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1006l\x1b[?1000l';

/** One SGR mouse report: ESC [ < button ; column ; row, then M (press) or m (release). */
const MOUSE_REPORT = /\x1b?\[<(\d+);\d+;\d+[Mm]/g;

/** Net wheel turns in some terminal input: +1 for each notch up (older), -1 for each notch down. */
export function wheelDelta(data: string): number {
  let delta = 0;
  for (const m of data.matchAll(MOUSE_REPORT)) {
    const button = Number(m[1]);
    if (button === 64) delta += 1;
    else if (button === 65) delta -= 1;
  }
  return delta;
}

/** The input without mouse reports, so a click or wheel turn never lands in a text box as typed text. */
export function stripMouse(data: string): string {
  return data.replace(MOUSE_REPORT, '');
}

export function mouseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DALANG_NO_MOUSE !== '1';
}

/** Rows moved by one wheel notch. */
export const WHEEL_ROWS = 3;

export function useMouseWheel(onNotches: (notches: number) => void, enabled: boolean): void {
  const { stdin } = useStdin();
  const { stdout } = useStdout();
  useEffect(() => {
    if (!enabled || !stdin || !stdout) return;
    const handler = (chunk: Buffer | string) => {
      const delta = wheelDelta(String(chunk));
      if (delta !== 0) onNotches(delta);
    };
    const off = () => {
      try {
        stdout.write(MOUSE_OFF);
      } catch {
        // the terminal is already gone
      }
    };
    stdout.write(MOUSE_ON);
    stdin.on('data', handler);
    process.once('exit', off);
    return () => {
      stdin.off('data', handler);
      process.off('exit', off);
      off();
    };
  }, [enabled, stdin, stdout, onNotches]);
}
