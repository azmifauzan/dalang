import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '@dalang/core';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureServer, readServerStatus, requestServerStop, wasStoppedOnPurpose } from '../daemon.js';
import { probeServerHealth } from '../tui/client.js';

// The real launcher: it runs the built bundle, as an installed DALANG does.
const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'dalang.js');

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('background server (B30)', () => {
  const homes: string[] = [];
  const ports: number[] = [];
  const saved = { home: process.env.DALANG_HOME, idle: process.env.DALANG_IDLE_STOP_MS };

  async function isolated(): Promise<number> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dalang-daemon-'));
    homes.push(home);
    process.env.DALANG_HOME = home;
    const port = await freePort();
    ports.push(port);
    return port;
  }

  afterEach(async () => {
    for (const port of ports.splice(0)) await requestServerStop(port, true);
    process.env.DALANG_HOME = saved.home;
    if (saved.home === undefined) delete process.env.DALANG_HOME;
    if (saved.idle === undefined) delete process.env.DALANG_IDLE_STOP_MS;
    for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
  });

  it.runIf(process.platform === 'linux')(
    'starts one server in its own session that a closing terminal cannot stop, and shares it',
    async () => {
      const port = await isolated();
      expect((await ensureServer(port, ENTRY)).started).toBe(true);
      expect((await ensureServer(port, ENTRY)).started).toBe(false);
      const status = (await readServerStatus(port))!;
      expect(status).toMatchObject({ background: true, activeWork: false });

      // Field 6 of /proc/<pid>/stat is the session. A server in this process's session would die with it.
      const session = (pid: number) => fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[3];
      expect(session(status.pid)).toBe(String(status.pid));
      expect(session(status.pid)).not.toBe(session(process.pid));
      process.kill(status.pid, 'SIGHUP');
      await pause(500);
      expect((await readServerStatus(port))?.pid).toBe(status.pid);
    },
    60_000,
  );

  it('refuses to stop while work runs unless forced, and remembers that it was stopped on purpose', async () => {
    const port = await isolated();
    await ensureServer(port, ENTRY);
    const db = openDatabase(path.join(process.env.DALANG_HOME!, 'dalang.db'));
    const now = new Date().toISOString();
    db.sqlite.pragma('foreign_keys = OFF');
    db.sqlite
      .prepare("INSERT INTO lead_turns (id, project_id, session_id, phase, provider, status, started_at, log_path) VALUES ('t', 'p', 's', 'ask', 'codex', 'running', ?, 'x')")
      .run(now);
    db.close();

    const refused = await requestServerStop(port, false);
    expect(refused).toMatchObject({ ok: false });
    expect(refused.message).toContain('Work is running');
    expect(await probeServerHealth(port)).not.toBeNull();

    expect((await requestServerStop(port, true)).ok).toBe(true);
    expect(wasStoppedOnPurpose()).toBe(true);
    // Starting it again clears the mark.
    expect((await ensureServer(port, ENTRY)).started).toBe(true);
    expect(wasStoppedOnPurpose()).toBe(false);
  }, 60_000);

  it('stops by itself once it is idle and no one is connected, but not while a room listens', async () => {
    const port = await isolated();
    process.env.DALANG_IDLE_STOP_MS = '1500';
    await ensureServer(port, ENTRY);
    const room = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((resolve) => room.addEventListener('open', resolve, { once: true }));
    await pause(3500);
    expect(await probeServerHealth(port)).not.toBeNull();
    room.close();
    for (let i = 0; i < 100 && (await probeServerHealth(port, 300)); i++) await pause(100);
    expect(await probeServerHealth(port, 300)).toBeNull();
  }, 60_000);
});
