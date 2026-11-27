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

function isUnsafeGlobPattern(raw: string): boolean {
  const trimmed = raw.trim().replace(/\\/g, '/');
  if (!trimmed) return true;
  if (trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed)) return true;
  const segments = trimmed.replace(/^\.\//, '').split('/');
  return segments.some((seg) => seg === '..');
}

/**
 * True when every single path segment matched by `childSeg` is also matched by `parentSeg`.
 */
function segmentSubset(childSeg: string, parentSeg: string): boolean {
  if (childSeg === parentSeg) return true;
  const memo = new Map<number, boolean>();
  const stride = parentSeg.length + 1;

  const dfs = (i: number, j: number): boolean => {
    const key = i * stride + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let res = false;
    if (i === childSeg.length && j === parentSeg.length) {
      res = true;
    } else if (j < parentSeg.length && parentSeg[j] === '*') {
      // '*' in parent matches zero chars OR consumes any single char/wildcard in child.
      res = dfs(i, j + 1) || (i < childSeg.length && dfs(i + 1, j));
    } else if (i < childSeg.length && j < parentSeg.length) {
      const c = childSeg[i];
      const p = parentSeg[j];
      if (p === '?') {
        // '?' in parent matches a single literal char or '?' in child, never '*'.
        res = c !== '*' && dfs(i + 1, j + 1);
      } else {
        // Literal char in parent matches only the exact same literal char in child.
        res = c !== '*' && c !== '?' && c === p && dfs(i + 1, j + 1);
      }
    }

    memo.set(key, res);
    return res;
  };

  return dfs(0, 0);
}

/**
 * True when every relative path matched by `childPattern` is also matched by `parentPattern`.
 */
function singleGlobSubset(childPattern: string, parentPattern: string): boolean {
  const segsC = childPattern.split('/').filter(Boolean);
  const segsP = parentPattern.split('/').filter(Boolean);
  if (segsC.length === 0 || segsP.length === 0) return false;
  const memo = new Map<number, boolean>();
  const stride = segsP.length + 1;

  const dfs = (i: number, j: number): boolean => {
    const key = i * stride + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let res = false;
    if (i === segsC.length && j === segsP.length) {
      res = true;
    } else if (j < segsP.length && segsP[j] === '**') {
      // '**' in parent matches 0 segments OR absorbs 1 segment of child (including child '**').
      res = dfs(i, j + 1) || (i < segsC.length && dfs(i + 1, j));
    } else if (i < segsC.length && segsC[i] === '**') {
      // Parent segment is not '**', so it cannot cover arbitrary depth '**'.
      res = false;
    } else if (i < segsC.length && j < segsP.length) {
      if (segmentSubset(segsC[i], segsP[j])) {
        res = dfs(i + 1, j + 1);
      }
    }

    memo.set(key, res);
    return res;
  };

  return dfs(0, 0);
}

/**
 * Check whether every pattern in `childPatterns` is a subset of `parentPatterns`.
 * - Rejects empty/absolute/`..` traversal patterns.
 * - An empty `parentPatterns` list means unrestricted workspace access, so any safe relative child pattern is allowed.
 * - A non-empty `parentPatterns` list rejects an empty `childPatterns` list.
 */
export function isGlobSubset(
  childPatterns: string[],
  parentPatterns: string[],
): { ok: boolean; invalidPatterns: string[] } {
  const invalid: string[] = [];
  for (const raw of childPatterns) {
    if (isUnsafeGlobPattern(raw)) invalid.push(raw);
  }
  if (invalid.length > 0) {
    return { ok: false, invalidPatterns: invalid };
  }

  const normParent = parentPatterns.flatMap(normalizePattern);
  const normChild = childPatterns.flatMap(normalizePattern);

  if (normParent.length === 0) {
    return { ok: true, invalidPatterns: [] };
  }
  if (normChild.length === 0) {
    return { ok: false, invalidPatterns: ['(empty files_allowed)'] };
  }

  for (const c of normChild) {
    if (!normParent.some((p) => singleGlobSubset(c, p))) {
      invalid.push(c);
    }
  }
  return { ok: invalid.length === 0, invalidPatterns: invalid };
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
  provider: string;
  release: () => void;
}

export interface SlotWaitInfo {
  accountKey: string;
  activeCount: number;
  limit: number;
}

export interface AcquireSlotOptions {
  signal?: AbortSignal;
  onWaitStart?: (info: SlotWaitInfo) => void;
  onWaitEnd?: () => void;
}

interface LimiterWaiter {
  provider: string;
  limit: number;
  resolve: (lease: SlotLease) => void;
  reject: (err: Error) => void;
  onWaitEnd?: () => void;
  cleanup?: () => void;
}

/**
 * Process-wide per-account concurrency limiter shared across all projects and runs.
 * Keyed by `accountKey` (`<provider>` or `<provider>:<configDir>`).
 */
export class ProviderLimiter {
  private readonly activeCounts = new Map<string, number>();
  private readonly waiters: LimiterWaiter[] = [];
  private readonly releaseListeners = new Set<(accountKey: string) => void>();

  getActiveCount(accountKey: string): number {
    return this.activeCounts.get(accountKey) ?? 0;
  }

  getWaiterCount(accountKey?: string): number {
    if (!accountKey) return this.waiters.length;
    return this.waiters.filter((w) => w.provider === accountKey).length;
  }

  hasCapacity(accountKey: string, limit: number): boolean {
    const effectiveLimit = Math.max(1, limit);
    return this.getActiveCount(accountKey) < effectiveLimit;
  }

  tryAcquire(accountKey: string, limit: number): SlotLease | null {
    if (!this.hasCapacity(accountKey, limit)) return null;
    return this.createLease(accountKey);
  }

  acquire(
    accountKey: string,
    limit: number,
    signalOrOptions?: AbortSignal | AcquireSlotOptions,
  ): Promise<SlotLease> {
    const opts: AcquireSlotOptions =
      signalOrOptions && 'aborted' in signalOrOptions
        ? { signal: signalOrOptions }
        : (signalOrOptions ?? {});
    const signal = opts.signal;
    if (signal?.aborted) {
      return Promise.reject(new Error('Aborted while waiting for provider parallel slot'));
    }
    const immediate = this.tryAcquire(accountKey, limit);
    if (immediate) return Promise.resolve(immediate);

    const effectiveLimit = Math.max(1, limit);
    let waitEnded = false;
    const endWait = () => {
      if (waitEnded) return;
      waitEnded = true;
      opts.onWaitEnd?.();
    };

    opts.onWaitStart?.({
      accountKey,
      activeCount: this.getActiveCount(accountKey),
      limit: effectiveLimit,
    });

    return new Promise<SlotLease>((resolve, reject) => {
      const waiter: LimiterWaiter = {
        provider: accountKey,
        limit: effectiveLimit,
        resolve,
        reject,
        onWaitEnd: endWait,
      };

      if (signal) {
        const onAbort = () => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          endWait();
          reject(new Error('Aborted while waiting for provider parallel slot'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.cleanup = () => signal.removeEventListener('abort', onAbort);
      }

      this.waiters.push(waiter);
    });
  }

  onRelease(listener: (accountKey: string) => void): () => void {
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

  private createLease(accountKey: string): SlotLease {
    this.activeCounts.set(accountKey, this.getActiveCount(accountKey) + 1);
    let released = false;
    return {
      provider: accountKey,
      release: () => {
        if (released) return;
        released = true;
        const current = this.getActiveCount(accountKey);
        if (current <= 1) this.activeCounts.delete(accountKey);
        else this.activeCounts.set(accountKey, current - 1);

        this.drainWaiters(accountKey);
        for (const listener of [...this.releaseListeners]) {
          listener(accountKey);
        }
      },
    };
  }

  private drainWaiters(accountKey: string): void {
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i];
      if (w.provider !== accountKey) continue;
      if (!this.hasCapacity(accountKey, w.limit)) continue;
      this.waiters.splice(i, 1);
      w.cleanup?.();
      w.onWaitEnd?.();
      w.resolve(this.createLease(accountKey));
      i--;
    }
  }
}
