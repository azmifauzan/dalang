import type { DiscussMessageDTO, ProjectSummary, ProviderId, SessionSummaryDTO } from '@dalang/shared';
import { useI18n } from '../../i18n/index.js';
import { EMPTY_LIVE_TURN, type LiveTurn } from '../../lib/liveTurn.js';
import { LiveTurnPanel } from '../LiveTurnPanel.js';

export interface LiveSessionState {
  logs: string[];
  turn: LiveTurn;
}

/**
 * What to show while the Lead works: the question at once, then the live panel.
 * `running` should come from the server's session turn as well as from this page's own request, so the
 * panel is still there after leaving the chat and coming back.
 */
export function RunningTurn({
  project,
  session,
  messages,
  pendingMessage,
  fallbackProvider,
  requestStartedAt,
  live,
}: {
  project: ProjectSummary;
  session: SessionSummaryDTO | null;
  messages: DiscussMessageDTO[];
  /** The text this page just sent, shown until the server lists it. */
  pendingMessage?: string;
  fallbackProvider: ProviderId;
  requestStartedAt: number;
  live: LiveSessionState | undefined;
}) {
  const { t } = useI18n();
  const last = messages.length > 0 ? messages[messages.length - 1] : null;
  const showQuestion = Boolean(pendingMessage) && !(last?.role === 'user' && last.content === pendingMessage);

  return (
    <>
      {showQuestion && (
        <article
          className="ml-auto w-full max-w-[85%] rounded-[10px] border p-4"
          style={{ backgroundColor: 'var(--bg-well)', borderColor: 'var(--border-subtle)' }}
        >
          <div className="text-xs font-semibold uppercase tracking-wide">{t('discuss.roleUser')}</div>
          <p className="mt-2 whitespace-pre-wrap text-sm">{pendingMessage}</p>
        </article>
      )}
      <LiveTurnPanel
        provider={session?.turn?.provider ?? fallbackProvider}
        phase={session?.turn?.phase}
        liveTurn={live?.turn ?? EMPTY_LIVE_TURN}
        liveLogs={live?.logs ?? []}
        projectPath={project.path}
        startedAt={session?.turn ? Date.parse(session.turn.startedAt) : requestStartedAt}
      />
    </>
  );
}
