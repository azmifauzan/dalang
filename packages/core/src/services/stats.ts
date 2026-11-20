import { and, desc, eq, gte } from 'drizzle-orm';
import type {
  ModelUsageStatisticsDTO,
  ProjectUsageStatisticsDTO,
  ProviderEventDTO,
  ProviderEventType,
  ProviderId,
  ProviderRuntimeStateDTO,
  ProviderStatisticsDTO,
  UsageStatisticsResponseDTO,
} from '@dalang/shared';
import type { DalangDb } from '../db/client.js';
import { leadTurns, projects, providerEvents, runs } from '../db/schema.js';

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

function computeCacheHitRate(inputTokens: number, cacheReadTokens: number): number | null {
  const denom = inputTokens + cacheReadTokens;
  if (denom <= 0) return null;
  return Number(((cacheReadTokens / denom) * 100).toFixed(1));
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

    const leadConditions = [];
    if (projectId) leadConditions.push(eq(leadTurns.projectId, projectId));
    if (cutoffIso) leadConditions.push(gte(leadTurns.startedAt, cutoffIso));

    const leadTurnRows =
      leadConditions.length > 0
        ? this.db.select().from(leadTurns).where(and(...leadConditions)).all()
        : this.db.select().from(leadTurns).all();

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

    const runtimeStates = this.getRuntimeStates();
    const runtimeByProvider = new Map<ProviderId, ProviderRuntimeStateDTO>();
    for (const s of runtimeStates) {
      const existing = runtimeByProvider.get(s.provider);
      if (!existing || s.accountKey === s.provider) {
        runtimeByProvider.set(s.provider, s);
      }
    }

    const providerStatsMap = new Map<ProviderId, ProviderStatisticsDTO>();
    const durationAccumulator = new Map<ProviderId, { totalMs: number; finishedCount: number }>();

    for (const p of PROVIDERS) {
      const rt = runtimeByProvider.get(p.id);
      const providerRuntimeList = runtimeStates.filter((s) => s.provider === p.id);
      const totalActive = providerRuntimeList.reduce((sum, s) => sum + s.activeCount, 0);
      const totalMaxParallel = providerRuntimeList.reduce((sum, s) => sum + s.maxParallel, 0) || rt?.maxParallel || 1;

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
        byKind: { lead: 0, execute: 0, fix: 0, review: 0 },
        totalDurationMs: 0,
        avgDurationMs: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        cacheHitRate: null,
        estimatedCostUsd: 0,
        rateLimitEvents: 0,
        timeoutEvents: 0,
        loginExpiredEvents: 0,
        errorEvents: 0,
        quotaFallbackEvents: 0,
        lastEventAt: null,
        lastEventDetail: null,
        activeRuns: totalActive,
        maxParallel: totalMaxParallel,
        inCooldown: rt?.inCooldown ?? false,
        cooldownReason: rt?.cooldownReason ?? null,
        cooldownUntil: rt?.cooldownUntil ?? null,
        quotaExhausted: rt?.quotaExhausted ?? false,
        quotaReason: rt?.quotaReason ?? null,
      });
      durationAccumulator.set(p.id, { totalMs: 0, finishedCount: 0 });
    }

    const modelStatsMap = new Map<string, ModelUsageStatisticsDTO>();
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
        totalTokens: 0,
        estimatedCostUsd: 0,
      });
    }

    let grandTotalDurationMs = 0;
    let grandCompleted = 0;
    let grandFailed = 0;
    let grandFallback = 0;
    let grandInputTokens = 0;
    let grandOutputTokens = 0;
    let grandCacheReadTokens = 0;
    let grandCacheWriteTokens = 0;
    let grandEstimatedCostUsd = 0;

    const combinedRecords: Array<{
      projectId: string;
      provider: string;
      model: string | null;
      kind: string;
      status: string;
      usedFallback: boolean;
      startedAt: string;
      finishedAt: string | null;
      inputTokens: number | null;
      outputTokens: number | null;
      cacheReadTokens: number | null;
      cacheWriteTokens: number | null;
      estimatedCostUsd: number | null;
      costSource: string | null;
    }> = [
      ...runRows,
      ...leadTurnRows.map((lt) => ({
        projectId: lt.projectId,
        provider: lt.provider,
        model: lt.model,
        kind: 'lead',
        status: lt.status,
        usedFallback: false,
        startedAt: lt.startedAt,
        finishedAt: lt.finishedAt,
        inputTokens: lt.inputTokens,
        outputTokens: lt.outputTokens,
        cacheReadTokens: lt.cacheReadTokens,
        cacheWriteTokens: lt.cacheWriteTokens,
        estimatedCostUsd: lt.estimatedCostUsd,
        costSource: lt.costSource,
      })),
    ];

    for (const r of combinedRecords) {
      const inTok = r.inputTokens ?? 0;
      const outTok = r.outputTokens ?? 0;
      const cacheRead = r.cacheReadTokens ?? 0;
      const cacheWrite = r.cacheWriteTokens ?? 0;
      const runTotalTok = inTok + outTok + cacheRead + cacheWrite;
      const runCost = r.estimatedCostUsd ?? 0;

      grandInputTokens += inTok;
      grandOutputTokens += outTok;
      grandCacheReadTokens += cacheRead;
      grandCacheWriteTokens += cacheWrite;
      grandEstimatedCostUsd += runCost;

      const pStats = providerStatsMap.get(r.provider as ProviderId);
      if (pStats) {
        pStats.totalRuns += 1;
        if (r.status === 'completed') pStats.completedRuns += 1;
        else if (r.status === 'failed') pStats.failedRuns += 1;
        else if (r.status === 'stopped') pStats.stoppedRuns += 1;
        else if (r.status === 'running') pStats.runningRuns += 1;
        else if (r.status === 'rolled_back') pStats.rolledBackRuns += 1;

        if (r.usedFallback) pStats.fallbackRuns += 1;
        if (r.kind === 'lead') pStats.byKind.lead += 1;
        else if (r.kind === 'fix') pStats.byKind.fix += 1;
        else if (r.kind === 'review') pStats.byKind.review += 1;
        else pStats.byKind.execute += 1;

        pStats.inputTokens += inTok;
        pStats.outputTokens += outTok;
        pStats.cacheReadTokens += cacheRead;
        pStats.cacheWriteTokens += cacheWrite;
        pStats.totalTokens += runTotalTok;
        pStats.estimatedCostUsd += runCost;
      }

      const modelName = r.model?.trim() || '(CLI default)';
      const modelKey = `${r.provider}::${modelName}`;
      const existingModel = modelStatsMap.get(modelKey) ?? {
        provider: r.provider as ProviderId,
        model: modelName,
        totalRuns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        cacheHitRate: null,
        estimatedCostUsd: 0,
        costIsEstimated: r.costSource !== 'cli',
      };
      existingModel.totalRuns += 1;
      existingModel.inputTokens += inTok;
      existingModel.outputTokens += outTok;
      existingModel.cacheReadTokens += cacheRead;
      existingModel.cacheWriteTokens += cacheWrite;
      existingModel.totalTokens += runTotalTok;
      existingModel.estimatedCostUsd += runCost;
      if (r.costSource === 'estimated') existingModel.costIsEstimated = true;
      modelStatsMap.set(modelKey, existingModel);

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
        totalTokens: 0,
        estimatedCostUsd: 0,
      };
      projStat.totalRuns += 1;
      if (r.status === 'completed') projStat.completedRuns += 1;
      if (r.status === 'failed') projStat.failedRuns += 1;
      if (r.usedFallback) projStat.fallbackRuns += 1;
      if (durationMs !== null) projStat.totalDurationMs += durationMs;
      projStat.totalTokens += runTotalTok;
      projStat.estimatedCostUsd += runCost;
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
        pStats.cacheHitRate = computeCacheHitRate(pStats.inputTokens, pStats.cacheReadTokens);
        pStats.estimatedCostUsd = Number(pStats.estimatedCostUsd.toFixed(6));
      }
    }

    const models: ModelUsageStatisticsDTO[] = [...modelStatsMap.values()]
      .map((m) => ({
        ...m,
        cacheHitRate: computeCacheHitRate(m.inputTokens, m.cacheReadTokens),
        estimatedCostUsd: Number(m.estimatedCostUsd.toFixed(6)),
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens || b.totalRuns - a.totalRuns);

    const projectsList = [...projectStatsMap.values()]
      .map((p) => ({
        ...p,
        estimatedCostUsd: Number(p.estimatedCostUsd.toFixed(6)),
      }))
      .sort((a, b) => b.totalRuns - a.totalRuns);

    const recentEvents: ProviderEventDTO[] = eventRows
      .slice(0, query.eventLimit ?? 50)
      .map((ev) => ({
        id: ev.id,
        provider: ev.provider as ProviderId,
        accountKey: ev.accountKey ?? ev.provider,
        type: ev.type as ProviderEventType,
        detail: ev.detail ?? null,
        createdAt: ev.createdAt,
      }));

    const grandTotalTokens =
      grandInputTokens + grandOutputTokens + grandCacheReadTokens + grandCacheWriteTokens;

    return {
      generatedAt: new Date(now).toISOString(),
      projectId,
      windowDays,
      totals: {
        totalRuns: combinedRecords.length,
        completedRuns: grandCompleted,
        failedRuns: grandFailed,
        fallbackRuns: grandFallback,
        totalDurationMs: grandTotalDurationMs,
        rateLimitEvents: grandRateLimitEvents,
        inputTokens: grandInputTokens,
        outputTokens: grandOutputTokens,
        cacheReadTokens: grandCacheReadTokens,
        cacheWriteTokens: grandCacheWriteTokens,
        totalTokens: grandTotalTokens,
        cacheHitRate: computeCacheHitRate(grandInputTokens, grandCacheReadTokens),
        estimatedCostUsd: Number(grandEstimatedCostUsd.toFixed(6)),
      },
      providers: PROVIDERS.map((p) => providerStatsMap.get(p.id)!),
      models,
      projects: projectsList,
      recentEvents,
    };
  }
}
