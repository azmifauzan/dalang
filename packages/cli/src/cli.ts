import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDalangServer } from '@dalang/server';

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

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let port = Number(process.env.DALANG_PORT || 4173);
  let shouldOpen = true;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--no-open') {
      shouldOpen = false;
    } else if (args[i] === '--port' && args[i + 1]) {
      port = Number(args[i + 1]);
      i++;
    }
  }

  const staticDir = resolveWebDistDir();
  const { url, close } = await startDalangServer({ port, staticDir });
  console.log(`DALANG v0.1 (Rembuk) running at ${url}`);
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
