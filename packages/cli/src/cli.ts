import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DALANG_VERSION } from '@dalang/core';
import { startDalangServer } from '@dalang/server';
import { formatDoctorReport, runDoctorChecks } from './doctor.js';

export { DALANG_VERSION };

function resolveWebDistDir(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../web-dist'),
    path.resolve(here, '../../web/dist'),
  ];
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'index.html')));
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {
    // Headless environment or missing opener: URL is printed to stdout.
  });
  child.unref();
}

function printHelp(): void {
  console.log(`DALANG v${DALANG_VERSION} - Local orchestrator for Claude Code, Codex, and Antigravity CLI

Usage:
  dalang [options]          Start the local DALANG server and open the browser
  dalang doctor [--json]    Check Node, git, sandbox, data directory, and CLI logins
  dalang --version          Print version
  dalang --help             Show this help

Options:
  --port <number>           Port to bind on 127.0.0.1 (default: 4173 or DALANG_PORT)
  --no-open                 Do not open the browser automatically
`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(DALANG_VERSION);
    return;
  }

  if (argv[0] === 'doctor') {
    const asJson = argv.includes('--json');
    const report = await runDoctorChecks();
    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatDoctorReport(report));
    }
    if (!report.ok) {
      process.exitCode = 1;
    }
    return;
  }

  let port = Number(process.env.DALANG_PORT || 4173);
  let shouldOpen = true;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--no-open') {
      shouldOpen = false;
    } else if (argv[i] === '--port' && argv[i + 1]) {
      port = Number(argv[i + 1]);
      i++;
    }
  }

  const staticDir = resolveWebDistDir();
  const { url, close } = await startDalangServer({ port, staticDir });
  console.log(`DALANG v${DALANG_VERSION} running at ${url}`);
  if (!staticDir) {
    console.log('Note: web UI dist not found. Run `pnpm build` first.');
  }

  if (shouldOpen) {
    openBrowser(url);
  }

  const shutdown = async () => {
    await close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
