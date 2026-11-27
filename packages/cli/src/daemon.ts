/**
 * The DALANG server runs in the background, on its own, so no terminal owns it (B30). Every room and
 * `dalang web` connect to it; closing one changes nothing for the others or for running work. One server
 * stays shared because the database, the per-account agent slots, and run recovery must be.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DALANG_VERSION, getDalangHome } from '@dalang/core';
import { startDalangServer } from '@dalang/server';
import { probeServerHealth } from './tui/client.js';

/** A background server with nothing to do and no one connected stops after this long. */
export const IDLE_STOP_MS = 15 * 60_000;
const IDLE_CHECK_MS = 30_000;
const START_TIMEOUT_MS = 30_000;
const MAX_LOG_BYTES = 5_000_000;

export interface ServerStatus {
  version: string;
  pid: number;
  background: boolean;
  activeWork: boolean;
  connections: number;
  scheduled: boolean;
}

export const serverLogPath = () => path.join(getDalangHome(), 'logs', 'server.log');
/** Left by `dalang stop`, so an open room does not start the server again behind the user's back. */
const stoppedMarker = () => path.join(getDalangHome(), 'server.stopped');
export const wasStoppedOnPurpose = () => fs.existsSync(stoppedMarker());

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function serverApi<T>(port: number, route: string, init?: RequestInit): Promise<{ status: number; body: T | null }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, { ...init, signal: AbortSignal.timeout(5000) });
    return { status: res.status, body: (await res.json().catch(() => null)) as T | null };
  } catch {
    return { status: 0, body: null };
  }
}

export async function readServerStatus(port: number): Promise<ServerStatus | null> {
  const res = await serverApi<ServerStatus>(port, '/api/server/status');
  return res.status === 200 ? res.body : null;
}

/** Asks a background server to stop and waits until its port is free. */
export async function requestServerStop(port: number, force: boolean): Promise<{ ok: boolean; message: string }> {
  const res = await serverApi<{ message?: string }>(port, '/api/server/shutdown', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ force }),
  });
  if (res.status !== 200) {
    return { ok: false, message: res.body?.message ?? `The server did not accept the request (HTTP ${res.status || 'unreachable'}).` };
  }
  for (let i = 0; i < 100; i++) {
    if (!(await probeServerHealth(port, 500))) return { ok: true, message: 'DALANG server stopped.' };
    await pause(100);
  }
  return { ok: false, message: 'The server accepted the stop request but still answers.' };
}

function spawnServer(port: number, entry: string): void {
  const log = serverLogPath();
  fs.mkdirSync(path.dirname(log), { recursive: true });
  if (fs.existsSync(log) && fs.statSync(log).size > MAX_LOG_BYTES) fs.renameSync(log, `${log}.old`);
  const out = fs.openSync(log, 'a', 0o600);
  const env = { ...process.env };
  delete env.DALANG_RESTART_ROOM;
  try {
    // `detached` gives the server its own session: closing this terminal sends it no signal. It keeps
    // this environment, so the agent CLIs find the same PATH and desktop session bus.
    spawn(process.execPath, [...process.execArgv, entry, 'serve', '--port', String(port)], {
      cwd: os.homedir(),
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
      env,
    }).unref();
  } finally {
    fs.closeSync(out);
  }
}

export interface EnsuredServer {
  /** True when this call started the server. */
  started: boolean;
  /** Something the user should know, or null. */
  notice: string | null;
}

/**
 * Makes sure a server answers on `port`, starting a background one if none does. A background server of
 * another version is replaced once it has no work, so an update takes effect.
 */
export async function ensureServer(port: number, entry: string = process.argv[1]): Promise<EnsuredServer> {
  const health = await probeServerHealth(port);
  if (health) {
    if (health.version === DALANG_VERSION) return { started: false, notice: null };
    const status = await readServerStatus(port);
    if (!status?.background || status.activeWork || !(await requestServerStop(port, false)).ok) {
      return {
        started: false,
        notice: status?.activeWork
          ? `The DALANG server still runs v${health.version} while work is active. Run /restart after the work ends to use v${DALANG_VERSION}.`
          : `The DALANG server on this port runs v${health.version}, not v${DALANG_VERSION}. Close the terminal that runs it, then run /restart.`,
      };
    }
  }
  fs.rmSync(stoppedMarker(), { force: true });
  spawnServer(port, entry);
  const until = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < until) {
    // Two rooms opened at once may both start one: the second finds the port taken and exits.
    if (await probeServerHealth(port, 500)) return { started: true, notice: null };
    await pause(150);
  }
  const tail = fs.existsSync(serverLogPath()) ? fs.readFileSync(serverLogPath(), 'utf8').split('\n').slice(-8).join('\n') : '';
  throw new Error(`The DALANG server did not start. Last lines of ${serverLogPath()}:\n${tail}`);
}

/** The body of `dalang serve`: runs until asked to stop, or until idle with no one connected. */
export async function runBackgroundServer(
  port: number,
  staticDir?: string,
  idleMs = Number(process.env.DALANG_IDLE_STOP_MS) || IDLE_STOP_MS,
): Promise<void> {
  process.title = 'dalang server';
  // A closing terminal must never reach this process, whatever started it.
  process.on('SIGHUP', () => {});
  let stopping = false;
  let idleSince: number | null = null;
  let timer: NodeJS.Timeout | undefined;
  const stop = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    console.log(`${new Date().toISOString()} stopping: ${reason}`);
    await server.close().catch((err) => console.error(err));
    process.exit(0);
  };
  const server = await startDalangServer({
    port,
    staticDir,
    background: true,
    onShutdownRequest: () => {
      fs.writeFileSync(stoppedMarker(), new Date().toISOString());
      void stop('requested');
    },
  });
  console.log(`${new Date().toISOString()} DALANG v${DALANG_VERSION} background server at ${server.url} (pid ${process.pid})`);
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
  timer = setInterval(() => {
    const now = server.activity();
    if (now.activeWork || now.connections > 0 || now.scheduled || Date.now() - now.lastRequestAt < idleMs) {
      idleSince = null;
      return;
    }
    idleSince ??= Date.now();
    if (Date.now() - idleSince >= idleMs) void stop('idle');
  }, Math.min(IDLE_CHECK_MS, Math.max(50, idleMs / 2)));
}
