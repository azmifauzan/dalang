import { EventEmitter } from 'node:events';

export type DalangEvent =
  | { type: 'lead.turn_started'; projectId: string; phase: string; provider: string }
  | { type: 'lead.log'; projectId: string; phase: string; line: string }
  | { type: 'lead.turn_finished'; projectId: string; phase: string; ok: boolean; error?: string }
  | { type: 'discuss.updated'; projectId: string }
  | { type: 'brief.updated'; projectId: string; version: number }
  | { type: 'plan.updated'; projectId: string };

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
