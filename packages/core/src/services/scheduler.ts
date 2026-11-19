import type { ProviderId } from '@dalang/shared';

function expandBraces(pattern: string): string[] {
  const match = pattern.match(/\{([^{}]+)\}/);
  if (!match) return [pattern];
  const prefix = pattern.slice(0, match.index);
  const suffix = pattern.slice((match.index ?? 0) + match[0].length);
  const parts = match[1].split(',').map((p) => p.trim());
  const out: string[] = [];
  for (const part of parts) {
    out.push(...expandBraces(`${prefix}${part}${suffix}`));
  }
  return out;
}

function normalizePattern(raw: string): string[] {
  return expandBraces(raw.trim().replace(/\\/g, '/'))
    .map((p) => p.replace(/^\.\//, '').replace(/\/+$/, ''))
    .filter(Boolean);
}

function segmentsIntersect(a: string, b: string): boolean {
  if (a === b) return true;
  const memo = new Map<number, boolean>();
  const stride = b.length + 1;

  const dfs = (i: number, j: number): boolean => {
    const key = i * stride + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let res = false;
    if (i === a.length && j === b.length) {
      res = true;
    } else if (i < a.length && a[i] === '*') {
      res = dfs(i + 1, j) || (j < b.length && dfs(i, j + 1));
    } else if (j < b.length && b[j] === '*') {
      res = dfs(i, j + 1) || (i < a.length && dfs(i + 1, j));
    } else if (i < a.length && j < b.length) {
      if (a[i] === '?' || b[j] === '?' || a[i] === b[j]) {
        res = dfs(i + 1, j + 1);
      }
    }

    memo.set(key, res);
    return res;
  };

  return dfs(0, 0);
}

function singleGlobOverlap(patternA: string, patternB: string): boolean {
  const segsA = patternA.split('/').filter(Boolean);
  const segsB = patternB.split('/').filter(Boolean);
  const memo = new Map<number, boolean>();
  const stride = segsB.length + 1;

  const dfs = (i: number, j: number): boolean => {
    const key = i * stride + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let res = false;
    if (i === segsA.length && j === segsB.length) {
      res = true;
    } else if (i < segsA.length && segsA[i] === '**') {
      res = dfs(i + 1, j) || (j < segsB.length && dfs(i, j + 1));
    } else if (j < segsB.length && segsB[j] === '**') {
      res = dfs(i, j + 1) || (i < segsA.length && dfs(i + 1, j));
    } else if (i < segsA.length && j < segsB.length) {
      if (segmentsIntersect(segsA[i], segsB[j])) {
        res = dfs(i + 1, j + 1);
      }
    }

    memo.set(key, res);
    return res;
  };

  return dfs(0, 0);
}

/**
 * Determine whether two `files_allowed` glob lists could modify any common path.
 * An empty list represents unrestricted workspace access, so it overlaps with everything.
 */
export function globsOverlap(patternsA: string[], patternsB: string[]): boolean {
  const normA = patternsA.flatMap(normalizePattern);
  const normB = patternsB.flatMap(normalizePattern);
  if (normA.length === 0 || normB.length === 0) {
    return true;
  }

  for (const a of normA) {
    for (const b of normB) {
      if (singleGlobOverlap(a, b)) return true;
    }
  }
  return false;
}

/**
 * Compute 0-based topological wave depth for every task (`0` = no dependencies).
 */
export function computeTaskWaves(
  tasks: Array<{ externalId: string; dependsOn: string[] }>,
): Map<string, number> {
  const depsById = new Map(tasks.map((t) => [t.externalId, t.dependsOn]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  const depth = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;

    visiting.add(id);
    let maxDep = -1;
    for (const dep of depsById.get(id) ?? []) {
      if (depsById.has(dep)) {
        maxDep = Math.max(maxDep, depth(dep));
      }
    }
    visiting.delete(id);

    const wave = maxDep + 1;
    memo.set(id, wave);
    return wave;
  };

  for (const t of tasks) {
    depth(t.externalId);
  }
  return memo;
}

export interface SlotLease {
  provider: ProviderId;
  release: () => void;
}

interface LimiterWaiter {
  provider: ProviderId;
  limit: number;
  resolve: (lease: SlotLease) => void;
  reject: (err: Error) => void;
  cleanup?: () => void;
}

/**
 * Process-wide per-provider concurrency limiter shared across all projects and runs.
 */
export class ProviderLimiter {
  private readonly activeCounts = new Map<ProviderId, number>();
  private readonly waiters: LimiterWaiter[] = [];
  private readonly releaseListeners = new Set<(provider: ProviderId) => void>();

  getActiveCount(provider: ProviderId): number {
    return this.activeCounts.get(provider) ?? 0;
  }

  hasCapacity(provider: ProviderId, limit: number): boolean {
    const effectiveLimit = Math.max(1, limit);
    return this.getActiveCount(provider) < effectiveLimit;
  }

  tryAcquire(provider: ProviderId, limit: number): SlotLease | null {
    if (!this.hasCapacity(provider, limit)) return null;
    return this.createLease(provider);
  }

  acquire(provider: ProviderId, limit: number, signal?: AbortSignal): Promise<SlotLease> {
    if (signal?.aborted) {
      return Promise.reject(new Error('Aborted while waiting for provider parallel slot'));
    }
    const immediate = this.tryAcquire(provider, limit);
    if (immediate) return Promise.resolve(immediate);

    return new Promise<SlotLease>((resolve, reject) => {
      const waiter: LimiterWaiter = {
        provider,
        limit: Math.max(1, limit),
        resolve,
        reject,
      };

      if (signal) {
        const onAbort = () => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(new Error('Aborted while waiting for provider parallel slot'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.cleanup = () => signal.removeEventListener('abort', onAbort);
      }

      this.waiters.push(waiter);
    });
  }

  onRelease(listener: (provider: ProviderId) => void): () => void {
    this.releaseListeners.add(listener);
    return () => {
      this.releaseListeners.delete(listener);
    };
  }

  waitForAnyRelease(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        unsub();
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const unsub = this.onRelease(() => done());
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  private createLease(provider: ProviderId): SlotLease {
    this.activeCounts.set(provider, this.getActiveCount(provider) + 1);
    let released = false;
    return {
      provider,
      release: () => {
        if (released) return;
        released = true;
        const current = this.getActiveCount(provider);
        if (current <= 1) this.activeCounts.delete(provider);
        else this.activeCounts.set(provider, current - 1);

        this.drainWaiters(provider);
        for (const listener of [...this.releaseListeners]) {
          listener(provider);
        }
      },
    };
  }

  private drainWaiters(provider: ProviderId): void {
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i];
      if (w.provider !== provider) continue;
      if (!this.hasCapacity(provider, w.limit)) continue;
      this.waiters.splice(i, 1);
      w.cleanup?.();
      w.resolve(this.createLease(provider));
      i--;
    }
  }
}
