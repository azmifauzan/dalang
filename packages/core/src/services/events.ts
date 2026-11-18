import { EventEmitter } from 'node:events';
import type { RunStatus } from '@dalang/shared';

export type DalangEvent =
  | { type: 'lead.turn_started'; projectId: string; phase: string; provider: string }
  | { type: 'lead.log'; projectId: string; phase: string; line: string }
  | { type: 'lead.turn_finished'; projectId: string; phase: string; ok: boolean; error?: string }
  | { type: 'discuss.updated'; projectId: string }
  | { type: 'brief.updated'; projectId: string; version: number }
  | { type: 'plan.updated'; projectId: string }
  | {
      type: 'run.started';
      projectId: string;
      taskId: string;
      runId: string;
      profileName: string;
      provider: string;
    }
  | { type: 'run.log'; projectId: string; taskId: string; runId: string; line: string }
  | {
      type: 'run.finished';
      projectId: string;
      taskId: string;
      runId: string;
      status: RunStatus;
      error?: string;
    }
  | {
      type: 'review.finished';
      projectId: string;
      taskId: string;
      round: number;
      status: 'pass' | 'fail';
    }
  | {
      type: 'integration.finished';
      projectId: string;
      taskId: string | null;
      status: 'passed' | 'failed' | 'skipped';
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
