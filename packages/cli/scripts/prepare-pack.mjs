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

const readme = path.join(repoRoot, 'README.md');
if (fs.existsSync(readme)) {
  const github = 'https://github.com/azmifauzan/dalang';
  const blob = `${github}/blob/main`;
  const raw = 'https://raw.githubusercontent.com/azmifauzan/dalang/main';
  const npmReadme = fs.readFileSync(readme, 'utf8')
    .replace(/(!?\[[^\]\n]*\])\((?:\.\/)?((?:docs\/|packages\/)[^)]+|CHANGELOG\.md|LICENSE)\)/g,
      (_, label, target) => `${label}(${label.startsWith('!') ? raw : blob}/${target})`)
    .replace(/(href|src)="\.\/([^"]+)"/g,
      (_, attribute, target) => `${attribute}="${attribute === 'src' ? raw : blob}/${target}"`);
  fs.writeFileSync(path.join(cliRoot, 'README.md'), npmReadme);
}

const license = path.join(repoRoot, 'LICENSE');
if (fs.existsSync(license)) {
  fs.copyFileSync(license, path.join(cliRoot, 'LICENSE'));
}
