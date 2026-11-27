import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createDalangServer } from '../app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST_DIR = path.resolve(here, '../../../web/dist');

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!().catch(() => undefined);
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 8000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function findChromeBinary(): string | null {
  if (process.platform === 'win32') {
    for (const root of [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA]) {
      if (!root) continue;
      for (const relative of ['Microsoft/Edge/Application/msedge.exe', 'Google/Chrome/Application/chrome.exe']) {
        const candidate = path.join(root, relative);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  const cacheRoot = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (fs.existsSync(cacheRoot)) {
    const entries = fs.readdirSync(cacheRoot).filter((e) => e.startsWith('chromium-')).sort().reverse();
    for (const dir of entries) {
      const candidate = path.join(cacheRoot, dir, 'chrome-linux64', 'chrome');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  for (const sys of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    if (fs.existsSync(sys)) return sys;
  }
  return null;
}

class SimpleCdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly pageErrors: string[] = [];

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { message?: string };
        method?: string;
        params?: Record<string, unknown>;
      };
      if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
          else p.resolve(msg.result);
        }
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const detail = msg.params?.exceptionDetails as { text?: string } | undefined;
        this.pageErrors.push(detail?.text || 'Uncaught exception');
      }
    });
  }

  static async connect(wsUrl: string): Promise<SimpleCdpClient> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP WebSocket failed')), { once: true });
    });
    const client = new SimpleCdpClient(ws);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    return client;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evalJs<T = unknown>(expression: string): Promise<T> {
    const res = (await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })) as { result?: { value?: T }; exceptionDetails?: { text?: string } };
    if (res.exceptionDetails) {
      throw new Error(`Browser eval error: ${res.exceptionDetails.text ?? 'unknown'}`);
    }
    return res.result?.value as T;
  }

  close(): void {
    this.ws.close();
  }
}

async function launchHeadlessChrome(binary: string): Promise<{
  child: ChildProcess;
  cdp: SimpleCdpClient;
  close: () => Promise<void>;
}> {
  const userDataDir = makeTempDir('dalang-ws-chrome-');
  const child = spawn(
    binary,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--lang=en-US',
      '--window-size=1280,900',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let debugPort = 0;
  let stderrBuf = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Chrome startup timeout: ${stderrBuf}`)), 15_000);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
      const m = stderrBuf.match(/ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) {
        debugPort = Number(m[1]);
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited early (${code}): ${stderrBuf}`));
    });
  });

  let pageWsUrl = '';
  for (let i = 0; i < 40; i++) {
    const targets = (await fetch(`http://127.0.0.1:${debugPort}/json`).then((r) => r.json())) as Array<{
      type: string;
      webSocketDebuggerUrl?: string;
    }>;
    const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page?.webSocketDebuggerUrl) {
      pageWsUrl = page.webSocketDebuggerUrl;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!pageWsUrl) throw new Error('Could not find Chrome page target');

  const cdp = await SimpleCdpClient.connect(pageWsUrl);
  return {
    child,
    cdp,
    close: async () => {
      cdp.close();
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 150));
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

/**
 * Opens a raw TCP WebSocket connection that completes the RFC 6455 upgrade handshake
 * and deliberately ignores incoming ping frames (never replies with pong).
 */
async function connectSilentWebSocket(port: number): Promise<{
  socket: net.Socket;
  sawPing: () => boolean;
  closed: Promise<void>;
}> {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  await once(socket, 'connect');

  let upgraded = false;
  let headerBuf = Buffer.alloc(0);
  let pingReceived = false;
  const closed = new Promise<void>((resolve) => {
    socket.once('close', () => resolve());
  });

  const checkFrames = (buf: Buffer) => {
    // WebSocket ping frame has opcode 0x9 in the low nibble of the first byte.
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x89) {
        pingReceived = true;
      }
    }
  };

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    socket.once('error', onError);
    socket.on('data', (chunk: Buffer) => {
      if (!upgraded) {
        headerBuf = Buffer.concat([headerBuf, chunk]);
        const end = headerBuf.indexOf('\r\n\r\n');
        if (end !== -1) {
          const head = headerBuf.subarray(0, end).toString('utf8');
          const rest = headerBuf.subarray(end + 4);
          if (!head.startsWith('HTTP/1.1 101')) {
            reject(new Error(`Unexpected WS upgrade response: ${head}`));
            return;
          }
          upgraded = true;
          socket.off('error', onError);
          if (rest.length > 0) checkFrames(rest);
          resolve();
        }
        return;
      }
      checkFrames(chunk);
    });

    const key = randomBytes(16).toString('base64');
    socket.write(
      [
        'GET /ws HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'),
    );
  });

  return {
    socket,
    sawPing: () => pingReceived,
    closed,
  };
}

describe('WebSocket heartbeat and reconnect (R7)', () => {
  it('closes unresponsive sockets on missed heartbeat, keeps responsive sockets alive, and clears timers on shutdown', async () => {
    const HEARTBEAT_MS = 50;
    const origSetInterval = globalThis.setInterval;
    const origClearInterval = globalThis.clearInterval;
    const createdTimers = new Set<ReturnType<typeof setInterval>>();
    const activeTimers = new Set<ReturnType<typeof setInterval>>();

    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      const handle = origSetInterval(...args);
      if (args[1] === HEARTBEAT_MS) {
        createdTimers.add(handle);
        activeTimers.add(handle);
      }
      return handle;
    }) as typeof setInterval;
    globalThis.clearInterval = ((handle: Parameters<typeof clearInterval>[0]) => {
      if (handle) activeTimers.delete(handle as ReturnType<typeof setInterval>);
      return origClearInterval(handle);
    }) as typeof clearInterval;

    try {
      const server = await createDalangServer({
        dbPath: ':memory:',
        enableScheduler: false,
        wsHeartbeatIntervalMs: HEARTBEAT_MS,
      });
      await server.app.listen({ host: '127.0.0.1', port: 0 });
      const addr = server.app.server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      expect(port).toBeGreaterThan(0);

      let closedServer = false;
      cleanups.push(async () => {
        if (!closedServer) await server.close();
      });

      // Responsive client (standard WebSocket automatically replies to ping with pong).
      const liveWs = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const received: Array<{ type: string; projectId?: string }> = [];
      let liveCloseCode: number | null = null;
      const liveClosed = new Promise<number>((resolve) => {
        liveWs.addEventListener('close', (ev) => {
          liveCloseCode = ev.code;
          resolve(ev.code);
        });
      });
      liveWs.addEventListener('message', (ev) => {
        received.push(JSON.parse(String(ev.data)) as { type: string; projectId?: string });
      });
      await new Promise<void>((resolve, reject) => {
        liveWs.addEventListener('open', () => resolve(), { once: true });
        liveWs.addEventListener('error', () => reject(new Error('liveWs failed')), { once: true });
      });

      // Unresponsive client (completes upgrade, ignores ping frames).
      const silent = await connectSilentWebSocket(port);
      cleanups.push(async () => {
        silent.socket.destroy();
      });

      expect(createdTimers.size).toBeGreaterThanOrEqual(1);
      expect(activeTimers.size).toBe(1);

      // Server pings and terminates the unresponsive socket after a missed heartbeat.
      await Promise.race([
        silent.closed,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Unresponsive socket was not closed by heartbeat')), 2000),
        ),
      ]);
      expect(silent.sawPing()).toBe(true);

      // Responsive socket remains open across several heartbeat intervals and still receives events.
      await new Promise((r) => setTimeout(r, HEARTBEAT_MS * 4));
      expect(liveWs.readyState).toBe(WebSocket.OPEN);
      server.events.emitEvent({ type: 'sessions.updated', projectId: 'proj-alive' });
      await waitFor(() => received.some((e) => e.projectId === 'proj-alive'), 2000, 'live event after heartbeats');

      // Shutdown closes remaining sockets with 1001 and clears the heartbeat interval timer.
      closedServer = true;
      await server.close();
      await liveClosed;
      expect(liveCloseCode).toBe(1001);
      expect(activeTimers.size).toBe(0);
    } finally {
      globalThis.setInterval = origSetInterval;
      globalThis.clearInterval = origClearInterval;
    }
  });

  it('closes sockets with 4401 on access revocation while heartbeat is enabled and stops idle heartbeat timers', async () => {
    const HEARTBEAT_MS = 60;
    const origSetInterval = globalThis.setInterval;
    const origClearInterval = globalThis.clearInterval;
    const activeTimers = new Set<ReturnType<typeof setInterval>>();

    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      const handle = origSetInterval(...args);
      if (args[1] === HEARTBEAT_MS) activeTimers.add(handle);
      return handle;
    }) as typeof setInterval;
    globalThis.clearInterval = ((handle: Parameters<typeof clearInterval>[0]) => {
      if (handle) activeTimers.delete(handle as ReturnType<typeof setInterval>);
      return origClearInterval(handle);
    }) as typeof clearInterval;

    try {
      const server = await createDalangServer({
        dbPath: ':memory:',
        enableScheduler: false,
        wsHeartbeatIntervalMs: HEARTBEAT_MS,
      });
      cleanups.push(server.close);
      const { app } = server;
      await app.ready();

      const ws1 = await app.injectWS('/ws', { headers: { host: 'localhost' } });
      const ws1Closed = once(ws1, 'close');
      expect(activeTimers.size).toBe(1);

      const password = 'a long local password';
      const enabled = await app.inject({
        method: 'PUT',
        url: '/api/auth/settings',
        payload: { enabled: true, password },
      });
      expect(enabled.statusCode).toBe(200);
      expect((await ws1Closed)[0]).toBe(4401);
      expect(activeTimers.size).toBe(0);

      const cookie = String(enabled.headers['set-cookie']).split(';')[0];
      const ws2 = await app.injectWS('/ws', { headers: { host: 'localhost', cookie } });
      const ws2Closed = once(ws2, 'close');
      expect(activeTimers.size).toBe(1);

      const logout = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie },
      });
      expect(logout.statusCode).toBe(200);
      expect((await ws2Closed)[0]).toBe(4401);
      expect(activeTimers.size).toBe(0);
    } finally {
      globalThis.setInterval = origSetInterval;
      globalThis.clearInterval = origClearInterval;
    }
  });

  it(
    'web UI reconnects after local server restart, reloads active state, and cleans up connections and listeners on project switch and close',
    async () => {
      const chrome = findChromeBinary();
      if (!chrome || !fs.existsSync(WEB_DIST_DIR)) {
        return;
      }

      const dbDir = makeTempDir('dalang-ws-web-db-');
      const dbPath = path.join(dbDir, 'dalang.db');
      const repo1 = makeTempDir('dalang-ws-web-p1-');
      const repo2 = makeTempDir('dalang-ws-web-p2-');

      const server1 = await createDalangServer({
        dbPath,
        staticDir: WEB_DIST_DIR,
        enableScheduler: false,
        wsHeartbeatIntervalMs: 1000,
      });
      let server1Closed = false;
      cleanups.push(async () => {
        if (!server1Closed) await server1.close();
      });

      const p1Res = await server1.app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { mode: 'create', name: 'Project Alpha', path: repo1, initGitIfMissing: true },
      });
      expect(p1Res.statusCode).toBe(201);
      const p1 = p1Res.json().project as { id: string };

      const p2Res = await server1.app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { mode: 'create', name: 'Project Beta', path: repo2, initGitIfMissing: true },
      });
      expect(p2Res.statusCode).toBe(201);

      const s1Res = await server1.app.inject({
        method: 'POST',
        url: `/api/projects/${p1.id}/sessions`,
        payload: { mode: 'ask', title: 'Before Restart' },
      });
      expect(s1Res.statusCode).toBe(201);
      const s1 = s1Res.json().session as { id: string };

      await server1.app.listen({ host: '127.0.0.1', port: 0 });
      const addr = server1.app.server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      expect(port).toBeGreaterThan(0);

      const browser = await launchHeadlessChrome(chrome);
      cleanups.push(browser.close);
      const { cdp } = browser;

      // Instrument WebSocket and window lifecycle listeners before app scripts run.
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          (() => {
            const probe = { sockets: [], activeWindowListeners: 0 };
            window.__wsProbe = probe;
            const OrigWS = window.WebSocket;
            function TrackedWS(url, protocols) {
              const ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
              const rec = { url: String(url), listeners: 0 };
              probe.sockets.push(rec);
              const origAdd = ws.addEventListener.bind(ws);
              const origRemove = ws.removeEventListener.bind(ws);
              ws.addEventListener = function(type, fn, opts) {
                rec.listeners += 1;
                return origAdd(type, fn, opts);
              };
              ws.removeEventListener = function(type, fn, opts) {
                rec.listeners = Math.max(0, rec.listeners - 1);
                return origRemove(type, fn, opts);
              };
              return ws;
            }
            TrackedWS.prototype = OrigWS.prototype;
            Object.assign(TrackedWS, {
              CONNECTING: OrigWS.CONNECTING,
              OPEN: OrigWS.OPEN,
              CLOSING: OrigWS.CLOSING,
              CLOSED: OrigWS.CLOSED,
            });
            window.WebSocket = TrackedWS;

            const trackedEvents = new Set(['online', 'pagehide', 'pageshow']);
            const origWinAdd = window.addEventListener.bind(window);
            const origWinRemove = window.removeEventListener.bind(window);
            window.addEventListener = function(type, fn, opts) {
              if (trackedEvents.has(type)) probe.activeWindowListeners += 1;
              return origWinAdd(type, fn, opts);
            };
            window.removeEventListener = function(type, fn, opts) {
              if (trackedEvents.has(type)) {
                probe.activeWindowListeners = Math.max(0, probe.activeWindowListeners - 1);
              }
              return origWinRemove(type, fn, opts);
            };
          })();
        `,
      });

      await cdp.send('Page.navigate', {
        url: `http://127.0.0.1:${port}/?project=${encodeURIComponent(p1.id)}&session=${encodeURIComponent(s1.id)}`,
      });

      await waitFor(
        async () =>
          server1.app.websocketServer.clients.size === 1 &&
          (await cdp.evalJs<boolean>(
            `document.body.innerText.includes('Project Alpha') && document.body.innerText.includes('Before Restart')`,
          )),
        12_000,
        'initial web UI load and WS connection',
      );

      const baselineWindowListeners = await cdp.evalJs<number>(`window.__wsProbe.activeWindowListeners`);
      expect(baselineWindowListeners).toBeGreaterThanOrEqual(3);

      // Switch project to Project Beta -> previous socket and listeners must be cleaned up.
      const clickedBeta = await cdp.evalJs<boolean>(`
        (() => {
          const btn = Array.from(document.querySelectorAll('button')).find((b) =>
            (b.textContent || '').includes('Project Beta'),
          );
          if (!btn) return false;
          btn.click();
          return true;
        })()
      `);
      expect(clickedBeta).toBe(true);

      await waitFor(
        async () => {
          const stats = await cdp.evalJs<{ total: number; prevListeners: number[]; winListeners: number }>(
            `({
              total: window.__wsProbe.sockets.length,
              prevListeners: window.__wsProbe.sockets.slice(0, -1).map((s) => s.listeners),
              winListeners: window.__wsProbe.activeWindowListeners,
            })`,
          );
          return (
            stats.total >= 2 &&
            stats.prevListeners.every((n) => n === 0) &&
            stats.winListeners === baselineWindowListeners &&
            server1.app.websocketServer.clients.size === 1
          );
        },
        8000,
        'project switch WS and listener cleanup',
      );

      // Switch back to Project Alpha and reopen the session before restarting the server.
      await cdp.evalJs<boolean>(`
        (() => {
          const btn = Array.from(document.querySelectorAll('button')).find((b) =>
            (b.textContent || '').includes('Project Alpha'),
          );
          if (!btn) return false;
          btn.click();
          return true;
        })()
      `);
      await waitFor(
        () => cdp.evalJs<boolean>(`document.body.innerText.includes('Before Restart')`),
        8000,
        'Project Alpha sidebar restored',
      );
      await cdp.evalJs<boolean>(`
        (() => {
          const btn = Array.from(document.querySelectorAll('button')).find((b) =>
            (b.textContent || '').includes('Before Restart'),
          );
          if (!btn) return false;
          btn.click();
          return true;
        })()
      `);
      await waitFor(
        async () =>
          server1.app.websocketServer.clients.size === 1 &&
          (await cdp.evalJs<boolean>(
            `window.__wsProbe.activeWindowListeners === ${baselineWindowListeners} && window.__wsProbe.sockets.slice(0, -1).every((s) => s.listeners === 0)`,
          )),
        8000,
        'clean single WS after returning to Project Alpha',
      );

      // Shut down server #1 so the browser experiences a real disconnect.
      server1Closed = true;
      await server1.close();
      await new Promise((r) => setTimeout(r, 250));

      // Start server #2 on the same port and DB. Update the session title BEFORE listening
      // so no WebSocket event is broadcast for it: the UI can only see it by reloading on reconnect.
      const server2 = await createDalangServer({
        dbPath,
        staticDir: WEB_DIST_DIR,
        enableScheduler: false,
        wsHeartbeatIntervalMs: 1000,
      });
      cleanups.push(server2.close);

      const renamed = await server2.app.inject({
        method: 'PATCH',
        url: `/api/projects/${p1.id}/sessions/${s1.id}`,
        payload: { title: 'Reloaded After Reconnect' },
      });
      expect(renamed.statusCode).toBe(200);

      await server2.app.listen({ host: '127.0.0.1', port });

      await waitFor(
        async () =>
          server2.app.websocketServer.clients.size === 1 &&
          (await cdp.evalJs<boolean>(`document.body.innerText.includes('Reloaded After Reconnect')`)),
        12_000,
        'web UI reconnect and active-state reload',
      );

      // Confirm live events continue flowing on the reconnected socket.
      const renamedLive = await server2.app.inject({
        method: 'PATCH',
        url: `/api/projects/${p1.id}/sessions/${s1.id}`,
        payload: { title: 'Live Update After Reconnect' },
      });
      expect(renamedLive.statusCode).toBe(200);
      server2.events.emitEvent({ type: 'sessions.updated', projectId: p1.id });
      await waitFor(
        () => cdp.evalJs<boolean>(`document.body.innerText.includes('Live Update After Reconnect')`),
        8000,
        'live update after reconnect',
      );

      // Turn 1 populates liveBySession, finishes, then socket drops while Turn 2 starts.
      // After reconnect, stale Turn 1 text/logs must NOT reappear or prepend to Turn 2's live output.
      const agentDeltaLine = (text: string) =>
        JSON.stringify({
          event: 'step_update',
          step_update: { step_type: 'agent_response', state: 'ACTIVE', text_delta: text },
        });
      server2.events.emitEvent({
        type: 'lead.turn_started',
        projectId: p1.id,
        sessionId: s1.id,
        phase: 'ask',
        provider: 'claude-code',
      });
      server2.events.emitEvent({ type: 'sessions.updated', projectId: p1.id });
      server2.events.emitEvent({
        type: 'lead.log',
        projectId: p1.id,
        sessionId: s1.id,
        phase: 'ask',
        line: agentDeltaLine('OLD_TURN_LIVE_ANSWER'),
      });
      await waitFor(
        () => cdp.evalJs<boolean>(`document.body.innerText.includes('OLD_TURN_LIVE_ANSWER')`),
        8000,
        'Turn 1 live text rendered',
      );
      server2.events.emitEvent({
        type: 'lead.turn_finished',
        projectId: p1.id,
        sessionId: s1.id,
        phase: 'ask',
        ok: true,
      });
      server2.events.emitEvent({ type: 'sessions.updated', projectId: p1.id });
      await waitFor(
        () => cdp.evalJs<boolean>(`!document.body.innerText.includes('OLD_TURN_LIVE_ANSWER')`),
        8000,
        'Turn 1 finished and cleared from view',
      );

      // Drop the live WebSocket and start Turn 2 while disconnected so lead.turn_started is missed.
      for (const client of server2.app.websocketServer.clients) {
        client.terminate();
      }
      await waitFor(() => server2.app.websocketServer.clients.size === 0, 5000, 'WS dropped before Turn 2');

      server2.events.emitEvent({
        type: 'lead.turn_started',
        projectId: p1.id,
        sessionId: s1.id,
        phase: 'ask',
        provider: 'claude-code',
      });

      // Wait for browser reconnect, then stream Turn 2's live text.
      await waitFor(() => server2.app.websocketServer.clients.size === 1, 8000, 'WS reconnected during Turn 2');
      server2.events.emitEvent({
        type: 'lead.log',
        projectId: p1.id,
        sessionId: s1.id,
        phase: 'ask',
        line: agentDeltaLine('NEW_TURN_LIVE_ANSWER'),
      });
      await waitFor(
        () => cdp.evalJs<boolean>(`document.body.innerText.includes('NEW_TURN_LIVE_ANSWER')`),
        8000,
        'Turn 2 live text rendered after reconnect',
      );
      expect(await cdp.evalJs<boolean>(`document.body.innerText.includes('OLD_TURN_LIVE_ANSWER')`)).toBe(false);
      server2.events.emitEvent({
        type: 'lead.turn_finished',
        projectId: p1.id,
        sessionId: s1.id,
        phase: 'ask',
        ok: true,
      });

      // Closing the view cleans up the WebSocket connection on the server.
      await cdp.send('Page.navigate', { url: 'about:blank' });
      await waitFor(() => server2.app.websocketServer.clients.size === 0, 8000, 'WS closed after view close');
      expect(cdp.pageErrors).toEqual([]);
    },
    30_000,
  );
});
