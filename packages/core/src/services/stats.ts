import { and, desc, eq, gte } from 'drizzle-orm';
import type {
  ProjectUsageStatisticsDTO,
  ProviderEventDTO,
  ProviderEventType,
  ProviderId,
  ProviderRuntimeStateDTO,
  ProviderStatisticsDTO,
  UsageStatisticsResponseDTO,
} from '@dalang/shared';
import type { DalangDb } from '../db/client.js';
import { projects, providerEvents, runs } from '../db/schema.js';

const PROVIDERS: Array<{ id: ProviderId; displayName: string }> = [
  { id: 'claude-code', displayName: 'Claude Code' },
  { id: 'codex', displayName: 'Codex CLI' },
  { id: 'antigravity', displayName: 'Antigravity CLI' },
];

export interface UsageStatisticsQuery {
  projectId?: string;
  days?: number;
  eventLimit?: number;
}

export class StatisticsService {
  constructor(
    private readonly db: DalangDb,
    private readonly getRuntimeStates: () => ProviderRuntimeStateDTO[] = () => [],
  ) {}

  getUsageStatistics(query: UsageStatisticsQuery = {}): UsageStatisticsResponseDTO {
    const now = Date.now();
    const windowDays = query.days && query.days > 0 ? Math.floor(query.days) : null;
    const cutoffIso = windowDays ? new Date(now - windowDays * 86_400_000).toISOString() : null;
    const projectId = query.projectId?.trim() || null;

    const runConditions = [];
    if (projectId) runConditions.push(eq(runs.projectId, projectId));
    if (cutoffIso) runConditions.push(gte(runs.startedAt, cutoffIso));

    const runRows =
      runConditions.length > 0
        ? this.db.select().from(runs).where(and(...runConditions)).all()
        : this.db.select().from(runs).all();

    const eventRows = cutoffIso
      ? this.db
          .select()
          .from(providerEvents)
          .where(gte(providerEvents.createdAt, cutoffIso))
          .orderBy(desc(providerEvents.createdAt))
          .all()
      : this.db.select().from(providerEvents).orderBy(desc(providerEvents.createdAt)).all();

    const projectRows = this.db.select().from(projects).all();
    const projectNameById = new Map(projectRows.map((p) => [p.id, p.name]));
    const runtimeByProvider = new Map(this.getRuntimeStates().map((s) => [s.provider, s]));

    const providerStatsMap = new Map<ProviderId, ProviderStatisticsDTO>();
    const durationAccumulator = new Map<ProviderId, { totalMs: number; finishedCount: number }>();

    for (const p of PROVIDERS) {
      const rt = runtimeByProvider.get(p.id);
      providerStatsMap.set(p.id, {
        provider: p.id,
        displayName: p.displayName,
        totalRuns: 0,
        completedRuns: 0,
        failedRuns: 0,
        stoppedRuns: 0,
        runningRuns: 0,
        rolledBackRuns: 0,
        fallbackRuns: 0,
        byKind: { execute: 0, fix: 0, review: 0 },
        totalDurationMs: 0,
        avgDurationMs: null,
        rateLimitEvents: 0,
        timeoutEvents: 0,
        loginExpiredEvents: 0,
        errorEvents: 0,
        quotaFallbackEvents: 0,
        lastEventAt: null,
        lastEventDetail: null,
        activeRuns: rt?.activeCount ?? 0,
        maxParallel: rt?.maxParallel ?? 1,
        inCooldown: rt?.inCooldown ?? false,
        cooldownReason: rt?.cooldownReason ?? null,
        cooldownUntil: rt?.cooldownUntil ?? null,
        quotaExhausted: rt?.quotaExhausted ?? false,
        quotaReason: rt?.quotaReason ?? null,
      });
      durationAccumulator.set(p.id, { totalMs: 0, finishedCount: 0 });
    }

    const projectStatsMap = new Map<string, ProjectUsageStatisticsDTO>();
    for (const proj of projectRows) {
      if (projectId && proj.id !== projectId) continue;
      projectStatsMap.set(proj.id, {
        projectId: proj.id,
        projectName: proj.name,
        totalRuns: 0,
        completedRuns: 0,
        failedRuns: 0,
        fallbackRuns: 0,
        totalDurationMs: 0,
      });
    }

    let grandTotalDurationMs = 0;
    let grandCompleted = 0;
    let grandFailed = 0;
    let grandFallback = 0;

    for (const r of runRows) {
      const pStats = providerStatsMap.get(r.provider as ProviderId);
      if (pStats) {
        pStats.totalRuns += 1;
        if (r.status === 'completed') pStats.completedRuns += 1;
        else if (r.status === 'failed') pStats.failedRuns += 1;
        else if (r.status === 'stopped') pStats.stoppedRuns += 1;
        else if (r.status === 'running') pStats.runningRuns += 1;
        else if (r.status === 'rolled_back') pStats.rolledBackRuns += 1;

        if (r.usedFallback) pStats.fallbackRuns += 1;
        if (r.kind === 'fix') pStats.byKind.fix += 1;
        else if (r.kind === 'review') pStats.byKind.review += 1;
        else pStats.byKind.execute += 1;
      }

      const durationMs =
        r.finishedAt && r.startedAt
          ? Math.max(0, new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime())
          : null;

      if (durationMs !== null) {
        grandTotalDurationMs += durationMs;
        const acc = durationAccumulator.get(r.provider as ProviderId);
        if (acc) {
          acc.totalMs += durationMs;
          acc.finishedCount += 1;
        }
      }

      if (r.status === 'completed') grandCompleted += 1;
      if (r.status === 'failed') grandFailed += 1;
      if (r.usedFallback) grandFallback += 1;

      const projStat = projectStatsMap.get(r.projectId) ?? {
        projectId: r.projectId,
        projectName: projectNameById.get(r.projectId) ?? r.projectId,
        totalRuns: 0,
        completedRuns: 0,
        failedRuns: 0,
        fallbackRuns: 0,
        totalDurationMs: 0,
      };
      projStat.totalRuns += 1;
      if (r.status === 'completed') projStat.completedRuns += 1;
      if (r.status === 'failed') projStat.failedRuns += 1;
      if (r.usedFallback) projStat.fallbackRuns += 1;
      if (durationMs !== null) projStat.totalDurationMs += durationMs;
      projectStatsMap.set(r.projectId, projStat);
    }

    let grandRateLimitEvents = 0;
    for (const ev of eventRows) {
      const pStats = providerStatsMap.get(ev.provider as ProviderId);
      if (pStats) {
        if (ev.type === 'rate_limit') {
          pStats.rateLimitEvents += 1;
          grandRateLimitEvents += 1;
        } else if (ev.type === 'timeout') {
          pStats.timeoutEvents += 1;
        } else if (ev.type === 'login_expired') {
          pStats.loginExpiredEvents += 1;
        } else if (ev.type === 'quota_fallback') {
          pStats.quotaFallbackEvents += 1;
        } else {
          pStats.errorEvents += 1;
        }
        if (!pStats.lastEventAt) {
          pStats.lastEventAt = ev.createdAt;
          pStats.lastEventDetail = ev.detail ?? null;
        }
      }
    }

    for (const [pid, acc] of durationAccumulator) {
      const pStats = providerStatsMap.get(pid);
      if (pStats) {
        pStats.totalDurationMs = acc.totalMs;
        pStats.avgDurationMs = acc.finishedCount > 0 ? Math.round(acc.totalMs / acc.finishedCount) : null;
      }
    }

    const recentEvents: ProviderEventDTO[] = eventRows
      .slice(0, query.eventLimit ?? 50)
      .map((ev) => ({
        id: ev.id,
        provider: ev.provider as ProviderId,
        type: ev.type as ProviderEventType,
        detail: ev.detail ?? null,
        createdAt: ev.createdAt,
      }));

    return {
      generatedAt: new Date(now).toISOString(),
      projectId,
      windowDays,
      totals: {
        totalRuns: runRows.length,
        completedRuns: grandCompleted,
        failedRuns: grandFailed,
        fallbackRuns: grandFallback,
        totalDurationMs: grandTotalDurationMs,
        rateLimitEvents: grandRateLimitEvents,
      },
      providers: PROVIDERS.map((p) => providerStatsMap.get(p.id)!),
      projects: [...projectStatsMap.values()].sort((a, b) => b.totalRuns - a.totalRuns),
      recentEvents,
    };
  }
}
