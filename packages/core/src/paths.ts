import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Global DALANG home directory (`~/.dalang` by default, overridable via `DALANG_HOME`).
 */
export function getDalangHome(): string {
  return process.env.DALANG_HOME?.trim() || path.join(os.homedir(), '.dalang');
}

export function getDbPath(): string {
  return path.join(getDalangHome(), 'dalang.db');
}

export function getProjectDalangDir(projectPath: string): string {
  return path.join(projectPath, '.dalang');
}

export function getProjectDiscussDir(projectPath: string): string {
  return path.join(getProjectDalangDir(projectPath), 'discuss');
}

export function getProjectLogsDir(projectPath: string): string {
  return path.join(getProjectDalangDir(projectPath), 'logs');
}

export function getProjectTmpDir(projectPath: string): string {
  return path.join(getProjectDalangDir(projectPath), 'tmp');
}

export function getProjectTasksDir(projectPath: string): string {
  return path.join(getProjectDalangDir(projectPath), 'tasks');
}

export function getTaskArtifactDir(projectPath: string, taskExternalId: string): string {
  return path.join(getProjectTasksDir(projectPath), taskExternalId);
}

export function getProjectSessionsDir(projectPath: string): string {
  return path.join(getProjectDalangDir(projectPath), 'sessions');
}

export function getSessionDir(projectPath: string, sessionId: string): string {
  return path.join(getProjectSessionsDir(projectPath), sessionId);
}

export function getSessionDiscussDir(projectPath: string, sessionId: string): string {
  return path.join(getSessionDir(projectPath, sessionId), 'discuss');
}

export function getSessionLogsDir(projectPath: string, sessionId: string): string {
  return path.join(getSessionDir(projectPath, sessionId), 'logs');
}

export function getSessionTmpDir(projectPath: string, sessionId: string): string {
  return path.join(getSessionDir(projectPath, sessionId), 'tmp');
}

export function getSessionTasksDir(projectPath: string, sessionId: string): string {
  return path.join(getSessionDir(projectPath, sessionId), 'tasks');
}

export function getSessionTaskArtifactDir(
  projectPath: string,
  sessionId: string,
  taskExternalId: string,
): string {
  return path.join(getSessionTasksDir(projectPath, sessionId), taskExternalId);
}

export function getWorktreesRoot(dataDir?: string | null): string {
  return path.join(dataDir?.trim() || getDalangHome(), 'worktrees');
}

export function getProjectWorktreesDir(worktreesRoot: string, projectId: string): string {
  return path.join(worktreesRoot, projectId);
}

export function getTaskWorktreeDir(
  worktreesRoot: string,
  projectId: string,
  taskExternalId: string,
): string {
  return path.join(getProjectWorktreesDir(worktreesRoot, projectId), taskExternalId);
}

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}
