import type { ProviderId, TaskRunDTO } from '@dalang/shared';
import { characterForProfile, type WayangCharacterId } from '../assets/wayang/WayangFigure.js';

export interface ActivityFeedItem {
  id: string;
  timestamp: string;
  projectId: string;
  taskId?: string;
  taskExternalId?: string;
  character: WayangCharacterId;
  provider?: ProviderId;
  kind: 'started' | 'writing' | 'command' | 'completed' | 'failed' | 'review_pass' | 'review_fail' | 'integration';
  title?: string;
  target?: string;
  command?: string;
  reason?: string;
  round?: number;
  status?: string;
}

export function providerDisplayShort(provider?: string): string {
  if (provider === 'claude-code') return 'Claude';
  if (provider === 'codex') return 'Codex';
  if (provider === 'antigravity') return 'Antigravity';
  return provider || 'CLI';
}

export function providerBadgeStyle(provider?: string): { color: string; backgroundColor: string; borderColor: string } {
  if (provider === 'claude-code') {
    return {
      color: 'var(--provider-claude-fg)',
      backgroundColor: 'var(--provider-claude-bg)',
      borderColor: 'var(--provider-claude-fg)',
    };
  }
  if (provider === 'codex') {
    return {
      color: 'var(--provider-codex-fg)',
      backgroundColor: 'var(--provider-codex-bg)',
      borderColor: 'var(--provider-codex-fg)',
    };
  }
  if (provider === 'antigravity') {
    return {
      color: 'var(--provider-agy-fg)',
      backgroundColor: 'var(--provider-agy-bg)',
      borderColor: 'var(--provider-agy-fg)',
    };
  }
  return {
    color: 'var(--text-secondary)',
    backgroundColor: 'var(--bg-well)',
    borderColor: 'var(--border-subtle)',
  };
}

/**
 * Inspects a single JSON stream line emitted by Claude, Codex, or Antigravity CLI
 * and extracts factual tool/command actions if present.
 */
export function parseRunLogActivity(
  line: string,
  meta: {
    projectId: string;
    taskId: string;
    taskExternalId?: string;
    profileName: string;
    provider?: ProviderId;
    usedFallback?: boolean;
  },
): ActivityFeedItem | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }

  const now = new Date().toISOString();
  const character = characterForProfile(meta.profileName, undefined, meta.usedFallback);

  // Claude stream-json tool_use inside assistant message
  if (obj.type === 'assistant' && obj.message && typeof obj.message === 'object') {
    const content = (obj.message as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as { type?: string; name?: string; input?: Record<string, unknown> };
        if (b.type === 'tool_use' && b.name) {
          const input = b.input ?? {};
          const filePath =
            (typeof input.file_path === 'string' && input.file_path) ||
            (typeof input.path === 'string' && input.path) ||
            (typeof input.Path === 'string' && input.Path);
          if (filePath && /write|edit|patch|create/i.test(b.name)) {
            return {
              id: `${now}-${Math.random().toString(36).slice(2, 7)}`,
              timestamp: now,
              projectId: meta.projectId,
              taskId: meta.taskId,
              taskExternalId: meta.taskExternalId,
              character,
              provider: meta.provider,
              kind: 'writing',
              target: filePath,
            };
          }
          const cmd =
            (typeof input.command === 'string' && input.command) ||
            (typeof input.CommandLine === 'string' && input.CommandLine);
          if (cmd) {
            return {
              id: `${now}-${Math.random().toString(36).slice(2, 7)}`,
              timestamp: now,
              projectId: meta.projectId,
              taskId: meta.taskId,
              taskExternalId: meta.taskExternalId,
              character,
              provider: meta.provider,
              kind: 'command',
              command: cmd.slice(0, 80),
            };
          }
        }
      }
    }
  }

  // Codex item.started / item.completed for command_execution or file_change
  if ((obj.type === 'item.started' || obj.type === 'item.completed') && obj.item && typeof obj.item === 'object') {
    const item = obj.item as Record<string, unknown>;
    if (item.type === 'command_execution' && typeof item.command === 'string') {
      return {
        id: `${now}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: now,
        projectId: meta.projectId,
        taskId: meta.taskId,
        taskExternalId: meta.taskExternalId,
        character,
        provider: meta.provider,
        kind: 'command',
        command: item.command.slice(0, 80),
      };
    }
    if (item.type === 'file_change' && Array.isArray(item.changes)) {
      const first = item.changes[0] as { path?: string } | undefined;
      if (first?.path) {
        return {
          id: `${now}-${Math.random().toString(36).slice(2, 7)}`,
          timestamp: now,
          projectId: meta.projectId,
          taskId: meta.taskId,
          taskExternalId: meta.taskExternalId,
          character,
          provider: meta.provider,
          kind: 'writing',
          target: first.path,
        };
      }
    }
  }

  return null;
}

/** Hydrates factual feed items from persisted TaskRunDTO history when live WS events haven't arrived yet. */
export function buildInitialFeedFromRuns(runs: TaskRunDTO[]): ActivityFeedItem[] {
  const items: ActivityFeedItem[] = [];
  for (const run of runs.slice(0, 12)) {
    const character = characterForProfile(
      run.profileName,
      run.kind === 'review' ? 'reviewer' : 'engineer',
      run.usedFallback,
    );
    if (run.status === 'completed') {
      items.push({
        id: `run-done-${run.id}`,
        timestamp: run.finishedAt ?? run.startedAt,
        projectId: run.projectId,
        taskId: run.taskId,
        taskExternalId: run.taskExternalId,
        character,
        provider: run.provider,
        kind: 'completed',
        title: run.taskTitle,
      });
    } else if (run.status === 'failed') {
      items.push({
        id: `run-fail-${run.id}`,
        timestamp: run.finishedAt ?? run.startedAt,
        projectId: run.projectId,
        taskId: run.taskId,
        taskExternalId: run.taskExternalId,
        character,
        provider: run.provider,
        kind: 'failed',
        reason: run.failureReason ?? `exit ${run.exitCode ?? '?'}`,
      });
    } else if (run.status === 'running') {
      items.push({
        id: `run-start-${run.id}`,
        timestamp: run.startedAt,
        projectId: run.projectId,
        taskId: run.taskId,
        taskExternalId: run.taskExternalId,
        character,
        provider: run.provider,
        kind: 'started',
        title: run.taskTitle,
      });
    }
  }
  return items;
}
