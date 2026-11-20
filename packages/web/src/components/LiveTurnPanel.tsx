import { useEffect, useState } from 'react';
import type { ProviderId } from '@dalang/shared';
import { ProviderIcon } from '../assets/providers/ProviderIcon.js';
import { PROVIDER_LABELS } from '../assets/providers/names.js';
import { useI18n } from '../i18n/index.js';
import { displayLiveText, type LiveTurn } from '../lib/liveTurn.js';
import { Markdown } from './Markdown.js';

/** What a running turn looks like to the user: who is working, for how long, on what, and the answer as it forms. */
export function LiveTurnPanel({
  provider,
  phase,
  liveTurn,
  liveLogs,
  projectPath,
  startedAt,
}: {
  provider: ProviderId;
  /** What the Lead is doing: answering a question, drafting a quick plan, or other work. */
  phase?: string;
  liveTurn: LiveTurn;
  liveLogs: string[];
  projectPath: string;
  /** When the turn began, so the clock is right after coming back to a chat that is still working. */
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
  const relative =
    activity?.target && activity.target.startsWith(`${projectPath}/`)
      ? activity.target.slice(projectPath.length + 1)
      : activity?.target;
  const target = relative && relative.length > 80 ? `${relative.slice(0, 79)}…` : relative;

  const activityText = !activity
    ? text
      ? t('sessions.activity.writing')
      : t('sessions.activity.start')
    : activity.kind === 'think'
      ? t('sessions.activity.think')
      : target
        ? t(`sessions.activity.${activity.kind}`, { target })
        : t('sessions.activity.working');

  return (
    <div
      className="mr-auto w-full max-w-[95%] rounded-[10px] border p-4"
      style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
    >
      <div role="status" aria-live="polite">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ProviderIcon id={provider} size={18} />
          <span className="min-w-0 flex-1">
            {t(
              phase === 'quick'
                ? 'sessions.thinkingQuick'
                : phase === undefined || phase === 'ask' || phase === 'discuss'
                  ? 'sessions.thinking'
                  : 'sessions.thinkingWork',
              { provider: PROVIDER_LABELS[provider] },
            )}
          </span>
          <span className="shrink-0 font-mono-token text-xs" style={{ color: 'var(--text-secondary)' }}>
            {seconds}s
          </span>
        </div>
        <p
          className="mt-2 flex items-center gap-2 text-xs"
          style={{ color: 'var(--text-secondary)' }}
        >
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 shrink-0 rounded-full motion-safe:animate-pulse"
            style={{ backgroundColor: 'var(--accent)' }}
          />
          <span className="min-w-0 break-words">{activityText}</span>
        </p>
      </div>

      {text && (
        <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--border-subtle)' }}>
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
