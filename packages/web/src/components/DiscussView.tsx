import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type {
  DiscussMessageDTO,
  DiscussRound,
  ProjectSummary,
  ProviderId,
  QuestionItem,
  QuickPlanMessageContent,
  SessionMode,
  SessionSummaryDTO,
} from '@dalang/shared';
import { useI18n } from '../i18n/index.js';
import { api } from '../lib/api.js';
import { ChatTranscript } from './chat/ChatTranscript.js';
import { ComposerDock } from './chat/ComposerDock.js';
import { RunningTurn, type LiveSessionState } from './chat/RunningTurn.js';
import { useChatScroll } from './chat/useChatScroll.js';
import { useComposerChoice } from './chat/useComposerChoice.js';
import { ModeComposer } from './ModeComposer.js';
import { EmptyPanel, ErrorPanel, LoadingPanel } from './StateViews.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';

interface AnswerDraft {
  selectedOptions: string[];
  customText: string;
}

export function DiscussView({
  project,
  session,
  live,
  onProviderChange,
  initialGoal,
  onConsumeInitialGoal,
  onGoToAgree,
}: {
  project: ProjectSummary;
  session: SessionSummaryDTO;
  /** What the CLI is doing for this chat, kept by the page so it survives switching chats. */
  live: LiveSessionState | undefined;
  /** Reports the CLI chosen in the composer so the page header can name it. */
  onProviderChange: (provider: ProviderId) => void;
  initialGoal?: string;
  onConsumeInitialGoal?: () => void;
  onGoToAgree: () => void;
}) {
  const qc = useQueryClient();
  const { t, formatTime } = useI18n();
  const sessionId = session.id;
  const isFinished =
    session.workState === 'idle' &&
    session.planStatus === 'approved' &&
    session.taskCount > 0 &&
    session.doneTaskCount === session.taskCount;

  const [message, setMessage] = useState(initialGoal ?? '');
  const [composerMode, setComposerMode] = useState<SessionMode>(isFinished ? 'ask' : 'full');
  // A question can be asked at any time. Quick is only offered once the work is finished.
  const activeComposerMode: SessionMode =
    composerMode === 'quick' && !isFinished ? 'full' : composerMode;
  const [answersByQid, setAnswersByQid] = useState<Record<string, AnswerDraft>>({});
  const [requestStartedAt, setRequestStartedAt] = useState(() => Date.now());
  const choice = useComposerChoice(project, session, onProviderChange);

  useEffect(() => {
    if (initialGoal) {
      setMessage(initialGoal);
      onConsumeInitialGoal?.();
    }
  }, [initialGoal, onConsumeInitialGoal]);

  const discussQuery = useQuery({
    queryKey: ['discuss', project.id, sessionId],
    queryFn: () => api.getDiscussState(project.id, sessionId),
  });

  const sendMutation = useMutation({
    mutationFn: (vars: { text: string; questions?: QuestionItem[]; mode: SessionMode }) => {
      const structuredAnswers = (vars.questions ?? []).map((q) => {
        const draft = answersByQid[q.id] ?? { selectedOptions: [], customText: '' };
        return {
          questionId: q.id,
          question: q.question,
          selectedOptions: draft.selectedOptions,
          customText: draft.customText,
        };
      });
      return api.sendChatMessage(project.id, {
        sessionId,
        mode: vars.mode,
        message: vars.text,
        answers:
          vars.mode === 'full' && structuredAnswers.length > 0 ? structuredAnswers : undefined,
        ...choice.payload,
      });
    },
    onSuccess: () => {
      setMessage('');
      setAnswersByQid({});
      qc.invalidateQueries({ queryKey: ['discuss', project.id, sessionId] });
      qc.invalidateQueries({ queryKey: ['sessions', project.id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  const finishMutation = useMutation({
    mutationFn: () => api.finishDiscuss(project.id, sessionId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['briefs', project.id] });
      qc.invalidateQueries({ queryKey: ['discuss', project.id] });
      qc.invalidateQueries({ queryKey: ['sessions', project.id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      onGoToAgree();
    },
  });

  const messages = discussQuery.data?.messages ?? [];
  const latestQuestionsMsg = [...messages].reverse().find((m) => m.type === 'questions');
  const activeRound = latestQuestionsMsg ? (latestQuestionsMsg.content as DiscussRound) : null;
  const activeQuestions = activeRound?.questions ?? [];

  const toggleOption = (q: QuestionItem, option: string) => {
    setAnswersByQid((prev) => {
      const current = prev[q.id] ?? { selectedOptions: [], customText: '' };
      if (q.kind === 'single') {
        return {
          ...prev,
          [q.id]: { ...current, selectedOptions: [option] },
        };
      }
      const exists = current.selectedOptions.includes(option);
      return {
        ...prev,
        [q.id]: {
          ...current,
          selectedOptions: exists
            ? current.selectedOptions.filter((o) => o !== option)
            : [...current.selectedOptions, option],
        },
      };
    });
  };

  const setCustomText = (qid: string, customText: string) => {
    setAnswersByQid((prev) => {
      const current = prev[qid] ?? { selectedOptions: [], customText: '' };
      return { ...prev, [qid]: { ...current, customText } };
    });
  };

  // The server knows when a turn is running, so the panel also shows after leaving the chat and coming back.
  const turnRunning = sendMutation.isPending || finishMutation.isPending || Boolean(session.turn);
  const lastReplyRef = useChatScroll(messages, turnRunning, live?.turn);

  // What a bubble holds for the messages only the guided flow writes.
  const renderBody = (msg: DiscussMessageDTO): ReactNode | null => {
    if (msg.type === 'questions') {
      const round = msg.content as DiscussRound;
      return (
        <div className="space-y-2 text-sm">
          <p className="font-medium">
            {t('discuss.roundHeading', {
              round: round.round,
              summary: round.summary || t('discuss.clarificationQuestions'),
            })}
          </p>
          <ul className="list-disc space-y-1 pl-5" style={{ color: 'var(--text-secondary)' }}>
            {round.questions.map((q) => (
              <li key={q.id}>{q.question}</li>
            ))}
          </ul>
          {round.ready_for_brief && (
            <p className="font-medium" style={{ color: 'var(--pass)' }}>
              {t('discuss.readyForBrief')}
            </p>
          )}
        </div>
      );
    }
    if (msg.type === 'brief') {
      const brief = msg.content as { version: number; title: string };
      return (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <span>
            {t('discuss.draftedBrief', { version: brief.version })} <strong>{brief.title}</strong>
          </span>
          <Button type="button" onClick={onGoToAgree} variant="outline">
            {t('discuss.openBrief')}
          </Button>
        </div>
      );
    }
    if (msg.type === 'quick_plan' && msg.content && typeof msg.content === 'object') {
      const plan = msg.content as QuickPlanMessageContent;
      return (
        <div className="space-y-2 text-sm">
          <p className="font-medium">{plan.summary}</p>
          {plan.reason && <p style={{ color: 'var(--text-secondary)' }}>{plan.reason}</p>}
          {plan.findings && plan.findings.length > 0 && (
            <ul className="list-disc space-y-1 pl-5" style={{ color: 'var(--text-secondary)' }}>
              {plan.findings.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          )}
        </div>
      );
    }
    return null;
  };

  const hasAnswers = Object.values(answersByQid).some(
    (a) => a.selectedOptions.length > 0 || a.customText.trim().length > 0,
  );

  const handleComposerSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = message.trim();
    if (!trimmed && !hasAnswers) return;
    setRequestStartedAt(Date.now());
    sendMutation.mutate({
      text: trimmed || t('discuss.defaultAnswersText'),
      questions: activeQuestions.length > 0 ? activeQuestions : undefined,
      mode: activeComposerMode,
    });
  };

  return (
    <div className="flex flex-1 flex-col gap-5">
      {/* Stage header + Lead selector */}
      <div
        className="flex flex-wrap items-end justify-between gap-4 rounded-[8px] border p-4"
        style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
      >
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">{t('discuss.title')}</h2>
            {discussQuery.data?.session?.cliSessionId && (
              <Badge title={discussQuery.data.session.cliSessionId}>
                session: {discussQuery.data.session.cliSessionId.slice(0, 10)}
              </Badge>
            )}
            {discussQuery.data && discussQuery.data.currentRound > 0 && (
              <Badge>ROUND {discussQuery.data.currentRound}</Badge>
            )}
          </div>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
            {t('discuss.subtitle')}
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <Button
            type="button"
            onClick={() => finishMutation.mutate()}
            disabled={finishMutation.isPending || sendMutation.isPending}
          >
            {finishMutation.isPending ? t('discuss.writingBrief') : t('discuss.writeBrief')}
          </Button>
        </div>
      </div>

      {discussQuery.isLoading && <LoadingPanel label={t('discuss.loading')} />}
      {discussQuery.isError && (
        <ErrorPanel
          title={t('discuss.loadError')}
          detail={discussQuery.error.message}
          onRetry={() => discussQuery.refetch()}
        />
      )}

      {!discussQuery.isLoading && !discussQuery.isError && (
        <div className="grid flex-1 grid-cols-1 gap-6 lg:grid-cols-12">
          {/* Conversation stream */}
          <section aria-label={t('discuss.title')} className="flex flex-col gap-4 lg:col-span-7">
            {messages.length === 0 ? (
              <EmptyPanel title={t('discuss.emptyTitle')} description={t('discuss.emptyDesc')} />
            ) : (
              <ChatTranscript
                messages={messages}
                session={session}
                lastReplyRef={lastReplyRef}
                renderBody={renderBody}
              />
            )}

            {turnRunning && (
              <RunningTurn
                project={project}
                session={session}
                messages={messages}
                pendingMessage={sendMutation.isPending ? sendMutation.variables?.text : undefined}
                fallbackProvider={choice.provider}
                requestStartedAt={requestStartedAt}
                live={live}
              />
            )}

            {(sendMutation.isError || finishMutation.isError) && (
              <ErrorPanel
                title={t('discuss.turnFailed')}
                detail={
                  sendMutation.error?.message ||
                  finishMutation.error?.message ||
                  'Unknown CLI error'
                }
              />
            )}

            <div className="mt-auto">
            <ComposerDock bleed={false}>
              <ModeComposer
                id="discuss-composer"
                modelPicker={choice.picker}
                session={session}
                selectedMode={activeComposerMode}
                onSelectMode={setComposerMode}
                value={message}
                onChange={setMessage}
                onSubmit={handleComposerSubmit}
                busy={turnRunning}
                canSubmitEmpty={hasAnswers}
                isFinishedSession={isFinished}
                label={
                  activeQuestions.length > 0
                    ? t('discuss.composerWithQuestions')
                    : t('discuss.composerDefault')
                }
                submitLabel={
                  sendMutation.isPending
                    ? t('discuss.sending')
                    : activeComposerMode === 'ask'
                      ? t('sessions.sendAsk')
                      : activeQuestions.length > 0
                        ? t('discuss.submitAnswers')
                        : t('discuss.sendToLead')
                }
              />
            </ComposerDock>
            </div>
          </section>

          {/* Structured Question Deck */}
          <aside aria-label={t('discuss.questionDeck')} className="space-y-4 lg:col-span-5">
            <h3 className="text-base font-semibold">{t('discuss.questionDeck')}</h3>
            {activeQuestions.length === 0 ? (
              <EmptyPanel
                title={t('discuss.noPendingTitle')}
                description={t('discuss.noPendingDesc')}
              />
            ) : (
              <div className="space-y-3">
                {activeQuestions.map((q, idx) => {
                  const draft = answersByQid[q.id] ?? { selectedOptions: [], customText: '' };
                  return (
                    <fieldset
                      key={q.id}
                      className="rounded-[6px] border p-4"
                      style={{
                        backgroundColor: 'var(--bg-surface)',
                        borderColor: 'var(--border-subtle)',
                      }}
                    >
                      <legend className="px-1 text-sm font-semibold">
                        Q{idx + 1}. {q.question}
                      </legend>
                      <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {t('discuss.whyItMatters', { reason: q.reason })}
                      </p>

                      {q.options.length > 0 && (
                        <div className="mt-3 space-y-2">
                          {q.options.map((opt) => {
                            const checked = draft.selectedOptions.includes(opt);
                            return (
                              <Label
                                key={opt}
                                className="flex min-h-[44px] cursor-pointer items-center gap-3 rounded border px-3 py-2 text-sm"
                                style={{
                                  borderColor: checked ? 'var(--accent)' : 'var(--border-subtle)',
                                  backgroundColor: checked ? 'var(--accent-tint)' : 'transparent',
                                }}
                              >
                                <input
                                  type={q.kind === 'multi' ? 'checkbox' : 'radio'}
                                  name={`question-${q.id}`}
                                  checked={checked}
                                  onChange={() => toggleOption(q, opt)}
                                  className="h-4 w-4 shrink-0"
                                />
                                <span>{opt}</span>
                              </Label>
                            );
                          })}
                        </div>
                      )}

                      {(q.allow_custom || q.kind === 'text' || q.options.length === 0) && (
                        <div className="mt-3">
                          <Label
                            htmlFor={`q-custom-${q.id}`}
                            className="block text-xs font-medium"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            {t('discuss.customAnswer')}
                          </Label>
                          <Input
                            id={`q-custom-${q.id}`}
                            type="text"
                            value={draft.customText}
                            onChange={(e) => setCustomText(q.id, e.target.value)}
                            placeholder={t('discuss.customPlaceholder')}
                            className="mt-1 text-sm"
                          />
                        </div>
                      )}
                    </fieldset>
                  );
                })}
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
