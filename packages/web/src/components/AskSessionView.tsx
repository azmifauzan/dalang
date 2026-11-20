import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChatImage, ProjectSummary, ProviderId, SessionMode, SessionSummaryDTO } from '@dalang/shared';
import { useI18n } from '../i18n/index.js';
import { api } from '../lib/api.js';
import { ChatTranscript } from './chat/ChatTranscript.js';
import { ComposerDock } from './chat/ComposerDock.js';
import { RunningTurn, type LiveSessionState } from './chat/RunningTurn.js';
import { useChatScroll } from './chat/useChatScroll.js';
import { useComposerChoice } from './chat/useComposerChoice.js';
import { ModeComposer } from './ModeComposer.js';
import { ErrorPanel, LoadingPanel } from './StateViews.js';

export interface AskSessionViewProps {
  project: ProjectSummary;
  session: SessionSummaryDTO | null;
  draftMode: SessionMode;
  onChangeDraftMode: (mode: SessionMode) => void;
  /** What the CLI is doing for this chat, kept by the page so it survives switching chats. */
  live: LiveSessionState | undefined;
  /** Reports the CLI chosen in the composer so the page header can name it. */
  onProviderChange: (provider: ProviderId) => void;
  initialPrompt?: string;
  onConsumeInitialPrompt?: () => void;
  onSessionCreatedOrUpdated: (session: SessionSummaryDTO) => void;
  onPromoteSession: (sessionId: string, mode: SessionMode) => void;
}

export function AskSessionView({
  project,
  session,
  draftMode,
  onChangeDraftMode,
  live,
  onProviderChange,
  initialPrompt,
  onConsumeInitialPrompt,
  onSessionCreatedOrUpdated,
  onPromoteSession,
}: AskSessionViewProps) {
  const qc = useQueryClient();
  const { t } = useI18n();
  const [input, setInput] = useState(initialPrompt ?? '');
  const [images, setImages] = useState<ChatImage[]>([]);
  const [requestStartedAt, setRequestStartedAt] = useState(() => Date.now());
  const choice = useComposerChoice(project, session, onProviderChange);

  useEffect(() => {
    if (initialPrompt) {
      setInput(initialPrompt);
      onConsumeInitialPrompt?.();
    }
  }, [initialPrompt, onConsumeInitialPrompt]);

  const discussQuery = useQuery({
    queryKey: ['discuss', project.id, session?.id ?? 'new'],
    queryFn: () => api.getDiscussState(project.id, session!.id),
    enabled: Boolean(session),
  });

  const sendMutation = useMutation({
    mutationFn: (vars: { message: string; mode: SessionMode; images: ChatImage[] }) =>
      api.sendChatMessage(project.id, {
        sessionId: session?.id,
        mode: vars.mode,
        message: vars.message,
        images: vars.images,
        ...choice.payload,
      }),
    onSuccess: (res) => {
      setInput('');
      setImages([]);
      qc.invalidateQueries({ queryKey: ['sessions', project.id] });
      qc.invalidateQueries({ queryKey: ['discuss', project.id, res.session.id] });
      qc.invalidateQueries({ queryKey: ['plan', project.id, res.session.id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      onSessionCreatedOrUpdated(res.session);
    },
  });

  // Picking a mode only decides what the next message does. The session moves up when that message is sent,
  // so looking at Quick or Full changes nothing until you send.
  const [chosenMode, setChosenMode] = useState<SessionMode>('ask');
  const selectedMode = session ? chosenMode : draftMode;
  const handleSelectMode = (nextMode: SessionMode) => {
    if (session) setChosenMode(nextMode);
    else onChangeDraftMode(nextMode);
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed && !images.length) return;
    setRequestStartedAt(Date.now());
    sendMutation.mutate({
      message: trimmed,
      mode: selectedMode,
      images,
    });
  };

  const messages = session ? (discussQuery.data?.messages ?? []) : [];
  const otherWorkingTitle =
    project.workingSessionId && project.workingSessionId !== session?.id
      ? project.workingSessionTitle ?? t('sessions.workingDotLabel')
      : null;

  const emptyKind = selectedMode;

  // The server knows when a turn is running, so the panel also shows after leaving the chat and coming back.
  const turnRunning = sendMutation.isPending || Boolean(session?.turn);
  const isEmpty = messages.length === 0 && !turnRunning && !sendMutation.isError;
  const lastReplyRef = useChatScroll(messages, turnRunning, live?.turn);

  const composer = (
    <ModeComposer
      modelPicker={choice.picker}
      session={session}
      selectedMode={selectedMode}
      onSelectMode={handleSelectMode}
      value={input}
      onChange={setInput}
      onSubmit={handleSubmit}
      images={images}
      onImagesChange={setImages}
      busy={turnRunning}
      otherWorkingSessionTitle={otherWorkingTitle}
    />
  );

  return (
    <div className="contents">
      {session && discussQuery.isLoading && <LoadingPanel label={t('discuss.loading')} />}
      {session && discussQuery.isError && (
        <ErrorPanel
          title={t('discuss.loadError')}
          detail={(discussQuery.error as Error).message}
          onRetry={() => discussQuery.refetch()}
        />
      )}

      {(!session || (!discussQuery.isLoading && !discussQuery.isError)) &&
        (isEmpty ? (
          // Empty chat: a heading with the composer in the middle, like T3 Code.
          <div className="flex flex-1 flex-col items-center justify-center gap-6 py-6">
            <div className="text-center">
              <h2 className="text-2xl font-semibold sm:text-3xl">
                {t(`sessions.${emptyKind}EmptyTitle`)}
              </h2>
              <p className="mx-auto mt-2 max-w-xl text-sm" style={{ color: 'var(--text-secondary)' }}>
                {t(`sessions.${emptyKind}EmptyDesc`)}
              </p>
            </div>
            <div className="w-full max-w-4xl">
              <ComposerDock bleed={false}>{composer}</ComposerDock>
            </div>
          </div>
        ) : (
          <>
            <section
              aria-label={t('sessions.mode.ask')}
              className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-3"
            >
              <ChatTranscript
                messages={messages}
                session={session}
                lastReplyRef={lastReplyRef}
                onPromote={session ? (mode) => onPromoteSession(session.id, mode) : undefined}
              />

              {turnRunning && (
                <RunningTurn
                  project={project}
                  session={session}
                  messages={messages}
                  pendingMessage={sendMutation.isPending ? sendMutation.variables?.message : undefined}
                  fallbackProvider={choice.provider}
                  requestStartedAt={requestStartedAt}
                  live={live}
                />
              )}

              {sendMutation.isError && (
                <ErrorPanel
                  title={t('discuss.turnFailed')}
                  detail={(sendMutation.error as Error).message}
                />
              )}
            </section>
            {/* A sibling of the message list, not a child: sticky is then bounded by the whole page column. */}
            <ComposerDock>{composer}</ComposerDock>
          </>
        ))}
    </div>
  );
}
