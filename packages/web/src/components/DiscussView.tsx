import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { DiscussRound, ProjectSummary, ProviderId, QuestionItem } from '@dalang/shared';
import { useI18n } from '../i18n/index.js';
import { api } from '../lib/api.js';
import { EmptyPanel, ErrorPanel, LoadingPanel } from './StateViews.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';

interface AnswerDraft {
  selectedOptions: string[];
  customText: string;
}

export function DiscussView({
  project,
  liveLogs,
  initialGoal,
  onConsumeInitialGoal,
  onGoToAgree,
}: {
  project: ProjectSummary;
  liveLogs: string[];
  initialGoal?: string;
  onConsumeInitialGoal?: () => void;
  onGoToAgree: () => void;
}) {
  const qc = useQueryClient();
  const { t, formatTime } = useI18n();
  const [message, setMessage] = useState(initialGoal ?? '');
  const [answersByQid, setAnswersByQid] = useState<Record<string, AnswerDraft>>({});
  const [leadProvider, setLeadProvider] = useState<ProviderId>(project.leadProvider);
  const [leadModel, setLeadModel] = useState(project.leadModel ?? '');

  useEffect(() => {
    if (initialGoal) {
      setMessage(initialGoal);
      onConsumeInitialGoal?.();
    }
  }, [initialGoal, onConsumeInitialGoal]);

  const discussQuery = useQuery({
    queryKey: ['discuss', project.id],
    queryFn: () => api.getDiscussState(project.id),
  });

  const providersQuery = useQuery({
    queryKey: ['providers-status'],
    queryFn: () => api.getProvidersStatus(),
  });

  const settingsMutation = useMutation({
    mutationFn: (vars: { leadProvider: ProviderId; leadModel: string | null }) =>
      api.updateProjectSettings(project.id, vars),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  const sendMutation = useMutation({
    mutationFn: (vars: { text: string; questions?: QuestionItem[] }) => {
      const structuredAnswers = (vars.questions ?? []).map((q) => {
        const draft = answersByQid[q.id] ?? { selectedOptions: [], customText: '' };
        return {
          questionId: q.id,
          question: q.question,
          selectedOptions: draft.selectedOptions,
          customText: draft.customText,
        };
      });
      return api.sendDiscussMessage(project.id, {
        message: vars.text,
        answers: structuredAnswers.length > 0 ? structuredAnswers : undefined,
        provider: leadProvider,
        model: leadModel.trim() || undefined,
      });
    },
    onSuccess: () => {
      setMessage('');
      setAnswersByQid({});
      qc.invalidateQueries({ queryKey: ['discuss', project.id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  const finishMutation = useMutation({
    mutationFn: () => api.finishDiscuss(project.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['briefs', project.id] });
      qc.invalidateQueries({ queryKey: ['discuss', project.id] });
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

  const handleComposerSubmit = (e: FormEvent) => {
    e.preventDefault();
    const hasAnswers = Object.values(answersByQid).some(
      (a) => a.selectedOptions.length > 0 || a.customText.trim().length > 0,
    );
    const trimmed = message.trim();
    if (!trimmed && !hasAnswers) return;
    sendMutation.mutate({
      text: trimmed || t('discuss.defaultAnswersText'),
      questions: activeQuestions.length > 0 ? activeQuestions : undefined,
    });
  };

  const handleTextareaKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (e.nativeEvent.isComposing || e.keyCode === 229) {
        return;
      }
      e.currentTarget.form?.requestSubmit();
    }
  };

  const activeProviderModels =
    providersQuery.data?.providers.find((p) => p.id === leadProvider)?.models ?? [];

  return (
    <div className="space-y-5">
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
          <div>
            <Label htmlFor="discuss-provider" className="block text-xs font-medium">
              {t('discuss.leadCli')}
            </Label>
            <NativeSelect
              id="discuss-provider"
              value={leadProvider}
              onChange={(e) => {
                const next = e.target.value as ProviderId;
                setLeadProvider(next);
                settingsMutation.mutate({ leadProvider: next, leadModel: leadModel.trim() || null });
              }}
              className="mt-1"
            >
              <option value="claude-code">Claude Code</option>
              <option value="codex">Codex CLI</option>
              <option value="antigravity">Antigravity CLI</option>
            </NativeSelect>
          </div>

          <div>
            <Label htmlFor="discuss-model" className="block text-xs font-medium">
              {t('discuss.modelOptional')}
            </Label>
            <Input
              id="discuss-model"
              type="text"
              list="lead-model-suggestions"
              value={leadModel}
              onChange={(e) => setLeadModel(e.target.value)}
              onBlur={() =>
                settingsMutation.mutate({ leadProvider, leadModel: leadModel.trim() || null })
              }
              placeholder={t('common.cliDefault')}
              className="mt-1 font-mono-token text-sm"
            />
            <datalist id="lead-model-suggestions">
              {activeProviderModels.map((m) => (
                <option key={m.id} value={m.value}>
                  {m.displayName}
                </option>
              ))}
            </datalist>
          </div>

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
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* Conversation stream */}
          <section aria-label={t('discuss.title')} className="space-y-4 lg:col-span-7">
            {messages.length === 0 ? (
              <EmptyPanel title={t('discuss.emptyTitle')} description={t('discuss.emptyDesc')} />
            ) : (
              <div className="space-y-3">
                {messages.map((msg) => {
                  const isUser = msg.role === 'user';
                  const isError = msg.type === 'error';
                  return (
                    <article
                      key={msg.id}
                      className="rounded-[6px] border p-4"
                      style={{
                        backgroundColor: isError
                          ? 'var(--error-tint)'
                          : isUser
                            ? 'var(--bg-well)'
                            : 'var(--bg-surface)',
                        borderColor: isError ? 'var(--error)' : 'var(--border-subtle)',
                      }}
                    >
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-semibold uppercase tracking-wide">
                          {msg.role === 'user'
                            ? t('discuss.roleUser')
                            : msg.role === 'lead'
                              ? t('discuss.roleLead')
                              : t('discuss.roleSystem')}
                        </span>
                        <span style={{ color: 'var(--text-secondary)' }}>
                          {formatTime(msg.createdAt)}
                        </span>
                      </div>

                      {msg.type === 'questions' ? (
                        <div className="mt-2 space-y-2 text-sm">
                          <p className="font-medium">
                            {t('discuss.roundHeading', {
                              round: (msg.content as DiscussRound).round,
                              summary:
                                (msg.content as DiscussRound).summary ||
                                t('discuss.clarificationQuestions'),
                            })}
                          </p>
                          <ul
                            className="list-disc space-y-1 pl-5"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            {(msg.content as DiscussRound).questions.map((q) => (
                              <li key={q.id}>{q.question}</li>
                            ))}
                          </ul>
                          {(msg.content as DiscussRound).ready_for_brief && (
                            <p className="font-medium" style={{ color: 'var(--pass)' }}>
                              {t('discuss.readyForBrief')}
                            </p>
                          )}
                        </div>
                      ) : msg.type === 'brief' ? (
                        <div className="mt-2 flex flex-wrap items-center justify-between gap-3 text-sm">
                          <span>
                            {t('discuss.draftedBrief', {
                              version: (msg.content as { version: number; title: string }).version,
                            })}{' '}
                            <strong>{(msg.content as { version: number; title: string }).title}</strong>
                          </span>
                          <Button type="button" onClick={onGoToAgree} variant="outline">
                            {t('discuss.openBrief')}
                          </Button>
                        </div>
                      ) : (
                        <p className="mt-2 whitespace-pre-wrap text-sm">
                          {typeof msg.content === 'string'
                            ? msg.content
                            : JSON.stringify(msg.content, null, 2)}
                        </p>
                      )}
                    </article>
                  );
                })}
              </div>
            )}

            {(sendMutation.isPending || finishMutation.isPending) && (
              <div
                role="status"
                aria-live="polite"
                className="rounded-[6px] border p-4"
                style={{ backgroundColor: 'var(--bg-well)', borderColor: 'var(--border-control)' }}
              >
                <p className="text-sm font-medium">
                  {t('discuss.leadRunning', { provider: leadProvider })}
                </p>
                {liveLogs.length > 0 && (
                  <pre
                    className="mt-2 max-h-28 overflow-y-auto font-mono-token text-xs"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {liveLogs.slice(-6).join('\n')}
                  </pre>
                )}
              </div>
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

            <form
              onSubmit={handleComposerSubmit}
              className="rounded-[6px] border p-4"
              style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
            >
              <Label htmlFor="discuss-composer" className="block text-sm font-medium">
                {activeQuestions.length > 0
                  ? t('discuss.composerWithQuestions')
                  : t('discuss.composerDefault')}
              </Label>
              <Textarea
                id="discuss-composer"
                rows={3}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={handleTextareaKeyDown}
                placeholder={t('discuss.composerPlaceholder')}
                className="mt-2"
              />
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {t('discuss.enterHint')}
                </span>
                <Button
                  type="submit"
                  disabled={sendMutation.isPending || finishMutation.isPending}
                >
                  {sendMutation.isPending
                    ? t('discuss.sending')
                    : activeQuestions.length > 0
                      ? t('discuss.submitAnswers')
                      : t('discuss.sendToLead')}
                </Button>
              </div>
            </form>
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
