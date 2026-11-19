import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ReplayCliRunner, type ReplayTranscript } from '@dalang/core';
import { startDalangServer } from '../app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST_DIR = path.resolve(here, '../../../web/dist');

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function findChromeBinary(): string | null {
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
  readonly consoleErrors: string[] = [];
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
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        const args = (msg.params.args as Array<{ value?: unknown; description?: string }>) ?? [];
        this.consoleErrors.push(args.map((a) => String(a.value ?? a.description ?? '')).join(' '));
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

async function launchHeadlessChrome(binary: string, startUrl: string): Promise<{
  child: ChildProcess;
  cdp: SimpleCdpClient;
  close: () => Promise<void>;
}> {
  const userDataDir = makeTempDir('dalang-chrome-');
  const child = spawn(
    binary,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      startUrl,
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

  // Poll /json for a page target.
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

describe('v0.5 browser scenario on a real server with the replay runner', () => {
  it('serves the built UI with ReplayCliRunner, runs a full project flow, and verifies Providers + Guard in headless Chromium', async () => {
    const transcript: ReplayTranscript = {
      name: 'browser-e2e',
      turns: [
        {
          id: 'brief',
          match: { provider: 'claude-code', promptContains: 'brief.v1.json' },
          files: {
            '.dalang/brief.v1.json': JSON.stringify({
              version: 1,
              title: 'Browser Replay App',
              summary: 'Tiny Node module verified end to end through the browser UI.',
              scope: ['Greeting helper'],
              features: ['greet(name)'],
              stack: ['Node.js ESM'],
              constraints: [],
              out_of_scope: [],
              assumptions: [],
            }),
          },
          stdoutLines: [
            JSON.stringify({
              type: 'result',
              session_id: 'lead-browser-1',
              result: 'Brief written',
              usage: { input_tokens: 400, output_tokens: 150, cache_read_input_tokens: 600, cache_creation_input_tokens: 0 },
              total_cost_usd: 0.004,
            }),
          ],
          exitCode: 0,
        },
        {
          id: 'plan',
          match: { provider: 'claude-code', promptContains: 'plan-v1.json' },
          files: {
            '.dalang/tmp/plan-v1.json': JSON.stringify({
              version: 1,
              brief_version: 1,
              milestones: [{ id: 'M1', title: 'Core', description: '' }],
              tasks: [
                {
                  id: 'T-001',
                  title: 'Implement greet helper',
                  milestone: 'M1',
                  role: 'engineer',
                  complexity: 'low',
                  depends_on: [],
                  goal: 'Export greet(name) and unit test',
                  files_allowed: ['src/greet.mjs', 'src/greet.test.mjs'],
                  files_reference: ['PROJECT.md'],
                  acceptance_criteria: ['greet("World") returns "Hello, World!"'],
                  verify: 'node --test src/greet.test.mjs',
                  needs_split: false,
                },
              ],
            }),
          },
          stdoutLines: [
            JSON.stringify({
              type: 'result',
              session_id: 'lead-browser-1',
              result: 'Plan written',
            }),
          ],
          exitCode: 0,
        },
        {
          id: 'coder-t001',
          match: { provider: 'codex', promptContains: 'T-001' },
          files: {
            'src/greet.mjs': 'export function greet(name) { return `Hello, ${name}!`; }\n',
            'src/greet.test.mjs':
              "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from './greet.mjs';\ntest('greet', () => assert.equal(greet('World'), 'Hello, World!'));\n",
            '.dalang/tasks/T-001/result.json': JSON.stringify({
              task_id: 'T-001',
              status: 'completed',
              changed_files: ['src/greet.mjs', 'src/greet.test.mjs'],
              summary: 'Implemented greet helper and test.',
              notes: [],
              blockers: [],
              verify_command: 'node --test src/greet.test.mjs',
              verify_exit_code: 0,
            }),
          },
          stdoutLines: [
            JSON.stringify({ type: 'thread.started', thread_id: 'codex-b1' }),
            JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done' } }),
            JSON.stringify({
              type: 'turn.completed',
              usage: { input_tokens: 1500, cached_input_tokens: 900, output_tokens: 200 },
            }),
          ],
          exitCode: 0,
        },
        {
          id: 'reviewer-t001',
          match: { provider: 'claude-code', promptContains: 'code review round 1' },
          stdoutLines: [
            JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-r1', model: 'claude-opus-5-5' }),
            JSON.stringify({
              type: 'result',
              session_id: 'claude-r1',
              result: JSON.stringify({
                task_id: 'T-001',
                status: 'pass',
                verify_exit_code: 0,
                summary: 'All checks pass.',
                findings: [],
              }),
              usage: { input_tokens: 800, output_tokens: 120, cache_read_input_tokens: 1600, cache_creation_input_tokens: 0 },
              total_cost_usd: 0.0062,
            }),
          ],
          exitCode: 0,
        },
      ],
    };

    const runner = new ReplayCliRunner(transcript, {
      runRealShellCommands: true,
      ghPrUrl: 'https://github.com/example/browser-replay/pull/12',
    });
    const dbFile = path.join(makeTempDir('dalang-browser-db-'), 'dalang.db');
    const projDir = path.join(makeTempDir('dalang-browser-proj-'), 'greet-app');
    const bareRemote = makeTempDir('dalang-browser-remote-');
    execFileSync('git', ['init', '--bare', bareRemote], { stdio: 'ignore' });

    const server = await startDalangServer({
      port: 0,
      dbPath: dbFile,
      staticDir: WEB_DIST_DIR,
      runner,
    });

    try {
      const apiJson = async <T>(p: string, init?: RequestInit): Promise<T> => {
        const res = await fetch(`${server.url}${p}`, {
          ...init,
          headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
        });
        const data = (await res.json()) as T;
        if (!res.ok) throw new Error(`HTTP ${res.status} on ${p}: ${JSON.stringify(data)}`);
        return data;
      };

      // 1. Seed a project via the real HTTP API, execute with replay runner, merge, and push/PR.
      const { project } = await apiJson<{ project: { id: string } }>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ mode: 'create', name: 'Browser Replay App', path: projDir }),
      });
      execFileSync('git', ['remote', 'add', 'origin', bareRemote], { cwd: projDir, stdio: 'ignore' });
      await apiJson(`/api/projects/${project.id}/discuss/finish`, { method: 'POST' });
      await apiJson(`/api/projects/${project.id}/briefs/1/approve`, { method: 'POST' });
      await apiJson(`/api/projects/${project.id}/plan/generate`, { method: 'POST' });
      await apiJson(`/api/projects/${project.id}/plan/approve`, { method: 'POST' });
      await apiJson(`/api/projects/${project.id}/execution/start`, {
        method: 'POST',
        body: JSON.stringify({ allowUnconfined: true }),
      });

      // Wait for task to reach awaiting_merge.
      let taskId = '';
      for (let i = 0; i < 60; i++) {
        const { plan } = await apiJson<{ plan: { tasks: Array<{ id: string; status: string }> } }>(
          `/api/projects/${project.id}/plan`,
        );
        taskId = plan.tasks[0].id;
        if (plan.tasks[0].status === 'awaiting_merge') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(taskId).toBeTruthy();

      const mergeRes = await apiJson<{ task: { status: string }; mergeCommitSha: string }>(
        `/api/projects/${project.id}/tasks/${taskId}/approve-merge`,
        { method: 'POST', body: JSON.stringify({ runIntegration: false }) },
      );
      expect(mergeRes.task.status).toBe('done');

      const prRes = await apiJson<{ result: { pushed: boolean; prUrl: string | null } }>(
        `/api/projects/${project.id}/tasks/${taskId}/push-pr`,
        { method: 'POST', body: JSON.stringify({ remote: 'origin', createPr: true }) },
      );
      expect(prRes.result.pushed).toBe(true);
      expect(prRes.result.prUrl).toBe('https://github.com/example/browser-replay/pull/12');

      // 2. Verify provider status returns rich ProviderModelInfo objects and is cached until refresh.
      const status1 = await apiJson<{ providers: Array<{ id: string; models: Array<{ displayName: string; variants: unknown[] }> }> }>(
        '/api/providers/status',
      );
      const claudeStatus = status1.providers.find((p) => p.id === 'claude-code')!;
      expect(claudeStatus.models.some((m) => m.displayName === 'Fable' && m.variants.length === 1)).toBe(true);

      // 3. Drive the real built web UI in headless Chromium if Chrome + web dist are available.
      const chromeBin = findChromeBinary();
      if (chromeBin && fs.existsSync(path.join(WEB_DIST_DIR, 'index.html'))) {
        const browser = await launchHeadlessChrome(chromeBin, server.url);
        try {
          const waitForText = async (needle: string) => {
            for (let i = 0; i < 50; i++) {
              const text = await browser.cdp.evalJs<string>('document.body.innerText');
              if (text.includes(needle)) return text;
              await new Promise((r) => setTimeout(r, 100));
            }
            const last = await browser.cdp.evalJs<string>('document.body.innerText');
            throw new Error(`Timed out waiting for text "${needle}". Body: ${last.slice(0, 400)}`);
          };

          // Home page renders project from replay server.
          await waitForText('Browser Replay App');

          // Navigate to Providers tab and verify rich model display names, token/cost stats, and profile modal.
          await browser.cdp.evalJs(`
            [...document.querySelectorAll('button')].find(b => b.textContent?.includes('Providers'))?.click();
          `);
          const provText = await waitForText('Tokens & Estimated Cost by Model');
          expect(provText).toContain('Not your subscription bill');
          expect(provText).toContain('Opus');

          // Open New Profile modal, check model dropdown display names, max effort, and Account config directory input.
          await browser.cdp.evalJs(`
            [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'New profile')?.click();
          `);
          await waitForText('Account config directory (optional)');
          const modelOptions = await browser.cdp.evalJs<string[]>(`
            [...document.querySelectorAll('#prof-model option')].map(o => o.textContent?.trim() || '')
          `);
          expect(modelOptions).toContain('Opus');
          expect(modelOptions).toContain('Fable');

          // Select Fable -> 1M context variant checkbox should appear and effort should include max.
          await browser.cdp.evalJs(`
            const sel = document.getElementById('prof-model');
            const fableOpt = [...sel.options].find(o => o.textContent?.trim() === 'Fable');
            const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
            setter.call(sel, fableOpt.value);
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          `);
          await waitForText('Use 1M context');
          const effortOptions = await browser.cdp.evalJs<string[]>(`
            [...document.querySelectorAll('#prof-effort option')].map(o => o.value)
          `);
          expect(effortOptions).toContain('max');

          // Close modal with Cancel button.
          await browser.cdp.evalJs(`
            [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Cancel')?.click();
          `);

          // Open the Guard stage for the active project and verify Open PR link and Remote push section.
          await browser.cdp.evalJs(`
            [...document.querySelectorAll('button')].find(b => b.textContent?.includes('Guard'))?.click();
          `);
          const guardText = await waitForText('Remote push and pull request');
          expect(guardText).toContain('Open PR');

          // Exercise dark mode toggle and verify theme switches cleanly.
          await browser.cdp.evalJs(`
            [...document.querySelectorAll('button')].find(b => b.textContent?.includes('Dark mode'))?.click();
          `);
          const darkTheme = await browser.cdp.evalJs<string>('document.documentElement.dataset.theme');
          expect(darkTheme).toBe('dark');

          // Check mobile viewport (390px) for zero horizontal overflow.
          await browser.cdp.send('Emulation.setDeviceMetricsOverride', {
            width: 390,
            height: 844,
            deviceScaleFactor: 1,
            mobile: true,
          });
          await new Promise((r) => setTimeout(r, 150));
          const overflowPx = await browser.cdp.evalJs<number>(
            'document.documentElement.scrollWidth - document.documentElement.clientWidth',
          );
          expect(overflowPx).toBeLessThanOrEqual(1);

          // Verify zero console errors and zero uncaught page errors.
          expect(browser.cdp.consoleErrors).toEqual([]);
          expect(browser.cdp.pageErrors).toEqual([]);
        } finally {
          await browser.close();
        }
      }
    } finally {
      await server.close();
    }
  }, 45_000);
});
