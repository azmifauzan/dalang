import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useI18n } from '../i18n/index.js';
import { ErrorPanel, LoadingPanel } from './StateViews.js';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

function formatUsd(cost: number): string {
  if (cost <= 0) return '$0.00';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

function formatStatsDuration(ms: number | null): string {
  if (ms === null || ms < 0) return 'n/a';
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
}

export function StatisticsView() {
  const { t, te, formatDateTime } = useI18n();
  const [statsDays, setStatsDays] = useState<string>('30');
  const [statsProjectId, setStatsProjectId] = useState<string>('');

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.listProjects(),
  });

  const statsQuery = useQuery({
    queryKey: ['statistics', statsProjectId, statsDays],
    queryFn: () =>
      api.getUsageStatistics({
        projectId: statsProjectId || undefined,
        days: statsDays ? Number(statsDays) : undefined,
      }),
  });

  const projects = projectsQuery.data?.projects ?? [];
  const statistics = statsQuery.data?.statistics ?? null;

  return (
    <div className="space-y-6">
      <div
        className="flex flex-wrap items-center justify-between gap-4 rounded-[8px] border p-5"
        style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
      >
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('stats.title')}</h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
            {t('stats.subtitle')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div>
            <Label htmlFor="stats-project-filter" className="sr-only">
              {t('stats.filterProject')}
            </Label>
            <NativeSelect
              id="stats-project-filter"
              value={statsProjectId}
              onChange={(e) => setStatsProjectId(e.target.value)}
              className="w-auto"
            >
              <option value="">{t('stats.allProjects')}</option>
              {projects.map((proj) => (
                <option key={proj.id} value={proj.id}>
                  {proj.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div>
            <Label htmlFor="stats-days-filter" className="sr-only">
              {t('stats.filterWindow')}
            </Label>
            <NativeSelect
              id="stats-days-filter"
              value={statsDays}
              onChange={(e) => setStatsDays(e.target.value)}
              className="w-auto"
            >
              <option value="1">{t('stats.last24h')}</option>
              <option value="7">{t('stats.last7d')}</option>
              <option value="30">{t('stats.last30d')}</option>
              <option value="">{t('stats.allTime')}</option>
            </NativeSelect>
          </div>
        </div>
      </div>

      {statsQuery.isLoading && <LoadingPanel label={t('stats.loading')} />}

      {statsQuery.isError && (
        <ErrorPanel
          title={t('stats.loadError')}
          detail={statsQuery.error.message}
          onRetry={() => statsQuery.refetch()}
        />
      )}

      {statistics && (
        <div className="space-y-5">
          {/* Totals strip */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <div
              className="rounded-[6px] border p-3.5"
              style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
            >
              <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {t('stats.totalRuns')}
              </div>
              <div className="mt-1 font-mono-token text-lg font-semibold">
                {statistics.totals.totalRuns}
              </div>
            </div>
            <div
              className="rounded-[6px] border p-3.5"
              style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
            >
              <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {t('stats.completedFailed')}
              </div>
              <div className="mt-1 font-mono-token text-lg font-semibold">
                <span style={{ color: 'var(--pass)' }}>{statistics.totals.completedRuns}</span>
                {' / '}
                <span style={{ color: statistics.totals.failedRuns > 0 ? 'var(--error)' : 'inherit' }}>
                  {statistics.totals.failedRuns}
                </span>
              </div>
            </div>
            <div
              className="rounded-[6px] border p-3.5"
              style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
            >
              <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {t('stats.quotaFallbacks')}
              </div>
              <div className="mt-1 font-mono-token text-lg font-semibold">
                {statistics.totals.fallbackRuns}
              </div>
            </div>
            <div
              className="rounded-[6px] border p-3.5"
              style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
            >
              <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {t('stats.totalRuntime')}
              </div>
              <div className="mt-1 font-mono-token text-lg font-semibold">
                {formatStatsDuration(statistics.totals.totalDurationMs)}
              </div>
            </div>
            <div
              className="rounded-[6px] border p-3.5"
              style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
            >
              <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {t('stats.capturedTokens')}
              </div>
              <div className="mt-1 font-mono-token text-lg font-semibold">
                {formatTokens(statistics.totals.totalTokens)}
              </div>
              <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {statistics.totals.cacheHitRate !== null
                  ? t('stats.cacheHit', { rate: statistics.totals.cacheHitRate })
                  : t('stats.noTokenData')}
              </div>
            </div>
            <div
              className="rounded-[6px] border p-3.5"
              style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
            >
              <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {t('stats.estCost')}
              </div>
              <div className="mt-1 font-mono-token text-lg font-semibold">
                {formatUsd(statistics.totals.estimatedCostUsd)}
              </div>
              <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {t('stats.notSubscriptionBill')}
              </div>
            </div>
          </div>

          {/* Per-provider breakdown */}
          <div
            className="overflow-x-auto rounded-[6px] border"
            style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-surface)' }}
          >
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr
                  className="border-b"
                  style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-well)' }}
                >
                  <th className="px-4 py-3 font-semibold">{t('stats.colProvider')}</th>
                  <th className="px-4 py-3 font-semibold">{t('stats.colRunsKinds')}</th>
                  <th className="px-4 py-3 font-semibold">{t('stats.colOutcomes')}</th>
                  <th className="px-4 py-3 font-semibold">{t('stats.colDuration')}</th>
                  <th className="px-4 py-3 font-semibold">{t('stats.colLimitsErrors')}</th>
                  <th className="px-4 py-3 font-semibold">{t('stats.colLivePool')}</th>
                </tr>
              </thead>
              <tbody>
                {statistics.providers.map((ps) => (
                  <tr
                    key={ps.provider}
                    className="border-b last:border-b-0"
                    style={{ borderColor: 'var(--border-subtle)' }}
                  >
                    <td className="px-4 py-3">
                      <div className="font-semibold">{ps.displayName}</div>
                      <div className="font-mono-token text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {ps.provider}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono-token text-xs">
                      <div className="text-sm font-semibold">{ps.totalRuns}</div>
                      <div style={{ color: 'var(--text-secondary)' }}>
                        {ps.byKind.lead ?? 0} / {ps.byKind.execute} / {ps.byKind.fix} / {ps.byKind.review}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono-token text-xs">
                      <div>
                        {ps.completedRuns} ok · {ps.failedRuns} fail · {ps.stoppedRuns} stop
                      </div>
                      <div style={{ color: 'var(--text-secondary)' }}>
                        {ps.fallbackRuns} fallback · {ps.rolledBackRuns} rollback
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono-token text-xs">
                      <div>Avg: {formatStatsDuration(ps.avgDurationMs)}</div>
                      <div style={{ color: 'var(--text-secondary)' }}>
                        Total: {formatStatsDuration(ps.totalDurationMs)}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono-token text-xs">
                      <div>
                        429: {ps.rateLimitEvents} · timeout: {ps.timeoutEvents} · auth: {ps.loginExpiredEvents}
                      </div>
                      <div style={{ color: 'var(--text-secondary)' }}>
                        reroute: {ps.quotaFallbackEvents} · err: {ps.errorEvents}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <Badge>
                        {t('work.slotsActive', { active: ps.activeRuns, max: ps.maxParallel })}
                      </Badge>
                      {ps.inCooldown && (
                        <p className="mt-1 font-medium" style={{ color: 'var(--error)' }}>
                          {t('stats.cooldownActive')}
                        </p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Per-model tokens & estimated cost */}
          <div
            className="overflow-x-auto rounded-[6px] border"
            style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-surface)' }}
          >
            <div
              className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3"
              style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-well)' }}
            >
              <h2 className="text-sm font-semibold">{t('stats.tokensByModelTitle')}</h2>
              <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {t('stats.tokensByModelNote')}
              </span>
            </div>
            {statistics.models.length === 0 ? (
              <p className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
                {t('stats.noModelRuns')}
              </p>
            ) : (
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr
                    className="border-b"
                    style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-well)' }}
                  >
                    <th className="px-4 py-2.5 font-semibold">{t('stats.colModel')}</th>
                    <th className="px-4 py-2.5 font-semibold">{t('stats.colProvider')}</th>
                    <th className="px-4 py-2.5 font-semibold">{t('stats.colRuns')}</th>
                    <th className="px-4 py-2.5 font-semibold">{t('stats.colInputOutput')}</th>
                    <th className="px-4 py-2.5 font-semibold">{t('stats.colCacheRead')}</th>
                    <th className="px-4 py-2.5 font-semibold">{t('stats.colEstCost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {statistics.models.map((ms) => (
                    <tr
                      key={`${ms.provider}-${ms.model}`}
                      className="border-b last:border-b-0"
                      style={{ borderColor: 'var(--border-subtle)' }}
                    >
                      <td className="px-4 py-2.5 font-mono-token text-xs font-semibold">
                        {ms.model === '(CLI default)' ? `(${t('common.cliDefault')})` : ms.model}
                      </td>
                      <td className="px-4 py-2.5 font-mono-token text-xs">{ms.provider}</td>
                      <td className="px-4 py-2.5 font-mono-token text-xs">{ms.totalRuns}</td>
                      <td className="px-4 py-2.5 font-mono-token text-xs">
                        {formatTokens(ms.inputTokens)} in / {formatTokens(ms.outputTokens)} out
                      </td>
                      <td className="px-4 py-2.5 font-mono-token text-xs">
                        {formatTokens(ms.cacheReadTokens)}
                        {ms.cacheHitRate !== null ? ` (${ms.cacheHitRate}%)` : ''}
                      </td>
                      <td className="px-4 py-2.5 font-mono-token text-xs">
                        {formatUsd(ms.estimatedCostUsd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Per-project & recent events */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div
              className="rounded-[6px] border p-4"
              style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
            >
              <h2 className="text-sm font-semibold">
                {t('stats.perProjectTitle', { count: statistics.projects.length })}
              </h2>
              {statistics.projects.length === 0 ? (
                <p className="mt-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {t('stats.noProjectRuns')}
                </p>
              ) : (
                <ul className="mt-3 space-y-2 text-xs">
                  {statistics.projects.map((proj) => (
                    <li
                      key={proj.projectId}
                      className="space-y-1 border-b pb-2 last:border-b-0 last:pb-0"
                      style={{ borderColor: 'var(--border-subtle)' }}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">{proj.projectName}</span>
                        <span className="font-mono-token" style={{ color: 'var(--text-secondary)' }}>
                          {proj.totalRuns} runs · {proj.completedRuns} ok · {proj.failedRuns} fail ·{' '}
                          {proj.fallbackRuns} fallback · {formatStatsDuration(proj.totalDurationMs)}
                        </span>
                      </div>
                      {proj.timing &&
                        (proj.timing.setupMs > 0 ||
                          proj.timing.slotWaitMs > 0 ||
                          proj.timing.agentMs > 0 ||
                          proj.timing.verifyMs > 0 ||
                          proj.timing.reviewMs > 0) && (
                          <div className="font-mono-token text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                            {[
                              proj.timing.setupMs > 0 ? `setup ${formatStatsDuration(proj.timing.setupMs)}` : null,
                              proj.timing.slotWaitMs > 0 ? `wait ${formatStatsDuration(proj.timing.slotWaitMs)}` : null,
                              proj.timing.agentMs > 0 ? `agent ${formatStatsDuration(proj.timing.agentMs)}` : null,
                              proj.timing.verifyMs > 0 ? `verify ${formatStatsDuration(proj.timing.verifyMs)}` : null,
                              proj.timing.reviewMs > 0 ? `review ${formatStatsDuration(proj.timing.reviewMs)}` : null,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </div>
                        )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div
              className="rounded-[6px] border p-4"
              style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
            >
              <h2 className="text-sm font-semibold">
                {t('stats.recentEventsTitle', { count: statistics.recentEvents.length })}
              </h2>
              {statistics.recentEvents.length === 0 ? (
                <p className="mt-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {t('stats.noEvents')}
                </p>
              ) : (
                <ul className="mt-3 max-h-60 space-y-2 overflow-y-auto text-xs">
                  {statistics.recentEvents.slice(0, 15).map((ev) => (
                    <li
                      key={ev.id}
                      className="border-b pb-2 last:border-b-0 last:pb-0"
                      style={{ borderColor: 'var(--border-subtle)' }}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5">
                          <Badge>{ev.provider}</Badge>
                          <Badge>{te(ev.type)}</Badge>
                        </span>
                        <span className="font-mono-token" style={{ color: 'var(--text-secondary)' }}>
                          {formatDateTime(ev.createdAt)}
                        </span>
                      </div>
                      {ev.detail && (
                        <p className="mt-1 break-words" style={{ color: 'var(--text-secondary)' }}>
                          {ev.detail}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
