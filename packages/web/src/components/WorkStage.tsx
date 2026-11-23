import { useEffect, useState } from 'react';
import type {
  ProviderId,
  ProviderRuntimeStateDTO,
  TaskDispatchPreviewDTO,
  TaskRunDTO,
} from '@dalang/shared';
import {
  WayangFigure,
  castDisplayName,
  characterForProfile,
  type WayangCharacterId,
} from '../assets/wayang/WayangFigure.js';
import { useI18n } from '../i18n/index.js';
import {
  providerBadgeStyle,
  providerDisplayShort,
  type ActivityFeedItem,
} from '../lib/activity.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface StageActor {
  key: string;
  character: WayangCharacterId;
  castName: string;
  provider: ProviderId;
  taskId?: string;
  taskExternalId?: string;
  statusLine: string;
  active: boolean;
  dimmed: boolean;
}

const castName = castDisplayName;

export function WorkStage({
  activeRuns,
  previews,
  providerStates,
  activityFeed,
  onSelectTask,
}: {
  activeRuns: TaskRunDTO[];
  previews: TaskDispatchPreviewDTO[];
  providerStates: ProviderRuntimeStateDTO[];
  activityFeed: ActivityFeedItem[];
  onSelectTask: (taskId: string, runId?: string) => void;
}) {
  const { t, te, formatTime } = useI18n();
  const [userPaused, setUserPaused] = useState(false);
  const [tabHidden, setTabHidden] = useState(() =>
    typeof document !== 'undefined' ? document.visibilityState === 'hidden' : false,
  );

  useEffect(() => {
    const onVis = () => setTabHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const paused = userPaused || tabHidden;

  // Build actors on the kelir stage from real active runs & dimmed waiting/cooldown providers.
  const actors: StageActor[] = [];

  for (const run of activeRuns) {
    const preview = previews.find((p) => p.taskId === run.taskId);
    const ch = characterForProfile(
      run.profileName,
      preview?.role ?? (run.kind === 'review' ? 'reviewer' : 'engineer'),
      run.usedFallback,
      preview?.complexity ?? null,
    );
    actors.push({
      key: `run-${run.id}`,
      character: ch,
      castName: castName(ch),
      provider: run.provider,
      taskId: run.taskId,
      taskExternalId: run.taskExternalId,
      statusLine: `${run.taskExternalId} · ${te(run.kind)}`,
      active: true,
      dimmed: false,
    });
  }

  // Add dimmed waiting figures for providers currently in cooldown or quota exhausted
  for (const ps of providerStates) {
    if (ps.inCooldown || ps.quotaExhausted) {
      const ch: WayangCharacterId = ps.provider === 'antigravity' ? 'arjuna' : 'bima';
      const reason = ps.cooldownUntil
        ? t('work.stageQuotaResumes', { time: formatTime(ps.cooldownUntil) })
        : ps.cooldownReason ?? ps.quotaReason ?? t('work.stageCooldown');
      actors.push({
        key: `wait-${ps.accountKey}`,
        character: ch,
        castName: castName(ch),
        provider: ps.provider,
        statusLine: reason,
        active: false,
        dimmed: true,
      });
    }
  }

  // If no runs are active and no provider is waiting, show the resting cast from ready previews (factual!)
  if (actors.length === 0) {
    const firstCoder = previews.find((p) => p.role === 'engineer');
    actors.push({
      key: 'rest-semar',
      character: 'semar',
      castName: 'Semar',
      provider: 'claude-code',
      statusLine: t('wizard.cast.semarRole'),
      active: false,
      dimmed: false,
    });
    if (firstCoder) {
      actors.push({
        key: `rest-bima-${firstCoder.taskId}`,
        character: 'bima',
        castName: 'Bima',
        provider: firstCoder.resolvedProvider,
        taskId: firstCoder.taskId,
        taskExternalId: firstCoder.externalId,
        statusLine: `${firstCoder.externalId} · ${te(firstCoder.status)}`,
        active: false,
        dimmed: firstCoder.status === 'done',
      });
    }
    actors.push({
      key: 'rest-arjuna',
      character: 'arjuna',
      castName: 'Arjuna',
      provider: firstCoder?.resolvedProvider === 'claude-code' ? 'codex' : 'claude-code',
      statusLine: t('wizard.cast.arjunaRole'),
      active: false,
      dimmed: false,
    });
  }

  const formatFeedLine = (item: ActivityFeedItem): string => {
    const cast = castName(item.character);
    const prov = providerDisplayShort(item.provider);
    switch (item.kind) {
      case 'started':
        return t('work.feedStarted', {
          cast,
          provider: prov,
          taskId: item.taskExternalId ?? '',
          title: item.title ?? '',
        });
      case 'writing':
        return t('work.feedWriting', { cast, provider: prov, target: item.target ?? '' });
      case 'command':
        return t('work.feedCommand', { cast, provider: prov, command: item.command ?? '' });
      case 'completed':
        return t('work.feedCompleted', { cast, provider: prov, taskId: item.taskExternalId ?? '' });
      case 'failed':
        return t('work.feedFailed', {
          cast,
          provider: prov,
          taskId: item.taskExternalId ?? '',
          reason: item.reason ?? 'error',
        });
      case 'review_pass':
        return t('work.feedReviewPass', {
          round: item.round ?? 1,
          taskId: item.taskExternalId ?? '',
        });
      case 'review_fail':
        return t('work.feedReviewFail', {
          round: item.round ?? 1,
          taskId: item.taskExternalId ?? '',
        });
      case 'integration':
        return t('work.feedIntegration', { status: te(item.status ?? 'done') });
      case 'delegated':
        return t('work.feedDelegated', {
          parent: item.target ?? '',
          subtask: item.taskExternalId ?? '',
          provider: prov,
          title: item.title ?? '',
        });
      case 'subtask_merged':
        return t('work.feedSubtaskMerged', {
          subtask: item.taskExternalId ?? '',
          branch: item.target ?? '',
        });
      case 'subagent':
        return t('work.feedNativeSubagent', {
          cast,
          provider: prov,
          label: item.target ?? '',
        });
    }
  };

  return (
    <section
      aria-label={t('work.stageTitle')}
      className="overflow-hidden rounded-[8px] border"
      style={{
        backgroundColor: 'var(--bg-surface)',
        borderColor: 'var(--border-subtle)',
      }}
    >
      {/* Stage header strip */}
      <div
        className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">{t('work.stageTitle')}</h2>
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            {activeRuns.length > 0
              ? t('work.stageActive', { count: activeRuns.length })
              : t('work.stageIdle')}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className="hidden text-xs sm:inline" style={{ color: 'var(--text-secondary)' }}>
            {t('work.stageClickHint')}
          </span>
          <Button
            type="button"
            variant="outline"
            onClick={() => setUserPaused((p) => !p)}
          >
            {userPaused ? t('common.playAnimation') : t('common.pauseAnimation')}
          </Button>
        </div>
      </div>

      {/* Kelir (lit screen) + Debog (banana-trunk base) */}
      <div className="kelir-screen relative px-4 pt-5 pb-2" data-stage-paused={paused ? 'true' : 'false'}>
        <div className="flex flex-wrap items-end justify-center gap-6">
          {actors.map((actor, idx) => {
            const clickable = Boolean(actor.taskId);
            const figure = (
              <div className="flex flex-col items-center">
                <WayangFigure
                  character={actor.character}
                  variant="shadow"
                  animated={actor.active}
                  paused={paused}
                  dimmed={actor.dimmed}
                  facing={idx % 2 === 1 ? 'right' : 'left'}
                  size={112}
                  label={`${actor.castName} (${providerDisplayShort(actor.provider)})`}
                />
                <div className="mt-1 flex flex-wrap items-center justify-center gap-1.5">
                  <span
                    className="rounded-[4px] border px-2 py-0.5 text-xs font-semibold"
                    style={providerBadgeStyle(actor.provider)}
                  >
                    {actor.castName} · {providerDisplayShort(actor.provider)}
                  </span>
                </div>
                <span
                  className="mt-1 max-w-[170px] truncate rounded-[4px] px-1.5 py-0.5 font-mono-token text-[11px]"
                  style={{
                    backgroundColor: 'var(--bg-surface)',
                    color: 'var(--text-secondary)',
                  }}
                  title={actor.statusLine}
                >
                  {actor.statusLine}
                </span>
              </div>
            );

            return clickable ? (
              <button
                key={actor.key}
                type="button"
                onClick={() => onSelectTask(actor.taskId!)}
                className="min-h-[44px] cursor-pointer rounded-[6px] p-1.5 transition-colors duration-150 hover:bg-black/5"
              >
                {figure}
              </button>
            ) : (
              <div key={actor.key} className="p-1.5">
                {figure}
              </div>
            );
          })}
        </div>
      </div>

      {/* Debog (banana-trunk base bar) */}
      <div
        aria-hidden="true"
        className="h-3 w-full border-t"
        style={{
          backgroundColor: 'var(--debog-bg)',
          borderColor: 'var(--debog-border)',
        }}
      />

      {/* Factual Activity Feed */}
      <div className="px-4 py-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
            {t('work.feedTitle')}
          </h3>
          <Badge>{activityFeed.length}</Badge>
        </div>

        {activityFeed.length === 0 ? (
          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            {t('work.feedEmpty')}
          </p>
        ) : (
          <ul className="max-h-36 space-y-1.5 overflow-y-auto text-xs">
            {activityFeed.slice(0, 12).map((item) => (
              <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="min-w-0 flex-1">
                  {item.taskId ? (
                    <button
                      type="button"
                      onClick={() => onSelectTask(item.taskId!)}
                      className="cursor-pointer text-left hover:underline"
                    >
                      {formatFeedLine(item)}
                    </button>
                  ) : (
                    <span>{formatFeedLine(item)}</span>
                  )}
                </span>
                <span className="shrink-0 font-mono-token text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                  {formatTime(item.timestamp)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
