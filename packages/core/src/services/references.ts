/**
 * Images the user gave with their request (B33): attached in the composer, or named by path in a message.
 * Executors and reviewers are told where they are; before, a reference screenshot outside the worktree
 * never reached the reviewer.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_REFERENCES = 6;
const QUOTED = /(['"])((?:~\/|\/|[A-Za-z]:[\\/])[^'"\n]+?\.(?:png|jpe?g|webp|gif))\1/gi;
const BARE = /(?<![\w'"/])((?:~\/|\/|[A-Za-z]:[\\/])[^\s'"`<>()]+\.(?:png|jpe?g|webp|gif))/gi;

/** Image files that exist and that a user message names by absolute path. */
export function imagePathsInText(text: string, home: string = os.homedir()): string[] {
  const found = [...text.matchAll(QUOTED)].map((m) => m[2]).concat([...text.replace(QUOTED, ' ').matchAll(BARE)].map((m) => m[1]));
  const paths = found.map((p) => (p.startsWith('~/') ? path.join(home, p.slice(2)) : p));
  return [...new Set(paths)].filter((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

export function referenceBlock(files: string[], role: 'executor' | 'reviewer'): string {
  if (files.length === 0) return '';
  return [
    'Reference images the user gave with this request. Open and look at each one before you rely on it:',
    ...files.slice(0, MAX_REFERENCES).map((file) => `- ${file}`),
    role === 'reviewer'
      ? 'If you cannot open an image or cannot see the rendered result, put what you did not check in "unverified". Do not pass a visual criterion on the executor\'s word without saying so there.'
      : 'Match them. If you cannot open one, say so in "notes".',
  ].join('\n');
}
