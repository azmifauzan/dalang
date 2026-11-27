import { useEffect, useState } from 'react';
import type { ProviderId } from '@dalang/shared';
import { ProviderIcon } from '../assets/providers/ProviderIcon.js';
import { PROVIDER_LABELS } from '../assets/providers/names.js';
import { useI18n } from '../i18n/index.js';
import { displayLiveText, type LiveTurn } from '../lib/liveTurn.js';
import { Markdown } from './Markdown.js';

function formatStepDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** What a running turn looks like to the user: who is working, for how long, phase, steps, progress, and streamed answer (U1, U2). */
export function LiveTurnPanel({
  provider,
  model,
  roleLabel,
  phase,
  liveTurn,
  liveLogs,
  projectPath,
  startedAt,
}: {
  provider: ProviderId;
  model?: string | null;
  roleLabel?: string;
  phase?: string;
  liveTurn: LiveTurn;
  liveLogs: string[];
  projectPath: string;
  startedAt: number;
}) {
  const { t } = useI18n();
  const elapsed = () => Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const [seconds, setSeconds] = useState(elapsed);

  useEffect(() => {
    setSeconds(elapsed());
    const id = window.setInterval(() => setSeconds(elapsed()), 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startedAt]);

  const text = displayLiveText(liveTurn);
  const { activity } = liveTurn;
  const resolvedModel = model ?? liveTurn.model ?? null;
  const relative =
    activity?.target && activity.target.startsWith(`${projectPath}/`)
      ? activity.target.slice(projectPath.length + 1)
      : activity?.target;
  const target = relative && relative.length > 80 ? `${relative.slice(0, 79)}…` : relative;

  const phaseLabel =
    liveTurn.phase === 'resuming'
      ? t('sessions.activity.resuming')
      : liveTurn.phase === 'starting' && !activity && !text
        ? t('sessions.activity.start')
        : liveTurn.phase === 'streaming' || text
          ? t('sessions.activity.writing')
          : null;

  const activityText = !activity
    ? phaseLabel ?? t('sessions.activity.start')
    : activity.kind === 'think'
      ? t('sessions.activity.think')
      : activity.kind === 'edit'
        ? target
          ? `Editing ${target}`
          : t('sessions.activity.working')
        : target
          ? t(`sessions.activity.${activity.kind}`, { target })
          : t('sessions.activity.working');

  const completedSteps = liveTurn.steps.filter((s) => s.status !== 'running');
  const activeStep = liveTurn.steps.findLast((s) => s.status === 'running') ?? null;

  return (
    <div
      className="mr-auto w-full max-w-[95%] rounded-[10px] border p-4"
      style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
      data-live-phase={liveTurn.phase}
    >
      <div role="status" aria-live="polite">
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <ProviderIcon id={provider} size={18} />
          <span className="min-w-0 flex-1">
            {roleLabel
              ? `${roleLabel} · ${PROVIDER_LABELS[provider]}`
              : t(
                  phase === 'quick'
                    ? 'sessions.thinkingQuick'
                    : phase === undefined || phase === 'ask' || phase === 'discuss'
                      ? 'sessions.thinking'
                      : 'sessions.thinkingWork',
                  { provider: PROVIDER_LABELS[provider] },
                )}
            {resolvedModel ? (
              <span className="ml-1.5 font-mono-token text-xs font-normal" style={{ color: 'var(--text-secondary)' }}>
                ({resolvedModel})
              </span>
            ) : null}
          </span>
          <span className="shrink-0 font-mono-token text-xs" style={{ color: 'var(--text-secondary)' }}>
            {seconds}s
          </span>
        </div>
        <p className="mt-2 flex items-center gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 shrink-0 rounded-full motion-safe:animate-pulse"
            style={{ backgroundColor: 'var(--accent)' }}
          />
          <span className="min-w-0 break-words">
            {activeStep
              ? `${activeStep.label}${activeStep.target ? `: ${activeStep.target}` : ''}`
              : activityText}
          </span>
        </p>
      </div>

      {liveTurn.progressMessages.length > 0 && (
        <div className="mt-2 space-y-0.5 text-xs opacity-75" style={{ color: 'var(--text-secondary)' }}>
          {liveTurn.progressMessages.slice(-4).map((line, i) => (
            <p key={i} className="truncate">
              {line}
            </p>
          ))}
        </div>
      )}

      {completedSteps.length > 0 && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer select-none" style={{ color: 'var(--text-secondary)' }}>
            {t('sessions.stepsCompleted', { count: completedSteps.length })}
          </summary>
          <ul className="mt-1.5 space-y-1 pl-3" style={{ color: 'var(--text-secondary)' }}>
            {completedSteps.map((step) => (
              <li key={step.id} className="flex items-center justify-between gap-2 font-mono-token">
                <span className="truncate">
                  {step.status === 'failed' ? '✗' : '✓'} {step.label}
                  {step.target ? `: ${step.target}` : ''}
                </span>
                <span className="shrink-0 opacity-75">
                  {step.exitCode !== undefined && step.exitCode !== null ? `exit ${step.exitCode} · ` : ''}
                  {formatStepDuration(step.durationMs)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {text && (
        <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--border-subtle)' }} data-live-stream="true">
          <Markdown>{text}</Markdown>
        </div>
      )}

      {liveLogs.length > 0 && (
        <details className="mt-3 text-xs">
          <summary
            className="inline-flex min-h-11 cursor-pointer items-center"
            style={{ color: 'var(--text-secondary)' }}
          >
            {t('sessions.showLog')}
          </summary>
          <pre
            className="max-h-40 overflow-auto rounded-[6px] border p-2 font-mono-token"
            style={{
              backgroundColor: 'var(--bg-well)',
              borderColor: 'var(--border-subtle)',
              color: 'var(--text-secondary)',
            }}
          >
            {liveLogs.slice(-20).join('\n')}
          </pre>
        </details>
      )}
    </div>
  );
}
