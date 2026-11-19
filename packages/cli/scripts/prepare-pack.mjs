import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(here, '..');
const repoRoot = path.resolve(cliRoot, '../..');
const webDistSrc = path.join(repoRoot, 'packages/web/dist');
const webDistDst = path.join(cliRoot, 'web-dist');

if (fs.existsSync(path.join(webDistSrc, 'index.html'))) {
  fs.rmSync(webDistDst, { recursive: true, force: true });
  fs.cpSync(webDistSrc, webDistDst, { recursive: true });
}

for (const doc of ['README.md', 'LICENSE']) {
  const src = path.join(repoRoot, doc);
  const dst = path.join(cliRoot, doc);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
  }
}
