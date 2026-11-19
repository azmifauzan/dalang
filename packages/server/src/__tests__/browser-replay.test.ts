import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
      '--lang=en-US',
      '--window-size=1280,900',
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

describe('v0.6 browser scenarios on a real server with the replay runner', () => {
  it('runs upgrade path (existing project), 5-step shell, Config 6 tabs, Statistics, Work stage, i18n, theme, update notice, and mobile drawer', async () => {
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
      updateFetcher: async () => '0.7.0',
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

      // 1. Seed a project via real HTTP API, execute with replay runner, merge, and push/PR.
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

      const mergeRes = await apiJson<{ task: { status: string } }>(
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

      // 2. Drive the built v0.6 web UI in headless Chromium.
      const chromeBin = findChromeBinary();
      if (chromeBin && fs.existsSync(path.join(WEB_DIST_DIR, 'index.html'))) {
        const browser = await launchHeadlessChrome(chromeBin, server.url);
        try {
          const waitForText = async (needle: string) => {
            for (let i = 0; i < 60; i++) {
              const text = await browser.cdp.evalJs<string>('document.body.innerText');
              if (text.includes(needle)) return text;
              await new Promise((r) => setTimeout(r, 100));
            }
            const last = await browser.cdp.evalJs<string>('document.body.innerText');
            throw new Error(`Timed out waiting for text "${needle}". Body: ${last.slice(0, 500)}`);
          };

          const clickButton = async (label: string, exact = false) => {
            const pred = exact
              ? `(b.textContent?.trim() || b.getAttribute('aria-label')) === ${JSON.stringify(label)}`
              : `(b.textContent?.trim() || b.getAttribute('aria-label') || '').includes(${JSON.stringify(label)})`;
            const clicked = await browser.cdp.evalJs<boolean>(`(() => {
              const btns = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null);
              const hit = btns.find(b => ${pred});
              if (!hit) return false;
              hit.click();
              return true;
            })()`);
            if (!clicked) {
              const avail = await browser.cdp.evalJs<string[]>(
                `[...document.querySelectorAll('button')].filter(b => b.offsetParent !== null).map(b => b.textContent?.trim())`,
              );
              throw new Error(`Button "${label}" not found. Visible buttons: ${JSON.stringify(avail)}`);
            }
          };

          // Upgrade path: existing project skips wizard and opens straight into workspace + 5-step stepper + update notice.
          const homeText = await waitForText('Browser Replay App');
          expect(homeText).not.toContain('Welcome to DALANG');
          expect(homeText.toLowerCase()).toContain('next step');
          expect(homeText).toContain('Review & merge');
          await waitForText('Version 0.7.0 is available');

          // Work stage (Step 4 is default for approved plan): verify stage pause toggle & visibilitychange pause.
          await waitForText('Wayang stage');
          expect(
            await browser.cdp.evalJs<string>(`document.querySelector('[data-stage-paused]')?.getAttribute('data-stage-paused')`),
          ).toBe('false');
          await clickButton('Pause motion');
          await waitForText('Play motion');
          expect(
            await browser.cdp.evalJs<string>(`document.querySelector('[data-stage-paused]')?.getAttribute('data-stage-paused')`),
          ).toBe('true');
          await clickButton('Play motion');
          await waitForText('Pause motion');
          // Simulate tab becoming hidden
          await browser.cdp.evalJs(`
            Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
            document.dispatchEvent(new Event('visibilitychange'));
          `);
          await new Promise((r) => setTimeout(r, 80));
          expect(
            await browser.cdp.evalJs<string>(`document.querySelector('[data-stage-paused]')?.getAttribute('data-stage-paused')`),
          ).toBe('true');
          await browser.cdp.evalJs(`
            Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
            document.dispatchEvent(new Event('visibilitychange'));
          `);

          // Step 5 (Review & merge): verify Open PR link and Remote push section.
          await clickButton('Review & merge');
          const guardText = await waitForText('Remote push and pull request');
          expect(guardText).toContain('Open PR');

          // Sidebar -> Statistics page: verify token/cost table & disclaimer.
          await clickButton('Statistics');
          const statsText = await waitForText('Tokens & Estimated Cost by Model');
          expect(statsText).toContain('Not your subscription bill');
          expect(statsText).toContain('4.2k');
          expect(statsText).toContain('$0.0092');

          // Sidebar -> Config swaps sidebar to Back + 6 tabs.
          await clickButton('Config');
          await waitForText('Check for new versions');

          // Config -> Agents: verify provider status & rich model display names.
          await clickButton('Agents', true);
          const agentsText = await waitForText('Refresh CLI status');
          expect(agentsText).toContain('Opus');
          expect(agentsText).toContain('Fable');

          // Config -> Team: sungging wayang cards + New profile modal (Fable 1M, max effort, configDir).
          await clickButton('Team', true);
          await waitForText('New profile');
          await clickButton('New profile', true);
          await waitForText('Account config directory (optional)');
          const modelOptions = await browser.cdp.evalJs<string[]>(
            `[...document.querySelectorAll('#prof-model option')].map(o => o.textContent?.trim() || '')`,
          );
          expect(modelOptions).toContain('Opus');
          expect(modelOptions).toContain('Fable');
          await browser.cdp.evalJs(`
            const sel = document.getElementById('prof-model');
            const fableOpt = [...sel.options].find(o => o.textContent?.trim() === 'Fable');
            const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
            setter.call(sel, fableOpt.value);
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          `);
          await waitForText('Use 1M context');
          const effortOptions = await browser.cdp.evalJs<string[]>(
            `[...document.querySelectorAll('#prof-effort option')].map(o => o.value)`,
          );
          expect(effortOptions).toContain('max');
          await clickButton('Cancel', true);

          // Config -> Task routing: plain sentences.
          await clickButton('Task routing', true);
          const routingText = await waitForText('New routing rule');
          expect(routingText).toContain('->');

          // Config -> Security: sandbox + keyring toggle.
          await clickButton('Security', true);
          await waitForText('Allow Antigravity to read the desktop keyring');

          // Config -> About: Gunungan + update commands + Tropenmuseum CC BY-SA 3.0 credits.
          await clickButton('About', true);
          const aboutText = await waitForText('Tropenmuseum');
          expect(aboutText).toContain('npx dalang-cli@latest');
          expect(aboutText).toContain('npm install -g dalang-cli@latest');
          expect(aboutText).toContain('CC BY-SA 3.0');

          // Config -> General: toggle update check off hides sidebar notice, back on restores it.
          await clickButton('General', true);
          await waitForText('Notify me when a newer version of DALANG is published');
          await browser.cdp.evalJs(`document.querySelector('main input[type="checkbox"]')?.click()`);
          await new Promise((r) => setTimeout(r, 300));
          expect(await browser.cdp.evalJs<string>('document.body.innerText')).not.toContain(
            'Version 0.7.0 is available',
          );
          await browser.cdp.evalJs(`document.querySelector('main input[type="checkbox"]')?.click()`);
          await waitForText('Version 0.7.0 is available');

          // Back from Config returns to previous section (Statistics); click project in sidebar to return to workspace.
          await clickButton('Back');
          await waitForText('Tokens & Estimated Cost by Model');
          await clickButton('Browser Replay App');
          await waitForText('Review & merge');

          // Language switcher ID <-> EN and server persistence.
          await clickButton('id', true);
          const idText = await waitForText('Tinjau & gabung');
          expect(idText.toLowerCase()).toContain('langkah berikutnya');
          // Statistics and Config are icon buttons: check their accessible names.
          const iconLabels = await browser.cdp.evalJs<string[]>(
            `[...document.querySelectorAll('aside button[aria-label]')].map(b => b.getAttribute('aria-label'))`,
          );
          expect(iconLabels).toEqual(expect.arrayContaining(['Statistik', 'Pengaturan']));
          expect(idText).toContain('Versi 0.7.0 tersedia');
          const settingsAfterId = await apiJson<{ settings: { language: string | null } }>('/api/settings');
          expect(settingsAfterId.settings.language).toBe('id');

          // No English leaks into the id UI: visit every step, Statistics, and each Config tab, then
          // check the text against every English dictionary value and against raw enum identifiers.
          const enDict = (await import(pathToFileURL(path.resolve(here, '../../../web/src/i18n/en.ts')).href))
            .en as Record<string, string>;
          const idDict = (await import(pathToFileURL(path.resolve(here, '../../../web/src/i18n/id.ts')).href))
            .id as Record<string, string>;
          const leakable = Object.entries(enDict).filter(
            ([k, v]) =>
              v.length >= 6 &&
              !v.includes('{') &&
              idDict[k] !== v &&
              // Loanwords the id dictionary keeps on purpose (for example "Fallback: Tidak ada").
              !Object.values(idDict).some((iv) => iv.includes(v)),
          );
          const seen: string[] = [];
          const collect = async (label: string) => {
            // Run logs and CLI-reported quota windows are agent/provider output, not UI copy.
            const text = await browser.cdp.evalJs<string>(`(() => {
              const root = document.body.cloneNode(true);
              root.querySelectorAll('pre, code').forEach((n) => n.remove());
              document.body.appendChild(root);
              root.style.cssText = 'position:absolute;left:-99999px';
              const out = root.innerText;
              root.remove();
              return out;
            })()`);
            // Window names such as "Current session (5h)" are reported verbatim by the provider CLI.
            seen.push(`## ${label}\n${text.replace(/Current (session|week)[^\n]*/g, '')}`);
          };
          for (const step of ['Diskusi', 'Rencana', 'Pengerjaan', 'Tinjau & gabung']) {
            await clickButton(step);
            await new Promise((r) => setTimeout(r, 250));
            await collect(step);
          }
          await clickButton('Brief');
          await new Promise((r) => setTimeout(r, 250));
          await collect('Brief');
          await clickButton('Statistik', true);
          await new Promise((r) => setTimeout(r, 300));
          await collect('Statistik');
          await clickButton('Pengaturan', true);
          for (const tab of ['Umum', 'Agen', 'Tim', 'Rute tugas', 'Keamanan', 'Tentang']) {
            await clickButton(tab, true);
            await new Promise((r) => setTimeout(r, 300));
            await collect(tab);
          }
          const leaks: string[] = [];
          for (const block of seen) {
            const [head] = block.split('\n');
            for (const [k, v] of leakable) {
              const at = block.indexOf(v);
              if (at >= 0) leaks.push(`${head}: "${v}" (${k}) in «${block.slice(Math.max(0, at - 50), at + v.length + 30).replace(/\n/g, ' | ')}»`);
            }
            for (const m of block.match(/\b(awaiting_merge|review_failed|needs_split|rolled_back)\b/g) ?? []) {
              leaks.push(`${head}: raw enum ${m}`);
            }
          }
          expect(leaks).toEqual([]);

          await clickButton('Kembali');
          await clickButton('Browser Replay App');
          await clickButton('en', true);
          await waitForText('Review & merge');

          // Theme toggle (sun/moon switch) flips between light and dark cleanly.
          const beforeTheme = await browser.cdp.evalJs<string>('document.documentElement.dataset.theme');
          const expectedFlipped = beforeTheme === 'dark' ? 'light' : 'dark';
          await browser.cdp.evalJs(`
            document.querySelector('button[aria-label="Toggle color theme"]')?.click();
          `);
          expect(await browser.cdp.evalJs<string>('document.documentElement.dataset.theme')).toBe(expectedFlipped);
          await browser.cdp.evalJs(`
            document.querySelector('button[aria-label="Toggle color theme"]')?.click();
          `);
          expect(await browser.cdp.evalJs<string>('document.documentElement.dataset.theme')).toBe(beforeTheme);

          // Mobile viewport (390px): zero horizontal overflow + labeled Menu drawer opens & closes.
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
          await clickButton('Menu', true);
          await waitForText('Close');
          await clickButton('Close', true);

          expect(browser.cdp.consoleErrors).toEqual([]);
          expect(browser.cdp.pageErrors).toEqual([]);
        } finally {
          await browser.close();
        }
      }
    } finally {
      await server.close();
    }
  }, 55_000);

  it('auto-opens the 4-screen first-run wizard on a fresh install, stays silent offline, and lands in Discuss', async () => {
    const runner = new ReplayCliRunner({ name: 'wizard-fresh', turns: [] });
    const dbFile = path.join(makeTempDir('dalang-wiz-db-'), 'dalang.db');
    const newProjPath = path.join(makeTempDir('dalang-wiz-proj-'), 'first-app');

    const server = await startDalangServer({
      port: 0,
      dbPath: dbFile,
      staticDir: WEB_DIST_DIR,
      runner,
      // Simulate offline npm registry failure — must fail silently without UI errors.
      updateFetcher: async () => {
        throw new Error('ENOTFOUND registry.npmjs.org');
      },
    });

    try {
      const chromeBin = findChromeBinary();
      if (chromeBin && fs.existsSync(path.join(WEB_DIST_DIR, 'index.html'))) {
        const browser = await launchHeadlessChrome(chromeBin, server.url);
        try {
          const waitForText = async (needle: string) => {
            for (let i = 0; i < 60; i++) {
              const text = await browser.cdp.evalJs<string>('document.body.innerText');
              if (text.includes(needle)) return text;
              await new Promise((r) => setTimeout(r, 100));
            }
            const last = await browser.cdp.evalJs<string>('document.body.innerText');
            throw new Error(`Timed out waiting for text "${needle}". Body: ${last.slice(0, 500)}`);
          };

          const clickButton = async (label: string) => {
            const ok = await browser.cdp.evalJs<boolean>(`(() => {
              const hit = [...document.querySelectorAll('button')]
                .filter(b => b.offsetParent !== null)
                .find(b => b.textContent?.trim() === ${JSON.stringify(label)});
              if (!hit) return false;
              hit.click();
              return true;
            })()`);
            if (!ok) throw new Error(`Wizard button "${label}" not found`);
          };

          // Screen 1: Welcome & How DALANG works (no offline update error shown)
          const s1 = await waitForText('How DALANG works');
          expect(s1).not.toContain('ENOTFOUND');
          expect(s1).not.toContain('is available');

          // Screen 2: Agents
          await clickButton('Next');
          await waitForText('Check your agent CLIs');

          // Screen 3: Recommended team. Next stays disabled until the CLI probe finishes, so wait for it.
          for (let i = 0; i < 50; i += 1) {
            const enabled = await browser.cdp.evalJs<boolean>(
              `[...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Next' && !b.disabled)`,
            );
            if (enabled) break;
            await new Promise((r) => setTimeout(r, 100));
          }
          await clickButton('Next');
          await waitForText('Recommended agent team');

          // Each role is configured with a CLI, a model, and an effort; the fallback picks a team member.
          const setSelect = (match: string, value?: string) => browser.cdp.evalJs<string>(`(() => {
            const sel = [...document.querySelectorAll('select')].find((s) => s.getAttribute('aria-label')?.startsWith(${JSON.stringify(match)}) || s.id === ${JSON.stringify(match)});
            const v = ${JSON.stringify(value ?? null)} ?? [...sel.options].find((o) => o.value && o.value !== sel.value).value;
            Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(sel, v);
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return v;
          })()`);
          const labels = await browser.cdp.evalJs<string[]>(
            `[...document.querySelectorAll('select')].map((s) => s.getAttribute('aria-label') || s.id)`,
          );
          for (const role of ['Lead (Semar)', 'Coder, simple tasks (Bima)', 'Coder, complex tasks (Kresna)', 'Reviewer (Arjuna)']) {
            for (const field of ['CLI', 'Model', 'Reasoning effort']) {
              expect(labels.some((l) => l === `${role}: ${field === 'CLI' ? 'Provider' : field}`)).toBe(true);
            }
          }
          expect(labels).toContain('team-fallback-provider');

          // Switch the simple-task coder to Claude Code and give the complex-task coder a model.
          await setSelect('Coder, simple tasks (Bima): Provider', 'claude-code');
          await new Promise((r) => setTimeout(r, 100));
          const pickedModel = await setSelect('Coder, complex tasks (Kresna): Model');
          await new Promise((r) => setTimeout(r, 100));

          // Screen 4: Create first project
          await clickButton('Accept team & continue');
          await waitForText('Create your first project');
          const saved = await browser.cdp.evalJs<Record<string, string>>(`(async () => {
            const { profiles } = await (await fetch('/api/profiles')).json();
            const { rules } = await (await fetch('/api/routing')).json();
            const eng = (c) => rules.find((x) => x.role === 'engineer' && x.complexity === c)?.profileId;
            return {
              smallProvider: profiles.find((p) => p.id === 'profile-coder-small').provider,
              heavyModel: profiles.find((p) => p.id === 'profile-coder-heavy').model,
              low: eng('low'),
              high: eng('high'),
            };
          })()`);
          expect(saved.smallProvider).toBe('claude-code');
          expect(saved.heavyModel).toBe(pickedModel);
          expect(saved.low).toBe('profile-coder-small');
          expect(saved.high).toBe('profile-coder-heavy');
          // Fallbacks are CLI targets now, not profiles: the engineer/high rule falls back to another CLI.
          const highFallback = await browser.cdp.evalJs<string | null>(`(async () => {
            const { rules } = await (await fetch('/api/routing')).json();
            return rules.find((x) => x.role === 'engineer' && x.complexity === 'high')?.fallback?.provider ?? null;
          })()`);
          expect(highFallback).not.toBeNull();

          // Fill project path, name, and goal
          await browser.cdp.evalJs(`(() => {
            const setVal = (el, val) => {
              const proto = el.tagName === 'TEXTAREA'
                ? window.HTMLTextAreaElement.prototype
                : window.HTMLInputElement.prototype;
              Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val);
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            };
            setVal(document.getElementById('wiz-proj-path'), ${JSON.stringify(newProjPath)});
            setVal(document.getElementById('wiz-proj-name'), 'Wizard Starter App');
            setVal(document.getElementById('wiz-proj-goal'), 'Build a local bookmark CLI tool.');
          })()`);

          await clickButton('Create project & start Discuss');

          // Lands directly in Step 1 (Discuss) with the goal prefilled in the composer!
          await waitForText('Wizard Starter App');
          await waitForText('Start with one clear goal');
          const composerVal = await browser.cdp.evalJs<string>(
            `document.querySelector('textarea')?.value ?? ''`,
          );
          expect(composerVal).toContain('Build a local bookmark CLI tool.');

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
