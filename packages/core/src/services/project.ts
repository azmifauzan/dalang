import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq, desc } from 'drizzle-orm';
import { simpleGit } from 'simple-git';
import type { CreateOrOpenProjectInput, ProjectSummary, ProviderId } from '@dalang/shared';
import { getDbDataDir, type DalangDb } from '../db/client.js';
import { agentProfiles, briefs, plans, projects, routingRules, sessions, tasks } from '../db/schema.js';
import {
  ensureDir,
  getProjectDalangDir,
  getProjectDiscussDir,
  getProjectLogsDir,
  getProjectTmpDir,
  getProjectWorktreesDir,
  getWorktreesRoot,
} from '../paths.js';
import { ensureDalangIgnore, readArtifactFile, writeArtifactFile } from '../safe-fs.js';
import { removeTaskWorktree } from './git.js';

function checkSymlinkPointsTo(linkPath: string, targetName: string): boolean {
  try {
    const stat = fs.lstatSync(linkPath);
    if (!stat.isSymbolicLink()) return false;
    const rawTarget = fs.readlinkSync(linkPath);
    return path.basename(rawTarget) === targetName || rawTarget === targetName;
  } catch {
    return false;
  }
}

export function ensureSymlinks(projectPath: string): { claudeMd: boolean; agentsMd: boolean } {
  const projectMdPath = path.join(projectPath, 'PROJECT.md');
  if (!fs.existsSync(projectMdPath)) {
    return { claudeMd: false, agentsMd: false };
  }

  for (const linkName of ['CLAUDE.md', 'AGENTS.md']) {
    const linkPath = path.join(projectPath, linkName);
    let stat: fs.Stats | null = null;
    try {
      stat = fs.lstatSync(linkPath);
    } catch {
      stat = null;
    }

    if (!stat) {
      fs.symlinkSync('PROJECT.md', linkPath);
    } else if (stat.isSymbolicLink() && fs.readlinkSync(linkPath) !== 'PROJECT.md') {
      fs.unlinkSync(linkPath);
      fs.symlinkSync('PROJECT.md', linkPath);
    }
    // A regular file is the user's own instructions: report it as not linked, never replace it.
  }

  return {
    claudeMd: checkSymlinkPointsTo(path.join(projectPath, 'CLAUDE.md'), 'PROJECT.md'),
    agentsMd: checkSymlinkPointsTo(path.join(projectPath, 'AGENTS.md'), 'PROJECT.md'),
  };
}

const DEFAULT_GITIGNORE = [
  'node_modules/',
  '.venv/',
  '__pycache__/',
  'dist/',
  'build/',
  '.env',
  '.env.*',
  '*.log',
  '.DS_Store',
  '',
].join('\n');

export function buildDefaultProjectMd(name: string, stackHint?: string): string {
  const stackLine = stackHint?.trim() || 'To be confirmed with Lead during Discuss phase.';
  return `# ${name}

## Overview
Project managed with DALANG.

## Stack
${stackLine}

## Folder Structure
- \`.dalang/\`: DALANG orchestration artifacts (brief, plan, discuss rounds, logs)
- \`src/\`: Application source code

## Conventions
- Keep changes small, focused, and verifiable.
- Run tests before marking any task complete.
`;
}

export function ensureProjectScaffold(
  projectPath: string,
  name: string,
  stackHint?: string,
): { hasProjectMd: boolean; symlinksValid: { claudeMd: boolean; agentsMd: boolean } } {
  ensureDir(getProjectDalangDir(projectPath));
  ensureDir(getProjectDiscussDir(projectPath));
  ensureDir(getProjectLogsDir(projectPath));
  ensureDir(getProjectTmpDir(projectPath));

  ensureDalangIgnore(projectPath);

  // Checkpoints run `git add -A`; without an ignore file an agent's `npm install` would be committed.
  const rootIgnore = path.join(projectPath, '.gitignore');
  if (!fs.existsSync(rootIgnore)) {
    writeArtifactFile(projectPath, rootIgnore, DEFAULT_GITIGNORE, 'refuse');
  }

  const projectMdPath = path.join(projectPath, 'PROJECT.md');
  if (!fs.existsSync(projectMdPath)) {
    writeArtifactFile(projectPath, projectMdPath, buildDefaultProjectMd(name, stackHint), 'refuse');
  }

  const symlinksValid = ensureSymlinks(projectPath);
  return {
    hasProjectMd: fs.existsSync(projectMdPath),
    symlinksValid,
  };
}

/** Detect a whole-repo test command from project manifests, or null when none is configured. */
export function detectIntegrationCommand(projectPath: string): string | null {
  const pkgPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readArtifactFile(projectPath, pkgPath)) as {
        scripts?: Record<string, string>;
      };
      const testScript = pkg.scripts?.test?.trim();
      if (testScript && !/no test specified/i.test(testScript)) {
        if (fs.existsSync(path.join(projectPath, 'pnpm-lock.yaml'))) return 'pnpm test';
        if (fs.existsSync(path.join(projectPath, 'yarn.lock'))) return 'yarn test';
        return 'npm test';
      }
    } catch {
      // Ignore unreadable or invalid package.json.
    }
  }
  if (
    fs.existsSync(path.join(projectPath, 'pytest.ini')) ||
    fs.existsSync(path.join(projectPath, 'pyproject.toml'))
  ) {
    return 'pytest';
  }
  if (fs.existsSync(path.join(projectPath, 'go.mod'))) return 'go test ./...';
  if (fs.existsSync(path.join(projectPath, 'Cargo.toml'))) return 'cargo test';
  return null;
}

export class ProjectService {
  constructor(private readonly db: DalangDb) {}

  async createOrOpen(input: CreateOrOpenProjectInput): Promise<ProjectSummary> {
    const resolvedPath = path.resolve(input.path.trim());
    const derivedName = input.name?.trim() || path.basename(resolvedPath);

    if (input.mode === 'create') {
      if (fs.existsSync(resolvedPath)) {
        const entries = fs.readdirSync(resolvedPath);
        if (entries.length > 0 && !fs.existsSync(path.join(resolvedPath, '.git'))) {
          throw new Error(
            `Directory "${resolvedPath}" already exists and is not empty. Use "Open Existing Repo" instead.`,
          );
        }
      } else {
        ensureDir(resolvedPath);
      }

      const git = simpleGit(resolvedPath);
      if (!fs.existsSync(path.join(resolvedPath, '.git'))) {
        await git.init(['--initial-branch=main']).catch(async () => {
          await git.init();
        });
      }
    } else {
      if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
        throw new Error(`Directory does not exist: ${resolvedPath}`);
      }
      if (!fs.existsSync(path.join(resolvedPath, '.git'))) {
        if (input.initGitIfMissing) {
          const git = simpleGit(resolvedPath);
          await git.init(['--initial-branch=main']).catch(async () => {
            await git.init();
          });
        } else {
          throw new Error(
            `Directory "${resolvedPath}" is not a git repository. Check "Initialize git if missing" to run git init.`,
          );
        }
      }
    }

    let mainBranch = 'main';
    try {
      const git = simpleGit(resolvedPath);
      const branchSummary = await git.branchLocal();
      if (branchSummary.current) {
        mainBranch = branchSummary.current;
      } else if (branchSummary.all.includes('master')) {
        mainBranch = 'master';
      }
    } catch {
      mainBranch = 'main';
    }

    ensureProjectScaffold(resolvedPath, derivedName, input.stackHint);

    const existing = this.db
      .select()
      .from(projects)
      .where(eq(projects.path, resolvedPath))
      .get();

    const now = new Date().toISOString();
    if (existing) {
      this.db
        .update(projects)
        .set({
          name: input.name?.trim() || existing.name,
          mainBranch,
          updatedAt: now,
        })
        .where(eq(projects.id, existing.id))
        .run();
      return this.getProject(existing.id);
    }

    const id = crypto.randomUUID();
    this.db
      .insert(projects)
      .values({
        id,
        name: derivedName,
        path: resolvedPath,
        mainBranch,
        leadProvider: input.leadProvider ?? this.defaultLeadProvider(),
        leadModel: input.leadModel?.trim() || null,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    return this.getProject(id);
  }

  listProjects(): ProjectSummary[] {
    const rows = this.db.select().from(projects).orderBy(desc(projects.updatedAt)).all();
    return rows.map((row) => this.toSummary(row));
  }

  /** The provider of the profile the Lead routing rule points at, so new projects follow the team setup. */
  private defaultLeadProvider(): ProviderId {
    const row = this.db
      .select({ provider: agentProfiles.provider })
      .from(routingRules)
      .innerJoin(agentProfiles, eq(routingRules.profileId, agentProfiles.id))
      .where(eq(routingRules.role, 'lead'))
      .orderBy(routingRules.sortOrder)
      .limit(1)
      .get();
    return (row?.provider as ProviderId | undefined) ?? 'claude-code';
  }

  getProject(id: string): ProjectSummary {
    const row = this.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!row) {
      throw new Error(`Project not found: ${id}`);
    }
    return this.toSummary(row);
  }

  getProjectRow(id: string) {
    const row = this.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!row) {
      throw new Error(`Project not found: ${id}`);
    }
    return row;
  }

  deleteProject(id: string): void {
    const row = this.getProjectRow(id);
    const worktreeDir = getProjectWorktreesDir(getWorktreesRoot(getDbDataDir(this.db)), row.id);
    if (fs.existsSync(worktreeDir)) {
      for (const entry of fs.readdirSync(worktreeDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          void removeTaskWorktree(row.path, path.join(worktreeDir, entry.name)).catch(() => undefined);
        }
      }
      fs.rmSync(worktreeDir, { recursive: true, force: true });
    }
    this.db.delete(projects).where(eq(projects.id, row.id)).run();
  }

  updateSettings(
    id: string,
    settings: {
      leadProvider?: ProviderId;
      leadModel?: string | null;
      integrationCommand?: string | null;
      pushAfterMerge?: boolean;
      createPrAfterMerge?: boolean;
      gitRemote?: string | null;
    },
  ): ProjectSummary {
    this.getProjectRow(id);
    this.db
      .update(projects)
      .set({
        ...(settings.leadProvider ? { leadProvider: settings.leadProvider } : {}),
        ...(settings.leadModel !== undefined ? { leadModel: settings.leadModel || null } : {}),
        ...(settings.integrationCommand !== undefined
          ? { integrationCommand: settings.integrationCommand?.trim() || null }
          : {}),
        ...(settings.pushAfterMerge !== undefined
          ? { pushAfterMerge: settings.pushAfterMerge }
          : {}),
        ...(settings.createPrAfterMerge !== undefined
          ? { createPrAfterMerge: settings.createPrAfterMerge }
          : {}),
        ...(settings.gitRemote !== undefined
          ? { gitRemote: settings.gitRemote?.trim() || null }
          : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(projects.id, id))
      .run();
    return this.getProject(id);
  }

  readProjectMd(id: string): { content: string; symlinksValid: { claudeMd: boolean; agentsMd: boolean } } {
    const row = this.getProjectRow(id);
    const projectMdPath = path.join(row.path, 'PROJECT.md');
    const content = fs.existsSync(projectMdPath)
      ? readArtifactFile(row.path, projectMdPath)
      : buildDefaultProjectMd(row.name);
    const symlinksValid = {
      claudeMd: checkSymlinkPointsTo(path.join(row.path, 'CLAUDE.md'), 'PROJECT.md'),
      agentsMd: checkSymlinkPointsTo(path.join(row.path, 'AGENTS.md'), 'PROJECT.md'),
    };
    return { content, symlinksValid };
  }

  writeProjectMd(
    id: string,
    content: string,
    repairSymlinks = true,
  ): { content: string; symlinksValid: { claudeMd: boolean; agentsMd: boolean } } {
    const row = this.getProjectRow(id);
    const projectMdPath = path.join(row.path, 'PROJECT.md');
    writeArtifactFile(row.path, projectMdPath, content, 'refuse');

    if (repairSymlinks) {
      ensureSymlinks(row.path);
    }

    return this.readProjectMd(id);
  }

  private toSummary(row: typeof projects.$inferSelect): ProjectSummary {
    const projectMdPath = path.join(row.path, 'PROJECT.md');
    const hasProjectMd = fs.existsSync(projectMdPath);
    const symlinksValid = {
      claudeMd: checkSymlinkPointsTo(path.join(row.path, 'CLAUDE.md'), 'PROJECT.md'),
      agentsMd: checkSymlinkPointsTo(path.join(row.path, 'AGENTS.md'), 'PROJECT.md'),
    };

    const projectSessions = this.db
      .select()
      .from(sessions)
      .where(eq(sessions.projectId, row.id))
      .orderBy(desc(sessions.updatedAt))
      .all();
    const activeSessions = projectSessions.filter((s) => !s.archivedAt);
    const workingSession = projectSessions.find((s) => s.workState === 'working') ?? null;

    const projectBriefs = this.db
      .select()
      .from(briefs)
      .where(eq(briefs.projectId, row.id))
      .orderBy(desc(briefs.version))
      .all();
    const latestBrief = projectBriefs[0];

    const projectPlans = this.db
      .select()
      .from(plans)
      .where(eq(plans.projectId, row.id))
      .orderBy(desc(plans.version))
      .all();
    const latestPlan = projectPlans[0];

    const taskCount = latestPlan
      ? this.db.select().from(tasks).where(eq(tasks.planId, latestPlan.id)).all().length
      : 0;

    return {
      id: row.id,
      name: row.name,
      path: row.path,
      mainBranch: row.mainBranch,
      leadProvider: row.leadProvider as ProviderId,
      leadModel: row.leadModel,
      integrationCommand: row.integrationCommand ?? null,
      pushAfterMerge: Boolean(row.pushAfterMerge),
      createPrAfterMerge: Boolean(row.createPrAfterMerge),
      gitRemote: row.gitRemote ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      hasProjectMd,
      symlinksValid,
      latestBriefStatus: latestBrief ? (latestBrief.status as 'draft' | 'approved') : 'none',
      latestBriefVersion: latestBrief ? latestBrief.version : null,
      taskCount,
      planStatus: latestPlan ? (latestPlan.status as 'draft' | 'approved') : 'none',
      sessionCount: activeSessions.length,
      workingSessionId: workingSession?.id ?? null,
      workingSessionTitle: workingSession?.title || null,
    };
  }
}
