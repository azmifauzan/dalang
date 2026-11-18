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

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}
