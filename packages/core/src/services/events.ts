import { EventEmitter } from 'node:events';
import type { RunStatus } from '@dalang/shared';

export type DalangEvent =
  | { type: 'lead.turn_started'; projectId: string; sessionId?: string; phase: string; provider: string }
  | { type: 'lead.log'; projectId: string; sessionId?: string; phase: string; line: string }
  | { type: 'lead.turn_finished'; projectId: string; sessionId?: string; phase: string; ok: boolean; error?: string }
  | { type: 'sessions.updated'; projectId: string; sessionId?: string }
  | { type: 'discuss.updated'; projectId: string; sessionId?: string }
  | { type: 'brief.updated'; projectId: string; sessionId?: string; version: number }
  | { type: 'plan.updated'; projectId: string; sessionId?: string }
  | {
      type: 'run.started';
      projectId: string;
      sessionId?: string;
      taskId: string;
      runId: string;
      profileName: string;
      provider: string;
    }
  | { type: 'run.log'; projectId: string; sessionId?: string; taskId: string; runId: string; line: string }
  | {
      type: 'run.finished';
      projectId: string;
      sessionId?: string;
      taskId: string;
      runId: string;
      status: RunStatus;
      error?: string;
    }
  | {
      type: 'review.finished';
      projectId: string;
      sessionId?: string;
      taskId: string;
      round: number;
      status: 'pass' | 'fail';
    }
  | {
      type: 'integration.finished';
      projectId: string;
      sessionId?: string;
      taskId: string | null;
      status: 'passed' | 'failed' | 'skipped';
    }
  | {
      type: 'provider.updated';
      provider: string;
    }
  | {
      type: 'task.delegated';
      projectId: string;
      sessionId?: string;
      parentTaskId: string;
      parentExternalId: string;
      taskId: string;
      externalId: string;
      title: string;
      provider: string;
      model: string | null;
      profileName: string;
    }
  | {
      type: 'task.subtask_merged';
      projectId: string;
      sessionId?: string;
      parentTaskId: string;
      taskId: string;
      externalId: string;
      targetBranch: string;
      mergeCommitSha: string;
    };

export class DalangEventBus extends EventEmitter {
  emitEvent(event: DalangEvent): void {
    this.emit('dalang', event);
  }

  onEvent(listener: (event: DalangEvent) => void): () => void {
    this.on('dalang', listener);
    return () => {
      this.off('dalang', listener);
    };
  }
}
