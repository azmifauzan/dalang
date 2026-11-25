import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DALANG_VERSION } from '@dalang/core';
import { startDalangServer } from '@dalang/server';
import { formatDoctorReport, runDoctorChecks } from './doctor.js';
import { startTerminalRoom } from './tui/index.js';
import {
  formatConnectedClisUpdateLines,
  formatUpdateReport,
  runConnectedClisUpdate,
  runUpdate,
} from './update.js';

export { DALANG_VERSION };

export type ResolvedCliCommand =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'doctor'; asJson: boolean }
  | { kind: 'update'; asJson: boolean; checkOnly: boolean; clisOnly: boolean; includeClis: boolean }
  | { kind: 'room'; port: number }
  | { kind: 'web'; port: number; shouldOpen: boolean; deprecated: boolean };

function parseWebOptions(
  args: string[],
  defaultPort: number,
): { port: number; shouldOpen: boolean; hasWebFlags: boolean } {
  let port = defaultPort;
  let shouldOpen = true;
  let hasWebFlags = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--no-open') {
      shouldOpen = false;
      hasWebFlags = true;
    } else if (args[i] === '--port' && args[i + 1]) {
      port = Number(args[i + 1]);
      hasWebFlags = true;
      i++;
    } else if (args[i]?.startsWith('--port=')) {
      port = Number(args[i].slice('--port='.length));
      hasWebFlags = true;
    }
  }

  return { port, shouldOpen, hasWebFlags };
}

export function resolveCliCommand(
  argv: string[],
  opts: { isTTY?: boolean; envPort?: string } = {},
): ResolvedCliCommand {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { kind: 'help' };
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    return { kind: 'version' };
  }

  const defaultPort = Number(opts.envPort ?? process.env.DALANG_PORT ?? 4173);

  if (argv[0] === 'doctor') {
    return { kind: 'doctor', asJson: argv.includes('--json') };
  }

  if (argv[0] === 'update') {
    const clisFlag = argv.includes('--clis') || argv.includes('clis');
    const allFlag = argv.includes('--all') || argv.includes('all');
    const checkOnly = argv.includes('--check') || argv.includes('check');
    return {
      kind: 'update',
      asJson: argv.includes('--json'),
      checkOnly,
      clisOnly: clisFlag && !allFlag,
      includeClis: clisFlag || allFlag,
    };
  }

  if (argv[0] === 'web') {
    const { port, shouldOpen } = parseWebOptions(argv.slice(1), defaultPort);
    return { kind: 'web', port, shouldOpen, deprecated: false };
  }

  if (argv[0] === 'room') {
    const { port } = parseWebOptions(argv.slice(1), defaultPort);
    return { kind: 'room', port };
  }

  const { port, shouldOpen, hasWebFlags } = parseWebOptions(argv, defaultPort);
  // Compatibility for one release: `dalang --port N` or `dalang --no-open` without a subcommand
  // keeps starting the web server with a deprecation notice.
  if (hasWebFlags) {
    return { kind: 'web', port, shouldOpen, deprecated: true };
  }

  const isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!isTTY) {
    return { kind: 'web', port, shouldOpen, deprecated: false };
  }

  return { kind: 'room', port };
}

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
  dalang                            Open the terminal team room (falls back to \`dalang web\` if not a TTY)
  dalang room [--port <number>]     Open the terminal team room on another port
  dalang web [options]              Start the local DALANG web server and open the browser
  dalang doctor [--json]            Check Node, git, sandbox, data directory, terminal, and CLI logins
  dalang update [--check|--clis|--all] [--json]
                                    Check/install DALANG updates and/or update all connected CLIs
  dalang --version                  Print version
  dalang --help                     Show this help

Web options:
  --port <number>                   Port to bind on 127.0.0.1 (default: 4173 or DALANG_PORT)
  --no-open                         Do not open the browser automatically
`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const cmd = resolveCliCommand(argv);

  if (cmd.kind === 'help') {
    printHelp();
    return;
  }
  if (cmd.kind === 'version') {
    console.log(DALANG_VERSION);
    return;
  }

  if (cmd.kind === 'doctor') {
    const report = await runDoctorChecks();
    if (cmd.asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatDoctorReport(report));
    }
    if (!report.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (cmd.kind === 'update') {
    const onStatus = cmd.asJson ? undefined : (line: string) => console.log(line);
    const dalangReport = cmd.clisOnly
      ? null
      : await runUpdate(undefined, { checkOnly: cmd.checkOnly, onStatus });
    const clisReport = cmd.includeClis
      ? await runConnectedClisUpdate(undefined, { onStatus })
      : null;

    if (cmd.asJson) {
      if (dalangReport && !clisReport) {
        console.log(JSON.stringify(dalangReport, null, 2));
      } else if (clisReport && !dalangReport) {
        console.log(JSON.stringify(clisReport, null, 2));
      } else {
        console.log(
          JSON.stringify(
            {
              ok: Boolean(dalangReport?.ok && clisReport?.ok),
              dalang: dalangReport,
              clis: clisReport,
            },
            null,
            2,
          ),
        );
      }
    } else {
      if (dalangReport) {
        console.log(formatUpdateReport(dalangReport));
        if (dalangReport.updated) {
          console.log('Restart any running DALANG session (/restart) to use the new version.');
        }
      }
      if (clisReport) {
        console.log(['Connected CLI updates:', ...formatConnectedClisUpdateLines(clisReport.results)].join('\n'));
      }
    }
    if ((dalangReport && !dalangReport.ok) || (clisReport && !clisReport.ok)) {
      process.exitCode = 1;
    }
    return;
  }

  const staticDir = resolveWebDistDir();

  if (cmd.kind === 'room') {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error('The terminal room needs an interactive terminal. Use `dalang web` instead.');
      process.exitCode = 1;
      return;
    }
    await startTerminalRoom({
      port: cmd.port,
      staticDir,
      openBrowser,
    });
    return;
  }

  if (cmd.deprecated) {
    console.error(
      'Deprecation notice: starting the web server via `dalang --port` / `dalang --no-open` is deprecated. Use `dalang web` instead.',
    );
  }

  const { url, close } = await startDalangServer({ port: cmd.port, staticDir });
  console.log(`DALANG v${DALANG_VERSION} running at ${url}`);
  if (!staticDir) {
    console.log('Note: web UI dist not found. Run `pnpm build` first.');
  }

  if (cmd.shouldOpen) {
    openBrowser(url);
  }

  const shutdown = async () => {
    await close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
