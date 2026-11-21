import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/client.js';
import { ProjectService } from '../services/project.js';

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

describe('ProjectService (F-01, F-02)', () => {
  it('creates a new project with git init, .dalang/, PROJECT.md, and CLAUDE.md/AGENTS.md symlinks', async () => {
    const dbDir = makeTempDir('dalang-db-');
    const conn = openDatabase(path.join(dbDir, 'dalang.db'));
    const svc = new ProjectService(conn.db);

    const repoDir = path.join(makeTempDir('dalang-proj-'), 'my-app');
    const summary = await svc.createOrOpen({
      mode: 'create',
      name: 'My App',
      path: repoDir,
      stackHint: 'Node 26 + Fastify + React',
      initGitIfMissing: false,
      leadProvider: 'claude-code',
    });

    expect(summary.name).toBe('My App');
    expect(summary.hasProjectMd).toBe(true);
    expect(summary.symlinksValid).toEqual({ claudeMd: true, agentsMd: true });
    expect(fs.existsSync(path.join(repoDir, '.git'))).toBe(true);
    expect(fs.existsSync(path.join(repoDir, '.dalang', 'discuss'))).toBe(true);
    for (const name of ['CLAUDE.md', 'AGENTS.md']) {
      const file = path.join(repoDir, name);
      if (fs.lstatSync(file).isSymbolicLink()) expect(fs.readlinkSync(file)).toBe('PROJECT.md');
      else expect(fs.readFileSync(file, 'utf8')).toContain('PROJECT.md');
    }

    const md = svc.readProjectMd(summary.id);
    expect(md.content).toContain('Node 26 + Fastify + React');

    const updated = svc.writeProjectMd(summary.id, '# My App\n\nUpdated conventions.\n');
    expect(updated.content).toContain('Updated conventions.');
    const claudeFile = path.join(repoDir, 'CLAUDE.md');
    expect(fs.readFileSync(claudeFile, 'utf8')).toContain(
      fs.lstatSync(claudeFile).isSymbolicLink() ? 'Updated conventions.' : 'PROJECT.md',
    );

    conn.close();
  });

  it('opens an existing git repo and rejects non-git directory unless initGitIfMissing is true', async () => {
    const dbDir = makeTempDir('dalang-db-');
    const conn = openDatabase(path.join(dbDir, 'dalang.db'));
    const svc = new ProjectService(conn.db);

    const existingDir = makeTempDir('dalang-existing-');
    await expect(
      svc.createOrOpen({
        mode: 'open',
        path: existingDir,
        initGitIfMissing: false,
        leadProvider: 'codex',
      }),
    ).rejects.toThrow(/not a git repository/i);

    const opened = await svc.createOrOpen({
      mode: 'open',
      path: existingDir,
      initGitIfMissing: true,
      leadProvider: 'codex',
    });
    expect(opened.symlinksValid).toEqual({ claudeMd: true, agentsMd: true });
    expect(svc.listProjects()).toHaveLength(1);

    conn.close();
  });

  it('never replaces a regular CLAUDE.md or AGENTS.md that the repo already owns', async () => {
    const dbDir = makeTempDir('dalang-db-');
    const conn = openDatabase(path.join(dbDir, 'dalang.db'));
    const svc = new ProjectService(conn.db);

    const repoDir = path.join(makeTempDir('dalang-proj-'), 'existing');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'CLAUDE.md'), 'my own rules\n');

    const summary = await svc.createOrOpen({
      mode: 'open',
      name: 'Existing',
      path: repoDir,
      initGitIfMissing: true,
      leadProvider: 'claude-code',
    });
    svc.writeProjectMd(summary.id, '# Updated\n', true);

    expect(fs.readFileSync(path.join(repoDir, 'CLAUDE.md'), 'utf8')).toBe('my own rules\n');
    expect(fs.lstatSync(path.join(repoDir, 'CLAUDE.md')).isSymbolicLink()).toBe(false);
    expect(svc.getProject(summary.id).symlinksValid).toEqual({ claudeMd: false, agentsMd: true });
    expect(fs.readFileSync(path.join(repoDir, '.dalang', '.gitignore'), 'utf8')).toContain('tmp/');
    conn.close();
  });
});
