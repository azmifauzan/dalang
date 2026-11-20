import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ChatImage,
  DiscussMessageDTO,
  ProjectSummary,
  ProviderId,
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
import { QuickTimeline } from './QuickTimeline.js';
import { ErrorPanel, LoadingPanel } from './StateViews.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

function diffLineClasses(line: string): string {
  if (line.startsWith('@@')) {
    return 'bg-[#fdeee6] text-[#9a3412] dark:bg-[#3b2416] dark:text-[#f08c4b] font-semibold';
  }
  if (line.startsWith('+') && !line.startsWith('+++')) {
    return 'bg-[#dcfce7] text-[#1c1917] dark:bg-[#143321] dark:text-[#efece6]';
  }
  if (line.startsWith('-') && !line.startsWith('---')) {
    return 'bg-[#fee2e2] text-[#1c1917] dark:bg-[#3b1919] dark:text-[#efece6]';
  }
  return 'text-foreground';
}

export interface QuickSessionViewProps {
  project: ProjectSummary;
  session: SessionSummaryDTO;
  /** What the CLI is doing for this chat, kept by the page so it survives switching chats. */
  live: LiveSessionState | undefined;
  liveLogsByRunId: Record<string, string[]>;
  /** Reports the CLI chosen in the composer so the page header can name it. */
  onProviderChange: (provider: ProviderId) => void;
  onSessionUpdated: (session: SessionSummaryDTO) => void;
  onPromoteToFull: () => void;
}

export function QuickSessionView({
  project,
  session,
  live,
  liveLogsByRunId,
  onProviderChange,
  onSessionUpdated,
  onPromoteToFull,
}: QuickSessionViewProps) {
  const qc = useQueryClient();
  const { t, te, formatTime } = useI18n();

  const [input, setInput] = useState('');
  const [allowUnconfined, setAllowUnconfined] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [showRejectBox, setShowRejectBox] = useState(false);
  const [rejectNote, setRejectNote] = useState('');
  const [rejectRequeue, setRejectRequeue] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [requestStartedAt, setRequestStartedAt] = useState(() => Date.now());
  const choice = useComposerChoice(project, session, onProviderChange);

  const detailQuery = useQuery({
    queryKey: ['session-detail', project.id, session.id],
    queryFn: () => api.getSessionDetail(project.id, session.id),
  });

  const plan = detailQuery.data?.plan ?? null;
  const quickTask = plan?.tasks[0] ?? null;
  const isFinished =
    session.workState === 'idle' &&
    Boolean(quickTask && quickTask.status === 'done');

  const [composerMode, setComposerMode] = useState<SessionMode>(isFinished ? 'ask' : 'quick');
  const activeComposerMode: SessionMode = composerMode;

  const executionQuery = useQuery({
    queryKey: ['execution', project.id, session.id],
    queryFn: () => api.getExecutionState(project.id, session.id),
    enabled: Boolean(plan),
    refetchInterval: (query) => {
      const ex = query.state.data?.execution;
      if (!ex) return false;
      const busy =
        (ex.activeRuns?.length ?? 0) > 0 ||
        Boolean(ex.activeRun) ||
        ex.queueRunning ||
        quickTask?.status === 'running' ||
        quickTask?.status === 'reviewing';
      return busy ? 1500 : false;
    },
  });

  const guardQuery = useQuery({
    queryKey: ['guard', project.id, session.id],
    queryFn: () => api.getGuardState(project.id, session.id),
    enabled: Boolean(
      quickTask &&
        (quickTask.status === 'awaiting_merge' ||
          quickTask.status === 'review_failed' ||
          quickTask.status === 'reviewing' ||
          quickTask.status === 'done'),
    ),
  });

  const diffQuery = useQuery({
    queryKey: ['task-diff', project.id, quickTask?.id],
    queryFn: () => api.getTaskDiff(project.id, quickTask!.id),
    enabled: Boolean(showDiff && quickTask),
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['session-detail', project.id, session.id] });
    qc.invalidateQueries({ queryKey: ['discuss', project.id, session.id] });
    qc.invalidateQueries({ queryKey: ['plan', project.id, session.id] });
    qc.invalidateQueries({ queryKey: ['execution', project.id, session.id] });
    qc.invalidateQueries({ queryKey: ['guard', project.id, session.id] });
    qc.invalidateQueries({ queryKey: ['sessions', project.id] });
    qc.invalidateQueries({ queryKey: ['projects'] });
  };

  const [images, setImages] = useState<ChatImage[]>([]);
  const sendMutation = useMutation({
    mutationFn: (vars: { message: string; mode: SessionMode; images: ChatImage[] }) =>
      api.sendChatMessage(project.id, {
        sessionId: session.id,
        mode: vars.mode,
        message: vars.message,
        images: vars.images,
        ...choice.payload,
      }),
    onMutate: () => setActionError(null),
    onSuccess: (res) => {
      setInput('');
      setImages([]);
      invalidateAll();
      onSessionUpdated(res.session);
    },
    onError: (err) => setActionError((err as Error).message),
  });

  const runQuickMutation = useMutation({
    mutationFn: () => api.runQuickSession(project.id, session.id, { allowUnconfined }),
    onMutate: () => setActionError(null),
    onSuccess: (res) => {
      invalidateAll();
      onSessionUpdated(res.session);
    },
    onError: (err) => setActionError((err as Error).message),
  });

  const stopMutation = useMutation({
    mutationFn: () => api.stopExecution(project.id, { sessionId: session.id }),
    onSuccess: invalidateAll,
    onError: (err) => setActionError((err as Error).message),
  });

  const retryMutation = useMutation({
    mutationFn: () =>
      api.runTask(project.id, quickTask!.id, { allowUnconfined }),
    onMutate: () => setActionError(null),
    onSuccess: invalidateAll,
    onError: (err) => setActionError((err as Error).message),
  });

  const approveMergeMutation = useMutation({
    mutationFn: (allowFailedReview: boolean) =>
      api.approveMergeTask(project.id, quickTask!.id, {
        runIntegration: true,
        allowFailedReview,
      }),
    onMutate: () => setActionError(null),
    onSuccess: () => {
      setShowDiff(false);
      invalidateAll();
    },
    onError: (err) => setActionError((err as Error).message),
  });

  const rejectMutation = useMutation({
    mutationFn: () =>
      api.rejectTask(project.id, quickTask!.id, {
        note: rejectNote,
        requeue: rejectRequeue,
      }),
    onMutate: () => setActionError(null),
    onSuccess: () => {
      setShowRejectBox(false);
      setRejectNote('');
      invalidateAll();
    },
    onError: (err) => setActionError((err as Error).message),
  });

  const messages = detailQuery.data?.messages ?? [];
  // The server knows when a turn is running, so the panel also shows after leaving the chat and coming back.
  const turnRunning = sendMutation.isPending || Boolean(session.turn);
  const lastReplyRef = useChatScroll(messages, turnRunning, live?.turn);
  const execution = executionQuery.data?.execution ?? null;
  const guardEntry = guardQuery.data?.guard.tasks.find((e) => e.task.id === quickTask?.id) ?? null;
  const activeRun = execution?.activeRuns?.[0] ?? execution?.activeRun ?? null;
  const liveRunLines = activeRun ? (liveLogsByRunId[activeRun.id] ?? []) : [];
  const otherWorkingTitle =
    project.workingSessionId && project.workingSessionId !== session.id
      ? project.workingSessionTitle ?? t('sessions.workingDotLabel')
      : null;

  const renderQuickCard = (msg: DiscussMessageDTO): ReactNode | null => {
    if (!(msg.type === 'quick_plan' && msg.content && typeof msg.content === 'object')) return null;
        const qp = msg.content as QuickPlanMessageContent;
        const isLatestPlanCard = Boolean(qp.planId && plan && qp.planId === plan.id);
        const canRunThisCard = Boolean(
          qp.verdict === 'ready' && isLatestPlanCard && plan?.status === 'draft',
        );

        return (
          <article
            data-quick-verdict={qp.verdict}
            className="rounded-[8px] border p-4 space-y-3"
            style={{
              backgroundColor: 'var(--bg-surface)',
              borderColor: qp.verdict === 'too_large' ? 'var(--accent)' : 'var(--border-control)',
            }}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  style={{
                    borderColor: 'var(--accent)',
                    color: 'var(--accent)',
                    backgroundColor: 'var(--accent-tint)',
                  }}
                >
                  {qp.verdict === 'ready'
                    ? t('sessions.quick.miniPlanTitle')
                    : t('sessions.quick.tooLargeTitle')}
                </Badge>
                {qp.task && (
                  <Badge>{qp.task.id}</Badge>
                )}
              </div>
              <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {formatTime(msg.createdAt)}
              </span>
            </div>

            <p className="text-sm font-medium">{qp.summary}</p>

            {qp.verdict === 'too_large' ? (
              <div className="space-y-3">
                {qp.reason && (
                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    {qp.reason}
                  </p>
                )}
                {qp.findings && qp.findings.length > 0 && (
                  <ul
                    className="list-disc space-y-1 pl-5 text-sm"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {qp.findings.map((f, idx) => (
                      <li key={idx}>{f}</li>
                    ))}
                  </ul>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button type="button" onClick={onPromoteToFull}>
                    {t('sessions.quick.tooLargeCta')}
                  </Button>
                </div>
              </div>
            ) : (
              qp.task && (
                <div className="space-y-3">
                  <div
                    className="rounded-[6px] border p-3 space-y-2 text-sm"
                    style={{
                      backgroundColor: 'var(--bg-well)',
                      borderColor: 'var(--border-subtle)',
                    }}
                  >
                    <div className="font-semibold">{qp.task.title}</div>
                    <p style={{ color: 'var(--text-secondary)' }}>{qp.task.goal}</p>

                    {qp.task.files_allowed.length > 0 && (
                      <div>
                        <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
                          {t('sessions.quick.filesAllowed')}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {qp.task.files_allowed.map((f) => (
                            <code
                              key={f}
                              className="rounded-[4px] border px-2 py-0.5 font-mono-token text-xs"
                              style={{
                                backgroundColor: 'var(--bg-surface)',
                                borderColor: 'var(--border-subtle)',
                              }}
                            >
                              {f}
                            </code>
                          ))}
                        </div>
                      </div>
                    )}

                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
                        {t('sessions.quick.acceptance')}
                      </div>
                      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
                        {qp.task.acceptance_criteria.map((c, idx) => (
                          <li key={idx}>{c}</li>
                        ))}
                      </ul>
                    </div>

                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
                        {t('sessions.quick.verifyCmd')}
                      </div>
                      <code className="mt-0.5 block font-mono-token text-xs">
                        {qp.task.verify}
                      </code>
                    </div>
                  </div>

                  {canRunThisCard && (
                    <div className="space-y-2">
                      {execution && !execution.sandboxReady && (
                        <Label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-xs">
                          <input
                            type="checkbox"
                            checked={allowUnconfined}
                            onChange={(e) => setAllowUnconfined(e.target.checked)}
                            className="h-4 w-4"
                          />
                          <span>{t('sessions.quick.allowUnconfined')}</span>
                        </Label>
                      )}
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          disabled={runQuickMutation.isPending || Boolean(otherWorkingTitle)}
                          onClick={() => runQuickMutation.mutate()}
                        >
                          {runQuickMutation.isPending
                            ? t('sessions.quick.runningButton')
                            : t('sessions.quick.runButton')}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={onPromoteToFull}
                        >
                          {t('sessions.quick.switchToFull')}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )
            )}
          </article>
        );
  };

  // Picking a mode only decides what the next message does. The session moves up when that message is sent.
  const handleSelectComposerMode = (mode: SessionMode) => setComposerMode(mode);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed && !images.length) return;
    setRequestStartedAt(Date.now());
    sendMutation.mutate({ message: trimmed, mode: activeComposerMode, images });
  };

  return (
    <div className="flex flex-1 flex-col gap-4">
      <QuickTimeline
        hasPlan={Boolean(plan)}
        planApproved={plan?.status === 'approved'}
        taskStatus={quickTask?.status ?? null}
      />

      {detailQuery.isLoading && <LoadingPanel label={t('discuss.loading')} />}
      {detailQuery.isError && (
        <ErrorPanel
          title={t('discuss.loadError')}
          detail={(detailQuery.error as Error).message}
          onRetry={() => detailQuery.refetch()}
        />
      )}

      {!detailQuery.isLoading && !detailQuery.isError && (
        <>
          {/* Conversation & Mini-plan cards */}
          <section aria-label={t('sessions.mode.quick')}>
            <ChatTranscript
              messages={messages}
              session={session}
              lastReplyRef={lastReplyRef}
              onPromote={undefined}
              renderCard={renderQuickCard}
            />
          </section>

          {/* Inline Execution, Review & Merge Panel (all in one screen!) */}
          {quickTask && plan?.status === 'approved' && (
            <section
              aria-label={t('sessions.quick.workCardTitle')}
              className="rounded-[8px] border p-4 space-y-4"
              style={{
                backgroundColor: 'var(--bg-surface)',
                borderColor:
                  quickTask.status === 'done'
                    ? 'var(--pass)'
                    : quickTask.status === 'awaiting_merge'
                      ? 'var(--accent)'
                      : quickTask.status === 'failed' || quickTask.status === 'review_failed'
                        ? 'var(--error)'
                        : 'var(--border-control)',
              }}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-semibold">
                    {quickTask.status === 'awaiting_merge' || quickTask.status === 'review_failed'
                      ? t('sessions.quick.reviewCardTitle')
                      : t('sessions.quick.workCardTitle')}
                  </h3>
                  <Badge>{quickTask.externalId}</Badge>
                  <Badge>{te(quickTask.status)}</Badge>
                </div>

                {(quickTask.status === 'running' || quickTask.status === 'reviewing') && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={stopMutation.isPending}
                    onClick={() => stopMutation.mutate()}
                  >
                    {t('sessions.quick.stopRun')}
                  </Button>
                )}

                {(quickTask.status === 'failed' || quickTask.status === 'stopped') && (
                  <Button
                    type="button"
                    disabled={retryMutation.isPending}
                    onClick={() => retryMutation.mutate()}
                  >
                    {t('sessions.quick.retryRun')}
                  </Button>
                )}
              </div>

              {quickTask.rejectionNote && (
                <p className="text-sm" style={{ color: 'var(--error)' }}>
                  {quickTask.rejectionNote}
                </p>
              )}

              {/* Live output while running/reviewing */}
              {(quickTask.status === 'running' || quickTask.status === 'reviewing') &&
                liveRunLines.length > 0 && (
                  <div>
                    <div className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                      {t('sessions.quick.liveLogs')}
                    </div>
                    <pre
                      className="mt-1 max-h-40 overflow-y-auto rounded-[6px] border p-3 font-mono-token text-xs"
                      style={{
                        backgroundColor: 'var(--bg-well)',
                        borderColor: 'var(--border-subtle)',
                      }}
                    >
                      {liveRunLines.slice(-15).join('\n')}
                    </pre>
                  </div>
                )}

              {/* Review summary + Diff + Approve & merge / Reject */}
              {guardEntry?.latestReview && (
                <div
                  className="rounded-[6px] border p-3 space-y-2 text-sm"
                  style={{
                    backgroundColor: 'var(--bg-well)',
                    borderColor: 'var(--border-subtle)',
                  }}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      style={{
                        color:
                          guardEntry.latestReview.status === 'pass' ? 'var(--pass)' : 'var(--error)',
                        borderColor:
                          guardEntry.latestReview.status === 'pass' ? 'var(--pass)' : 'var(--error)',
                      }}
                    >
                      {te(guardEntry.latestReview.status)}
                    </Badge>
                    <span className="font-mono-token text-xs" style={{ color: 'var(--text-secondary)' }}>
                      {guardEntry.latestReview.reviewerProvider} · exit {guardEntry.latestReview.verifyExitCode}
                    </span>
                  </div>
                  {guardEntry.latestReview.contract.summary && (
                    <p>{guardEntry.latestReview.contract.summary}</p>
                  )}
                  {guardEntry.latestReview.contract.findings.length > 0 && (
                    <ul className="list-disc space-y-1 pl-5 text-xs">
                      {guardEntry.latestReview.contract.findings.map((f, idx) => (
                        <li key={idx}>
                          <strong>[{te(f.severity)}]</strong> {f.file ? `${f.file}: ` : ''}
                          {f.note}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {/* Diff toggle & viewer */}
              {guardEntry?.diffAvailable && (
                <div className="space-y-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setShowDiff((v) => !v)}
                  >
                    {showDiff ? t('sessions.quick.hideDiff') : t('sessions.quick.viewDiff')}
                  </Button>

                  {showDiff && diffQuery.isLoading && <LoadingPanel label={t('guard.loadingDiff')} />}
                  {showDiff && diffQuery.data?.diff && (
                    <div
                      className="space-y-3 rounded-[6px] border p-3"
                      style={{
                        backgroundColor: 'var(--bg-well)',
                        borderColor: 'var(--border-subtle)',
                      }}
                    >
                      {diffQuery.data.diff.files.length === 0 ? (
                        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                          {t('sessions.quick.noDiffFiles')}
                        </p>
                      ) : (
                        diffQuery.data.diff.files.map((file) => (
                          <div key={file.path} className="space-y-1">
                            <div className="flex items-center justify-between text-xs font-mono-token">
                              <span>{file.path}</span>
                              <span>
                                +{file.additions} / -{file.deletions}
                              </span>
                            </div>
                            <pre className="max-h-60 overflow-x-auto overflow-y-auto rounded-[4px] border p-2 font-mono-token text-xs">
                              {file.patch.split('\n').map((line, idx) => (
                                <div key={idx} className={diffLineClasses(line)}>
                                  {line}
                                </div>
                              ))}
                            </pre>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Merge Gate Actions */}
              {guardEntry && (guardEntry.canApproveMerge || guardEntry.canReject) && (
                <div className="space-y-3 border-t pt-3" style={{ borderColor: 'var(--border-subtle)' }}>
                  <div className="flex flex-wrap items-center gap-2">
                    {guardEntry.canApproveMerge && (
                      <Button
                        type="button"
                        disabled={approveMergeMutation.isPending}
                        onClick={() =>
                          approveMergeMutation.mutate(quickTask.status === 'review_failed')
                        }
                      >
                        {approveMergeMutation.isPending
                          ? t('sessions.quick.merging')
                          : t('sessions.quick.approveMerge')}
                      </Button>
                    )}
                    {guardEntry.canReject && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setShowRejectBox((v) => !v)}
                      >
                        {t('sessions.quick.reject')}
                      </Button>
                    )}
                  </div>

                  {showRejectBox && (
                    <div
                      className="space-y-2 rounded-[6px] border p-3"
                      style={{
                        backgroundColor: 'var(--bg-well)',
                        borderColor: 'var(--border-subtle)',
                      }}
                    >
                      <Textarea
                        rows={2}
                        value={rejectNote}
                        onChange={(e) => setRejectNote(e.target.value)}
                        placeholder={t('sessions.quick.rejectNotePlaceholder')}
                      />
                      <Label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={rejectRequeue}
                          onChange={(e) => setRejectRequeue(e.target.checked)}
                          className="h-4 w-4"
                        />
                        <span>{t('sessions.quick.requeueToggle')}</span>
                      </Label>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="destructive"
                          disabled={rejectMutation.isPending}
                          onClick={() => rejectMutation.mutate()}
                        >
                          {t('sessions.quick.reject')}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setShowRejectBox(false)}
                        >
                          {t('common.cancel')}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Merged banner */}
              {quickTask.status === 'done' && (
                <div
                  className="rounded-[6px] border px-3 py-2 text-sm font-medium"
                  style={{
                    backgroundColor: 'var(--pass-tint)',
                    borderColor: 'var(--pass)',
                    color: 'var(--pass)',
                  }}
                >
                  {t('sessions.quick.mergedNotice', {
                    branch: project.mainBranch,
                    sha: (quickTask.mergeCommitSha ?? '').slice(0, 8) || 'HEAD',
                  })}
                </div>
              )}
            </section>
          )}

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

          {actionError && <ErrorPanel title={t('plan.actionFailed')} detail={actionError} />}

          <ComposerDock>
            <ModeComposer
              modelPicker={choice.picker}
              session={session}
              selectedMode={activeComposerMode}
              onSelectMode={handleSelectComposerMode}
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              images={images}
              onImagesChange={setImages}
              busy={turnRunning}
              isFinishedSession={isFinished}
              otherWorkingSessionTitle={otherWorkingTitle}
            />
          </ComposerDock>
        </>
      )}
    </div>
  );
}
