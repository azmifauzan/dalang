import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findNestedRepos } from '../services/git.js';

describe('findNestedRepos', () => {
  it('lists top-level folders that are their own git repository', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalang-nested-'));
    try {
      fs.mkdirSync(path.join(dir, '.git'));
      fs.mkdirSync(path.join(dir, 'frontend', '.git'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'docs'));
      expect(findNestedRepos(dir)).toEqual(['frontend']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
