import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliRunner, RunCommandOptions, RunCommandResult } from '@dalang/core';
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

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@local',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@local',
    },
  }).trim();
}

function initRepo(dir: string, branch: string, files: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-b', branch);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', `init ${path.basename(dir)}`);
}

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
        this.consoleErrors.push(JSON.stringify(msg.params.args ?? []));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.pageErrors.push(JSON.stringify(msg.params));
      }
    });
  }

  static async connect(wsUrl: string): Promise<SimpleCdpClient> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', (err) => reject(new Error(`CDP WS error: ${String(err)}`)), { once: true });
    });
    return new SimpleCdpClient(ws);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evalJs<T = unknown>(expression: string): Promise<T> {
    const res = await this.send<{ result?: { value?: T }; exceptionDetails?: { text?: string } }>(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
    );
    if (res.exceptionDetails) {
      throw new Error(`Browser eval failed: ${res.exceptionDetails.text ?? 'exception'}`);
    }
    return res.result?.value as T;
  }

  close(): void {
    this.ws.close();
  }
}

async function launchBrowser(chromeBin: string, url: string) {
  const userDataDir = makeTempDir('dalang-ws-chrome-');
  const child: ChildProcess = spawn(
    chromeBin,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--window-size=1280,900',
      url,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Chrome launch timeout: ${stderr}`)), 15_000);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      const m = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited (${code}): ${stderr}`));
    });
  });

  // The page target can appear a moment after the DevTools port opens.
  let page: { type: string; webSocketDebuggerUrl: string } | undefined;
  for (let i = 0; i < 50 && !page; i++) {
    const pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
      type: string;
      webSocketDebuggerUrl: string;
    }>;
    page = pages.find((p) => p.type === 'page') ?? pages[0];
    if (!page) await new Promise((r) => setTimeout(r, 100));
  }
  if (!page) throw new Error('Chrome opened no page target');
  const cdp = await SimpleCdpClient.connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  return {
    cdp,
    close: async () => {
      cdp.close();
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 150));
      if (!child.killed) child.kill('SIGKILL');
    },
  };
}

describe('v0.9 nested-repo workspace Replay E2E', () => {
  it('completes a Quick task touching a nested repo, shows repo labels in diff view, and merges cleanly over dirty unrelated files', async () => {
    const dataDir = makeTempDir('dalang-ws-e2e-data-');
    const rootDir = path.join(makeTempDir('dalang-ws-e2e-proj-'), 'workspace');
    const frontendDir = path.join(rootDir, 'frontend');
    const backendDir = path.join(rootDir, 'backend');

    initRepo(rootDir, 'dev', {
      '.gitignore': 'frontend/\nbackend/\n',
      'README.md': '# Workspace fixture\n',
    });
    initRepo(frontendDir, 'dev', {
      'app.mjs': 'export function double(n) { return n + 1; }\n',
      'app.test.mjs':
        "import assert from 'node:assert/strict';\nimport { double } from './app.mjs';\nassert.equal(double(4), 8);\nconsole.log('frontend test ok');\n",
      'uncommitted.txt': 'keep me\n',
    });
    initRepo(backendDir, 'feat/api', {
      'server.mjs': 'export const ok = true;\n',
    });

    // Leave unrelated dirty edit in frontend/uncommitted.txt.
    fs.writeFileSync(path.join(frontendDir, 'uncommitted.txt'), 'keep me modified\n');

    const runner: CliRunner = {
      async which(bin) {
        if (bin === 'bwrap' || bin === 'sandbox-exec') return null;
        if (bin === 'claude' || bin === 'codex' || bin === 'agy') return `/usr/local/bin/${bin}`;
        return null;
      },
      async run(command, args, opts: RunCommandOptions): Promise<RunCommandResult> {
        const joined = `${command} ${args.join(' ')}\n${opts.stdinData ?? ''}`;

        if (args.includes('--version')) {
          return { exitCode: 0, stdout: '1.0.0\n', stderr: '', timedOut: false, idleTimedOut: false };
        }
        if (joined.includes('auth status')) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth' }),
            stderr: '',
            timedOut: false,
            idleTimedOut: false,
          };
        }
        if (joined.includes('login status')) {
          return { exitCode: 0, stdout: 'Logged in', stderr: '', timedOut: false, idleTimedOut: false };
        }
        if (joined.includes('/bin/sh') && args.includes('-c')) {
          const cmdStr = args[args.indexOf('-c') + 1] ?? '';
          const out = execFileSync('/bin/sh', ['-c', cmdStr], { cwd: opts.cwd, encoding: 'utf8' });
          opts.onStdoutLine?.(out.trim());
          return { exitCode: 0, stdout: out, stderr: '', timedOut: false, idleTimedOut: false };
        }

        // Quick mini-plan targeting frontend/app.mjs
        const quickMatch = joined.match(/(\.dalang\/sessions\/[A-Za-z0-9_-]+\/tmp\/quick-plan-v\d+\.json)/);
        if (quickMatch) {
          const target = path.join(opts.cwd, quickMatch[1]);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(
            target,
            JSON.stringify({
              verdict: 'ready',
              summary: 'Fix double() in frontend/app.mjs.',
              findings: ['frontend/app.mjs currently returns n + 1 instead of n * 2.'],
              task: {
                id: 'T-001',
                title: 'Fix double() in frontend/app.mjs',
                milestone: 'Quick',
                role: 'engineer',
                complexity: 'low',
                depends_on: [],
                goal: 'Change double(n) in frontend/app.mjs to return n * 2.',
                files_allowed: ['frontend/app.mjs'],
                files_reference: ['frontend/app.test.mjs'],
                acceptance_criteria: ['node frontend/app.test.mjs passes'],
                verify: 'node frontend/app.test.mjs',
                needs_split: false,
              },
            }),
          );
          const line = JSON.stringify({ type: 'result', session_id: 'lead-ws-q1', result: 'Quick plan ready.' });
          opts.onStdoutLine?.(line);
          return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
        }

        // Reviewer
        if (/code review round \d+ of \d+ for task T-001/i.test(joined)) {
          const payload = JSON.stringify({
            task_id: 'T-001',
            status: 'pass',
            verify_exit_code: 0,
            summary: 'Verified frontend/app.mjs fix.',
            findings: [],
          });
          const line = JSON.stringify({ type: 'result', session_id: 'rev-ws-1', result: payload });
          opts.onStdoutLine?.(line);
          return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
        }

        // Coder edits frontend/app.mjs inside the nested worktree
        const resMatch = joined.match(/(\.dalang\/sessions\/[A-Za-z0-9_-]+\/tasks\/T-001\/result\.json)/);
        if (resMatch) {
          fs.writeFileSync(
            path.join(opts.cwd, 'frontend/app.mjs'),
            'export function double(n) { return n * 2; }\n',
          );
          const target = path.join(opts.cwd, resMatch[1]);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(
            target,
            JSON.stringify({
              task_id: 'T-001',
              status: 'completed',
              changed_files: ['frontend/app.mjs'],
              summary: 'Fixed double() in frontend/app.mjs',
              notes: [],
              blockers: [],
              verify_command: 'node frontend/app.test.mjs',
              verify_exit_code: 0,
            }),
          );
          const line = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Fixed' } });
          opts.onStdoutLine?.(line);
          return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
        }

        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
      },
    };

    const server = await startDalangServer({
      port: 0,
      dbPath: path.join(dataDir, 'dalang.db'),
      staticDir: WEB_DIST_DIR,
      runner,
      updateFetcher: async () => null,
    });

    try {
      const apiJson = async <T>(p: string, init?: RequestInit): Promise<T> => {
        const res = await fetch(`${server.url}${p}`, {
          ...init,
          headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
        });
        const body = (await res.json()) as T & { error?: string };
        if (!res.ok) throw new Error(`HTTP ${res.status} ${p}: ${body.error ?? JSON.stringify(body)}`);
        return body;
      };

      const { project } = await apiJson<{ project: { id: string; mainBranch: string } }>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ mode: 'open', name: 'Workspace Fixture', path: rootDir, leadProvider: 'claude-code' }),
      });
      // Commit scaffold files so root is clean.
      git(rootDir, 'add', '-A');
      if (git(rootDir, 'status', '--porcelain')) {
        git(rootDir, 'commit', '-m', 'chore: scaffold');
      }

      const chromeBin = findChromeBinary();
      if (chromeBin && fs.existsSync(path.join(WEB_DIST_DIR, 'index.html'))) {
        const browser = await launchBrowser(chromeBin, server.url);
        try {
          const waitForText = async (needle: string, tries = 80): Promise<string> => {
            for (let i = 0; i < tries; i++) {
              const txt = await browser.cdp.evalJs<string>('document.body?.innerText || ""');
              if (txt.includes(needle)) return txt;
              await new Promise((r) => setTimeout(r, 100));
            }
            const last = await browser.cdp.evalJs<string>('document.body?.innerText || ""');
            throw new Error(`Timed out waiting for "${needle}". Page:\n${last.slice(-1500)}`);
          };
          const clickButton = async (label: string) => {
            const ok = await browser.cdp.evalJs<boolean>(`(() => {
              const btn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === ${JSON.stringify(label)} && !b.disabled);
              if (!btn) return false;
              btn.click();
              return true;
            })()`);
            expect(ok).toBe(true);
          };

          await waitForText('Workspace Fixture');
          await browser.cdp.evalJs(`(() => {
            const btn = [...document.querySelectorAll('main [role="group"] button')].find(b => b.textContent?.trim() === 'Quick');
            btn?.click();
          })()`);
          await browser.cdp.evalJs(`(() => {
            const el = document.querySelector('main textarea');
            const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            setter.call(el, 'Fix double() in frontend/app.mjs');
            el.dispatchEvent(new Event('input', { bubbles: true }));
          })()`);
          await browser.cdp.evalJs(`document.querySelector('main form button[type="submit"]')?.click()`);

          await waitForText('Mini plan ready');
          await waitForText('Run without sandbox confinement');
          await browser.cdp.evalJs(`(() => {
            const label = [...document.querySelectorAll('main label')].find(el => el.textContent?.includes('Run without sandbox confinement'));
            const checkbox = label?.querySelector('input[type="checkbox"]');
            if (checkbox && !checkbox.checked) checkbox.click();
          })()`);
          await clickButton('Run');
          await waitForText('Approve & merge', 120);

          // Open inline diff view and verify nested repo badge (`frontend/`) and file path.
          await clickButton('Show diff');
          const diffViewText = await waitForText('return n * 2;');
          expect(diffViewText).toContain('frontend/');
          expect(diffViewText).toContain('frontend/app.mjs');

          // Merge and verify real nested repo branch + dirty file preserved.
          await clickButton('Approve & merge');
          await waitForText('Merged onto dev', 80);

          expect(execFileSync('node', ['frontend/app.test.mjs'], { cwd: rootDir, encoding: 'utf8' })).toContain(
            'frontend test ok',
          );
          expect(fs.readFileSync(path.join(frontendDir, 'uncommitted.txt'), 'utf8')).toBe('keep me modified\n');
          expect(browser.cdp.consoleErrors).toEqual([]);
          expect(browser.cdp.pageErrors).toEqual([]);
        } finally {
          await browser.close();
        }
      } else {
        // Fallback HTTP API flow if Chromium is unavailable in the environment.
        const chat = await apiJson<{ session: { id: string } }>(`/api/projects/${project.id}/chat`, {
          method: 'POST',
          body: JSON.stringify({ mode: 'quick', message: 'Fix double() in frontend/app.mjs' }),
        });
        await apiJson(`/api/projects/${project.id}/sessions/${chat.session.id}/quick-run`, {
          method: 'POST',
          body: JSON.stringify({ allowUnconfined: true }),
        });
        let guard: { tasks: Array<{ task: { id: string; status: string } }> } = { tasks: [] };
        for (let i = 0; i < 60; i++) {
          guard = await apiJson(`/api/projects/${project.id}/guard?sessionId=${chat.session.id}`);
          if (guard.tasks[0]?.task.status === 'awaiting_merge') break;
          await new Promise((r) => setTimeout(r, 100));
        }
        const taskId = guard.tasks[0].task.id;
        const { diff } = await apiJson<{ diff: { files: Array<{ path: string; repo?: string }> } }>(
          `/api/projects/${project.id}/tasks/${taskId}/diff`,
        );
        expect(diff.files.find((f) => f.path === 'frontend/app.mjs')?.repo).toBe('frontend');
        await apiJson(`/api/projects/${project.id}/tasks/${taskId}/approve-merge`, {
          method: 'POST',
          body: JSON.stringify({ runIntegration: false }),
        });
        expect(execFileSync('node', ['frontend/app.test.mjs'], { cwd: rootDir, encoding: 'utf8' })).toContain(
          'frontend test ok',
        );
        expect(fs.readFileSync(path.join(frontendDir, 'uncommitted.txt'), 'utf8')).toBe('keep me modified\n');
      }
    } finally {
      await server.close();
    }
  }, 60_000);
});
