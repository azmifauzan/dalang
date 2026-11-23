import type { ProviderId, TaskRunDTO } from '@dalang/shared';
import { characterForProfile, type WayangCharacterId } from '../assets/wayang/WayangFigure.js';

export interface NativeSubagentEntry {
  id: string;
  source: 'claude' | 'antigravity';
  toolName: string;
  label: string;
  detail: string;
  status: 'running' | 'completed';
}

export interface ActivityFeedItem {
  id: string;
  timestamp: string;
  projectId: string;
  taskId?: string;
  taskExternalId?: string;
  character: WayangCharacterId;
  provider?: ProviderId;
  kind:
    | 'started'
    | 'writing'
    | 'command'
    | 'completed'
    | 'failed'
    | 'review_pass'
    | 'review_fail'
    | 'integration'
    | 'delegated'
    | 'subtask_merged'
    | 'subagent';
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
          if (/^(Task|Agent|dispatch_agent)$/i.test(b.name)) {
            const desc =
              (typeof input.description === 'string' && input.description.trim()) ||
              (typeof input.subagent_type === 'string' && input.subagent_type.trim()) ||
              (typeof input.prompt === 'string' && input.prompt.trim().slice(0, 80)) ||
              b.name;
            return {
              id: `${now}-${Math.random().toString(36).slice(2, 7)}`,
              timestamp: now,
              projectId: meta.projectId,
              taskId: meta.taskId,
              taskExternalId: meta.taskExternalId,
              character,
              provider: meta.provider,
              kind: 'subagent',
              target: desc.slice(0, 100),
            };
          }
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

  // Antigravity step_update for native subagents or batches
  if (obj.event === 'step_update' && obj.step_update && typeof obj.step_update === 'object') {
    const step = obj.step_update as Record<string, unknown>;
    const toolName = typeof step.tool_name === 'string' ? step.tool_name : '';
    const stepType = typeof step.step_type === 'string' ? step.step_type : '';
    if (/subagent|batch/i.test(toolName) || /subagent|batch/i.test(stepType)) {
      const info =
        step.tool_info && typeof step.tool_info === 'object'
          ? (step.tool_info as Record<string, unknown>)
          : {};
      const params =
        info.parameters && typeof info.parameters === 'object'
          ? (info.parameters as Record<string, unknown>)
          : {};
      const label =
        (typeof params.Role === 'string' && params.Role.trim()) ||
        (typeof params.role === 'string' && params.role.trim()) ||
        (typeof params.description === 'string' && params.description.trim()) ||
        (typeof params.Prompt === 'string' && params.Prompt.trim().slice(0, 80)) ||
        (typeof params.prompt === 'string' && params.prompt.trim().slice(0, 80)) ||
        toolName ||
        stepType;
      return {
        id: `${now}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: now,
        projectId: meta.projectId,
        taskId: meta.taskId,
        taskExternalId: meta.taskExternalId,
        character,
        provider: meta.provider ?? 'antigravity',
        kind: 'subagent',
        target: label.slice(0, 100),
      };
    }
  }

  return null;
}

/**
 * Extract read-only native subagent invocations (Claude Task/Agent tool calls and Antigravity
 * subagent/batch events) from a persisted or live run log.
 */
export function parseNativeSubagentsFromLog(logContent: string): NativeSubagentEntry[] {
  if (!logContent) return [];
  const entries: NativeSubagentEntry[] = [];
  const byId = new Map<string, NativeSubagentEntry>();

  const upsert = (entry: NativeSubagentEntry) => {
    const existing = byId.get(entry.id);
    if (existing) {
      if (entry.status === 'completed') existing.status = 'completed';
      if (entry.detail && !existing.detail) existing.detail = entry.detail;
      return;
    }
    byId.set(entry.id, entry);
    entries.push(entry);
  };

  let seq = 0;
  for (const rawLine of logContent.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith('{')) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    // Claude Code assistant tool_use blocks for Task / Agent / dispatch_agent
    if (obj.type === 'assistant' && obj.message && typeof obj.message === 'object') {
      const content = (obj.message as { content?: unknown }).content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as { id?: string; type?: string; name?: string; input?: Record<string, unknown> };
          if (b.type === 'tool_use' && b.name && /^(Task|Agent|dispatch_agent)$/i.test(b.name)) {
            const input = b.input ?? {};
            const id = typeof b.id === 'string' && b.id ? b.id : `claude-sub-${++seq}`;
            const subType =
              (typeof input.subagent_type === 'string' && input.subagent_type.trim()) ||
              (typeof input.name === 'string' && input.name.trim()) ||
              b.name;
            const desc =
              (typeof input.description === 'string' && input.description.trim()) ||
              (typeof input.prompt === 'string' && input.prompt.trim().slice(0, 140)) ||
              '';
            upsert({
              id,
              source: 'claude',
              toolName: b.name,
              label: subType,
              detail: desc,
              status: 'running',
            });
          }
        }
      }
    }

    // Claude Code user tool_result marks the native subagent call completed
    if (obj.type === 'user' && obj.message && typeof obj.message === 'object') {
      const content = (obj.message as { content?: unknown }).content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as { type?: string; tool_use_id?: string };
          if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
            const existing = byId.get(b.tool_use_id);
            if (existing) existing.status = 'completed';
          }
        }
      }
    }

    // Claude Code system task notifications (task_started / task_notification)
    if (obj.type === 'system' && typeof obj.subtype === 'string') {
      if (obj.subtype === 'task_started' || obj.subtype === 'task_notification') {
        const id =
          (typeof obj.task_id === 'string' && obj.task_id) ||
          (typeof obj.tool_use_id === 'string' && obj.tool_use_id) ||
          `claude-sys-${++seq}`;
        const label =
          (typeof obj.description === 'string' && obj.description.trim()) ||
          (typeof obj.summary === 'string' && obj.summary.trim()) ||
          'Subagent task';
        const status =
          obj.subtype === 'task_notification' || obj.status === 'completed' || obj.status === 'failed'
            ? 'completed'
            : 'running';
        upsert({
          id,
          source: 'claude',
          toolName: 'Task',
          label,
          detail: typeof obj.summary === 'string' ? obj.summary.trim().slice(0, 160) : '',
          status,
        });
      }
    }

    // Antigravity step_update subagent / batch tool events
    if (obj.event === 'step_update' && obj.step_update && typeof obj.step_update === 'object') {
      const step = obj.step_update as Record<string, unknown>;
      const toolName = typeof step.tool_name === 'string' ? step.tool_name : '';
      const stepType = typeof step.step_type === 'string' ? step.step_type : '';
      if (/subagent|batch/i.test(toolName) || /subagent|batch/i.test(stepType)) {
        const info =
          step.tool_info && typeof step.tool_info === 'object'
            ? (step.tool_info as Record<string, unknown>)
            : {};
        const params =
          info.parameters && typeof info.parameters === 'object'
            ? (info.parameters as Record<string, unknown>)
            : {};
        const id =
          (typeof step.step_id === 'string' && step.step_id) ||
          (typeof step.id === 'string' && step.id) ||
          `agy-sub-${toolName || stepType}-${typeof params.Role === 'string' ? params.Role : ++seq}`;
        const label =
          (typeof params.Role === 'string' && params.Role.trim()) ||
          (typeof params.role === 'string' && params.role.trim()) ||
          (typeof params.TypeName === 'string' && params.TypeName.trim()) ||
          toolName ||
          stepType;
        const detail =
          (typeof params.Prompt === 'string' && params.Prompt.trim().slice(0, 140)) ||
          (typeof params.prompt === 'string' && params.prompt.trim().slice(0, 140)) ||
          (typeof params.description === 'string' && params.description.trim().slice(0, 140)) ||
          '';
        const stateStr = typeof step.state === 'string' ? step.state.toUpperCase() : '';
        upsert({
          id,
          source: 'antigravity',
          toolName: toolName || stepType,
          label,
          detail,
          status: stateStr === 'DONE' || stateStr === 'COMPLETED' || stateStr === 'FINISHED' ? 'completed' : 'running',
        });
      }
    }

    // Antigravity batch payload events
    if ((obj.type === 'batch' || obj.type === 'agent_batch' || obj.type === 'subagent') && obj) {
      const tasksArr = Array.isArray(obj.tasks) ? obj.tasks : Array.isArray(obj.agents) ? obj.agents : null;
      if (tasksArr) {
        tasksArr.forEach((item, idx) => {
          if (!item || typeof item !== 'object') return;
          const t = item as Record<string, unknown>;
          const id = (typeof t.id === 'string' && t.id) || `agy-batch-${seq}-${idx}`;
          const label =
            (typeof t.role === 'string' && t.role.trim()) ||
            (typeof t.name === 'string' && t.name.trim()) ||
            `Batch #${idx + 1}`;
          const detail =
            (typeof t.prompt === 'string' && t.prompt.trim().slice(0, 140)) ||
            (typeof t.description === 'string' && t.description.trim().slice(0, 140)) ||
            '';
          upsert({
            id,
            source: 'antigravity',
            toolName: String(obj.type),
            label,
            detail,
            status: t.status === 'completed' || t.status === 'done' ? 'completed' : 'running',
          });
        });
      } else {
        const id = (typeof obj.id === 'string' && obj.id) || `agy-sub-${++seq}`;
        const label =
          (typeof obj.role === 'string' && obj.role.trim()) ||
          (typeof obj.name === 'string' && obj.name.trim()) ||
          String(obj.type);
        const detail =
          (typeof obj.prompt === 'string' && obj.prompt.trim().slice(0, 140)) ||
          (typeof obj.description === 'string' && obj.description.trim().slice(0, 140)) ||
          '';
        upsert({
          id,
          source: 'antigravity',
          toolName: String(obj.type),
          label,
          detail,
          status: obj.status === 'completed' || obj.status === 'done' ? 'completed' : 'running',
        });
      }
    }
  }

  return entries;
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
