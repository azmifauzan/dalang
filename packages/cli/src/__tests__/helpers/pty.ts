import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

/**
 * Strip ANSI / CSI / OSC control sequences so assertions can check readable terminal text.
 */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r/g, '');
}

export function isPtySupported(): boolean {
  if (process.platform === 'win32') return false;
  const check = spawnSync('python3', ['-c', 'import pty, fcntl, termios, struct, select'], {
    stdio: 'ignore',
  });
  return check.status === 0;
}

const PTY_BRIDGE_SCRIPT = `
import os, pty, select, signal, struct, sys, fcntl, termios

cols = int(sys.argv[1])
rows = int(sys.argv[2])
cmd = sys.argv[3:]

pid, fd = pty.fork()
if pid == 0:
    os.execvpe(cmd[0], cmd, os.environ)

winsize = struct.pack("HHHH", rows, cols, 0, 0)
fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)

def forward_sig(signum, _frame):
    try:
        os.kill(pid, signum)
    except OSError:
        pass

signal.signal(signal.SIGTERM, forward_sig)
signal.signal(signal.SIGINT, forward_sig)

stdin_fd = sys.stdin.fileno()
stdout_fd = sys.stdout.fileno()

try:
    while True:
        rlist = [fd]
        if stdin_fd is not None:
            rlist.append(stdin_fd)
        try:
            readable, _, _ = select.select(rlist, [], [], 0.1)
        except InterruptedError:
            continue
        if fd in readable:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            os.write(stdout_fd, data)
        if stdin_fd is not None and stdin_fd in readable:
            try:
                inp = os.read(stdin_fd, 4096)
            except OSError:
                stdin_fd = None
                continue
            if not inp:
                stdin_fd = None
                continue
            os.write(fd, inp)
finally:
    try:
        _, status = os.waitpid(pid, 0)
        code = os.waitstatus_to_exitcode(status)
    except ChildProcessError:
        code = 0
    sys.exit(code)
`;

export interface PtyHandle {
  output: () => string;
  cleanOutput: () => string;
  write: (data: string) => void;
  sendLine: (line: string) => Promise<void>;
  waitFor: (needle: string | RegExp, timeoutMs?: number) => Promise<string>;
  close: () => Promise<void>;
}

/**
 * Spawns a command inside a genuine Linux pseudo-terminal with explicit window size.
 */
export function spawnInPty(
  command: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; cols?: number; rows?: number },
): PtyHandle {
  const cols = opts.cols ?? 110;
  const rows = opts.rows ?? 34;
  let rawBuf = '';
  let exited = false;
  let exitCode: number | null = null;

  const child: ChildProcess = spawn(
    'python3',
    ['-u', '-c', PTY_BRIDGE_SCRIPT, String(cols), String(rows), command, ...args],
    {
      cwd: opts.cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        FORCE_COLOR: '0',
        ...opts.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  child.stdout?.on('data', (chunk: Buffer) => {
    rawBuf += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    rawBuf += chunk.toString('utf8');
  });
  child.on('exit', (code) => {
    exited = true;
    exitCode = code;
  });

  const cleanOutput = () => stripAnsi(rawBuf);

  const write = (data: string) => {
    if (!exited && child.stdin?.writable) {
      child.stdin.write(data);
    }
  };

  const sendLine = async (line: string) => {
    // Type text and wait briefly before Return so Ink's input buffer settles cleanly.
    write(line);
    await new Promise((r) => setTimeout(r, 80));
    write('\r');
  };

  const waitFor = async (needle: string | RegExp, timeoutMs = 15_000): Promise<string> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const clean = cleanOutput();
      const matched = typeof needle === 'string' ? clean.includes(needle) : needle.test(clean);
      if (matched) return clean;
      if (exited) break;
      await new Promise((r) => setTimeout(r, 75));
    }
    const clean = cleanOutput();
    const matched = typeof needle === 'string' ? clean.includes(needle) : needle.test(clean);
    if (matched) return clean;
    throw new Error(
      `PTY timed out waiting for ${String(needle)} (exited=${exited}, code=${exitCode}). Last output:\n${clean.slice(-1500)}`,
    );
  };

  const close = async () => {
    if (!exited) {
      try {
        write('\x03'); // Ctrl+C
      } catch {
        // ignore
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!exited) {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!exited) {
      child.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  return {
    output: () => rawBuf,
    cleanOutput,
    write,
    sendLine,
    waitFor,
    close,
  };
}
