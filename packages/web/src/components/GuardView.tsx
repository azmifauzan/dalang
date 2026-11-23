import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  GuardTaskEntryDTO,
  IntegrationRunDTO,
  ProjectSummary,
  ReviewFindingSeverity,
  TaskDiffFileDTO,
  TaskReviewDTO,
} from '@dalang/shared';
import { useI18n } from '../i18n/index.js';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { EmptyPanel, ErrorPanel, LoadingPanel, ModalDialog } from '@/components/StateViews';

interface GuardViewProps {
  project: ProjectSummary;
  sessionId?: string;
  onGoToWork?: () => void;
}

function guardStatusStyle(status: string): { color: string; borderColor: string; backgroundColor?: string } {
  if (status === 'done' || status === 'passed' || status === 'pass' || status === 'approved') {
    return {
      color: 'var(--pass)',
      borderColor: 'var(--pass)',
      backgroundColor: 'var(--pass-tint)',
    };
  }
  if (status === 'review_failed' || status === 'failed' || status === 'fail' || status === 'rejected') {
    return {
      color: 'var(--error)',
      borderColor: 'var(--error)',
      backgroundColor: 'var(--error-tint)',
    };
  }
  if (status === 'awaiting_merge' || status === 'reviewing') {
    return {
      color: 'var(--primary)',
      borderColor: 'var(--primary)',
    };
  }
  return { color: 'var(--text-secondary)', borderColor: 'var(--border-subtle)' };
}

function severityClasses(severity: ReviewFindingSeverity): string {
  if (severity === 'critical' || severity === 'major') {
    return 'bg-[#fee2e2] text-[#991b1b] border-[#991b1b]/30 dark:bg-[#3b1919] dark:text-[#fca5a5] dark:border-[#fca5a5]/30';
  }
  if (severity === 'minor') {
    return 'bg-[#fdeee6] text-[#9a3412] border-[#9a3412]/30 dark:bg-[#3b2416] dark:text-[#f08c4b] dark:border-[#f08c4b]/30';
  }
  return 'bg-muted text-muted-foreground border-border';
}

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

export function GuardView({ project, sessionId, onGoToWork }: GuardViewProps) {
  const qc = useQueryClient();
  const { t, te } = useI18n();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedRound, setSelectedRound] = useState<number | null>(null);
  const [showVerifyOutput, setShowVerifyOutput] = useState(false);
  const [runIntegrationOnMerge, setRunIntegrationOnMerge] = useState(true);
  const [overrideModalTaskId, setOverrideModalTaskId] = useState<string | null>(null);

  const [rejectModalOpen, setRejectModalOpen] = useState(false);
  const [rejectNote, setRejectNote] = useState('');
  const [rejectRequeue, setRejectRequeue] = useState(true);

  const [cmdDraft, setCmdDraft] = useState<string>('');
  const [cmdInitialized, setCmdInitialized] = useState(false);
  const [remoteDraft, setRemoteDraft] = useState<string>('');
  const [pushAfterMergeDraft, setPushAfterMergeDraft] = useState<boolean>(false);
  const [createPrAfterMergeDraft, setCreatePrAfterMergeDraft] = useState<boolean>(false);
  const [allowUnconfinedIntegration, setAllowUnconfinedIntegration] = useState(false);
  const [expandedIntegrationId, setExpandedIntegrationId] = useState<string | null>(null);
  const [collapsedDiffPaths, setCollapsedDiffPaths] = useState<Record<string, boolean>>({});
  const [actionMessage, setActionMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const formatStatusLabel = (status: string): string => {
    switch (status) {
      case 'awaiting_merge':
        return t('guard.status.awaiting_merge');
      case 'review_failed':
        return t('guard.status.review_failed');
      case 'reviewing':
        return t('guard.status.reviewing');
      case 'done':
        return t('guard.status.done');
      default:
        return status.replace(/_/g, ' ');
    }
  };

  const guardQuery = useQuery({
    queryKey: ['guard', project.id, sessionId ?? 'default'],
    queryFn: () => api.getGuardState(project.id, sessionId),
  });

  const guard = guardQuery.data?.guard;

  useEffect(() => {
    setCmdInitialized(false);
    setSelectedTaskId(null);
    setActionMessage(null);
  }, [project.id]);

  useEffect(() => {
    if (!guard || cmdInitialized) return;
    setCmdDraft(guard.integrationCommand ?? guard.detectedIntegrationCommand ?? '');
    setRemoteDraft(guard.gitRemote ?? '');
    setPushAfterMergeDraft(Boolean(guard.pushAfterMerge));
    setCreatePrAfterMergeDraft(Boolean(guard.createPrAfterMerge));
    setCmdInitialized(true);
  }, [guard, cmdInitialized]);

  const sortedEntries = useMemo(() => {
    if (!guard) return [] as GuardTaskEntryDTO[];
    const priority = (status: string): number => {
      if (status === 'awaiting_merge') return 0;
      if (status === 'review_failed') return 1;
      if (status === 'reviewing') return 2;
      if (status === 'done') return 3;
      return 4;
    };
    return [...guard.tasks].sort((a, b) => {
      const diff = priority(a.task.status) - priority(b.task.status);
      if (diff !== 0) return diff;
      return a.task.position - b.task.position;
    });
  }, [guard]);

  useEffect(() => {
    if (sortedEntries.length === 0) {
      setSelectedTaskId(null);
      return;
    }
    if (!selectedTaskId || !sortedEntries.some((e) => e.task.id === selectedTaskId)) {
      setSelectedTaskId(sortedEntries[0].task.id);
    }
  }, [sortedEntries, selectedTaskId]);

  const selectedEntry = useMemo(
    () => sortedEntries.find((e) => e.task.id === selectedTaskId) ?? null,
    [sortedEntries, selectedTaskId],
  );

  useEffect(() => {
    if (!selectedEntry) {
      setSelectedRound(null);
      return;
    }
    const latest =
      selectedEntry.latestReview?.round ??
      selectedEntry.reviews[selectedEntry.reviews.length - 1]?.round ??
      null;
    setSelectedRound(latest);
    setShowVerifyOutput(false);
    setCollapsedDiffPaths({});
  }, [selectedEntry?.task.id, selectedEntry?.reviews.length]);

  const activeReview: TaskReviewDTO | null = useMemo(() => {
    if (!selectedEntry || selectedEntry.reviews.length === 0) return null;
    if (selectedRound !== null) {
      const matched = selectedEntry.reviews.find((r) => r.round === selectedRound);
      if (matched) return matched;
    }
    return selectedEntry.latestReview ?? selectedEntry.reviews[selectedEntry.reviews.length - 1] ?? null;
  }, [selectedEntry, selectedRound]);

  const diffQuery = useQuery({
    queryKey: [
      'task-diff',
      project.id,
      selectedEntry?.task.id ?? null,
      selectedEntry?.task.status ?? null,
      selectedEntry?.task.mergeCommitSha ?? null,
      selectedEntry?.reviews.length ?? 0,
    ],
    queryFn: () => api.getTaskDiff(project.id, selectedEntry!.task.id),
    enabled: Boolean(selectedEntry?.task.id && selectedEntry?.diffAvailable),
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['guard', project.id] });
    qc.invalidateQueries({ queryKey: ['execution', project.id] });
    qc.invalidateQueries({ queryKey: ['plan', project.id] });
    qc.invalidateQueries({ queryKey: ['task-diff', project.id] });
    qc.invalidateQueries({ queryKey: ['sessions', project.id] });
    qc.invalidateQueries({ queryKey: ['projects'] });
  };

  const approveMergeMutation = useMutation({
    mutationFn: (vars: { taskId: string; runIntegration: boolean; allowFailedReview: boolean }) =>
      api.approveMergeTask(project.id, vars.taskId, {
        runIntegration: vars.runIntegration,
        allowUnconfined: allowUnconfinedIntegration,
        allowFailedReview: vars.allowFailedReview,
      }),
    onSuccess: (data) => {
      setOverrideModalTaskId(null);
      if (data.integrationRun) {
        setExpandedIntegrationId(data.integrationRun.id);
      }
      const integrationSummary = data.integrationRun
        ? t('guard.integrationStatus', { status: te(data.integrationRun.status) })
        : '';
      const pushSummary = data.pushPrResult ? ` ${data.pushPrResult.message}` : '';
      setActionMessage({
        kind: data.pushPrResult && !data.pushPrResult.pushed ? 'err' : 'ok',
        text: `Merged ${data.task.externalId} -> ${guard?.mainBranch ?? 'main'} (${data.mergeCommitSha.slice(0, 8)}).${integrationSummary}${pushSummary}`,
      });
      invalidateAll();
    },
    onError: (err) => {
      setOverrideModalTaskId(null);
      setActionMessage({ kind: 'err', text: (err as Error).message });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (vars: { taskId: string; note: string; requeue: boolean }) =>
      api.rejectTask(project.id, vars.taskId, { note: vars.note, requeue: vars.requeue }),
    onSuccess: (data) => {
      setRejectModalOpen(false);
      setRejectNote('');
      setActionMessage({
        kind: 'ok',
        text: `${data.task.externalId}: ${te(data.task.status)}`,
      });
      invalidateAll();
    },
    onError: (err) => setActionMessage({ kind: 'err', text: (err as Error).message }),
  });

  const saveCommandMutation = useMutation({
    mutationFn: (integrationCommand: string | null) =>
      api.updateProjectSettings(project.id, { integrationCommand }),
    onSuccess: (res) => {
      setCmdDraft(res.project.integrationCommand ?? '');
      setActionMessage({ kind: 'ok', text: t('guard.saveCommand') });
      invalidateAll();
    },
    onError: (err) => setActionMessage({ kind: 'err', text: (err as Error).message }),
  });

  const saveRemoteSettingsMutation = useMutation({
    mutationFn: (vars: { gitRemote: string | null; pushAfterMerge: boolean; createPrAfterMerge: boolean }) =>
      api.updateProjectSettings(project.id, vars),
    onSuccess: () => {
      setActionMessage({ kind: 'ok', text: t('guard.saveRemote') });
      invalidateAll();
    },
    onError: (err) => setActionMessage({ kind: 'err', text: (err as Error).message }),
  });

  const pushPrMutation = useMutation({
    mutationFn: (vars: { taskId: string; createPr: boolean }) =>
      api.pushTaskPr(project.id, vars.taskId, {
        remote: remoteDraft.trim() || undefined,
        createPr: vars.createPr,
      }),
    onSuccess: (res) => {
      setActionMessage({ kind: 'ok', text: res.result.message });
      invalidateAll();
    },
    onError: (err) => setActionMessage({ kind: 'err', text: (err as Error).message }),
  });

  const runIntegrationMutation = useMutation({
    mutationFn: () =>
      api.runIntegration(project.id, {
        command: cmdDraft.trim() || undefined,
        allowUnconfined: allowUnconfinedIntegration,
      }),
    onSuccess: (res) => {
      setExpandedIntegrationId(res.integrationRun.id);
      setActionMessage({
        kind: res.integrationRun.status === 'failed' ? 'err' : 'ok',
        text: `${te(res.integrationRun.status)}${
          res.integrationRun.exitCode !== null ? ` (exit ${res.integrationRun.exitCode})` : ''
        }`,
      });
      invalidateAll();
    },
    onError: (err) => setActionMessage({ kind: 'err', text: (err as Error).message }),
  });

  if (guardQuery.isLoading) {
    return <LoadingPanel label={t('guard.loading')} />;
  }

  if (guardQuery.isError || !guard) {
    return (
      <ErrorPanel
        title={t('guard.loadError')}
        detail={(guardQuery.error as Error)?.message ?? t('common.unknownError')}
        onRetry={() => guardQuery.refetch()}
      />
    );
  }

  const awaitingCount = guard.tasks.filter((e) => e.task.status === 'awaiting_merge').length;
  const failedCount = guard.tasks.filter((e) => e.task.status === 'review_failed').length;
  const doneCount = guard.tasks.filter((e) => e.task.status === 'done').length;

  const effectiveCommandPreview =
    cmdDraft.trim() || guard.integrationCommand || guard.detectedIntegrationCommand || '';
  const needsUnconfinedWarning = !guard.sandboxReady;

  const toggleDiffFile = (filePath: string) => {
    setCollapsedDiffPaths((prev) => ({ ...prev, [filePath]: !prev[filePath] }));
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <section className="rounded-[8px] border border-border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold tracking-tight">{t('guard.title')}</h2>
              <Badge>{guard.mainBranch}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {t('guard.subtitle', { branch: guard.mainBranch })}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {onGoToWork && (
              <Button type="button" variant="outline" onClick={onGoToWork}>
                {t('guard.backToWork')}
              </Button>
            )}
            <Button type="button" variant="outline" onClick={() => guardQuery.refetch()}>
              {t('common.refresh')}
            </Button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          <Badge style={awaitingCount > 0 ? guardStatusStyle('awaiting_merge') : undefined}>
            {t('guard.awaitingMerge', { count: awaitingCount })}
          </Badge>
          <Badge style={failedCount > 0 ? guardStatusStyle('review_failed') : undefined}>
            {t('guard.reviewFailed', { count: failedCount })}
          </Badge>
          <Badge style={doneCount > 0 ? guardStatusStyle('done') : undefined}>
            {t('guard.merged', { count: doneCount })}
          </Badge>
          <Badge>{t('guard.integrationRuns', { count: guard.integrationRuns.length })}</Badge>
        </div>

        {actionMessage && (
          <div
            role={actionMessage.kind === 'err' ? 'alert' : 'status'}
            className="mt-4 rounded-[6px] border px-3 py-2 text-sm"
            style={
              actionMessage.kind === 'err'
                ? {
                    backgroundColor: 'var(--error-tint)',
                    borderColor: 'var(--error)',
                    color: 'var(--error)',
                  }
                : {
                    backgroundColor: 'var(--pass-tint)',
                    borderColor: 'var(--pass)',
                    color: 'var(--pass)',
                  }
            }
          >
            {actionMessage.text}
          </div>
        )}
      </section>

      {/* Main Split Workspace */}
      {sortedEntries.length === 0 ? (
        <EmptyPanel
          title={t('guard.emptyTitle')}
          description={t('guard.emptyDesc')}
          action={
            onGoToWork ? (
              <Button type="button" onClick={onGoToWork}>
                {t('guard.openWork')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(250px,310px)_minmax(0,1fr)]">
          {/* Task queue */}
          <aside
            aria-label={t('guard.tasksQueue', { count: sortedEntries.length })}
            className="min-w-0 rounded-[8px] border border-border bg-card p-3"
          >
            <div className="mb-2 flex items-center justify-between px-1">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('guard.tasksQueue', { count: sortedEntries.length })}
              </h3>
            </div>
            <ul className="space-y-2">
              {sortedEntries.map((entry) => {
                const isSelected = entry.task.id === selectedEntry?.task.id;
                return (
                  <li key={entry.task.id}>
                    <button
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => setSelectedTaskId(entry.task.id)}
                      className={`min-h-11 w-full cursor-pointer rounded-[6px] border px-3 py-2.5 text-left transition-colors ${
                        isSelected
                          ? 'border-primary bg-accent/10'
                          : 'border-border bg-background hover:bg-muted/60'
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-mono-token text-xs font-semibold">{entry.task.externalId}</span>
                        <Badge style={guardStatusStyle(entry.task.status)}>
                          {formatStatusLabel(entry.task.status)}
                        </Badge>
                      </div>
                      <p className="mt-1 truncate text-sm font-medium">{entry.task.title}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span>{t('guard.roundsCount', { count: entry.task.reviewRounds })}</span>
                        {entry.latestReview && (
                          <span className="font-mono-token">
                            Verify: {entry.latestReview.verifyExitCode === 0 ? 'OK' : `exit ${entry.latestReview.verifyExitCode}`}
                          </span>
                        )}
                        {entry.latestReview && entry.latestReview.contract.findings.length > 0 && (
                          <span>
                            {t('guard.findingsCount', {
                              count: entry.latestReview.contract.findings.length,
                            })}
                          </span>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>

          {/* Selected Task Inspector */}
          {selectedEntry && (
            <div className="min-w-0 space-y-6">
              <section className="rounded-[8px] border border-border bg-card p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge>{selectedEntry.task.externalId}</Badge>
                      <Badge style={guardStatusStyle(selectedEntry.task.status)}>
                        {formatStatusLabel(selectedEntry.task.status)}
                      </Badge>
                      {selectedEntry.task.branchName && (
                        <Badge className="h-auto max-w-full py-1 whitespace-normal break-all">
                          {selectedEntry.task.branchName}
                        </Badge>
                      )}
                      {selectedEntry.task.mergeCommitSha && (
                        <Badge>{selectedEntry.task.mergeCommitSha.slice(0, 8)}</Badge>
                      )}
                      {selectedEntry.task.prUrl && (
                        <a
                          href={selectedEntry.task.prUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex min-h-8 items-center rounded-[4px] border border-primary px-2 py-0.5 font-mono-token text-xs font-medium text-primary underline underline-offset-2"
                        >
                          {t('guard.openPr')}
                        </a>
                      )}
                    </div>
                    <h3 className="text-lg leading-snug font-semibold">{selectedEntry.task.title}</h3>
                    <p className="text-sm text-muted-foreground">{selectedEntry.task.goal}</p>
                  </div>

                  {selectedEntry.task.status === 'done' && (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        disabled={pushPrMutation.isPending}
                        onClick={() =>
                          pushPrMutation.mutate({
                            taskId: selectedEntry.task.id,
                            createPr: false,
                          })
                        }
                      >
                        {pushPrMutation.isPending
                          ? t('guard.pushing')
                          : t('guard.pushBranch', { branch: guard.mainBranch })}
                      </Button>
                      <Button
                        type="button"
                        disabled={pushPrMutation.isPending || !guard.ghAvailable}
                        onClick={() =>
                          pushPrMutation.mutate({
                            taskId: selectedEntry.task.id,
                            createPr: true,
                          })
                        }
                      >
                        {pushPrMutation.isPending ? t('guard.openingPr') : t('guard.pushAndPr')}
                      </Button>
                    </div>
                  )}
                </div>

                {selectedEntry.task.rejectionNote && (
                  <div
                    role="note"
                    className="mt-4 rounded-[6px] border px-3 py-2 text-sm"
                    style={{
                      backgroundColor: 'var(--error-tint)',
                      borderColor: 'var(--error)',
                      color: 'var(--error)',
                    }}
                  >
                    <span className="font-semibold">{t('guard.humanNoteLabel')} </span>
                    {selectedEntry.task.rejectionNote}
                  </div>
                )}

                {(selectedEntry.canApproveMerge || selectedEntry.canReject) && (
                  <div className="mt-5 border-t border-border pt-4">
                    <div className="flex flex-wrap items-center justify-between gap-4">
                      <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-[var(--primary)]"
                          checked={runIntegrationOnMerge}
                          onChange={(e) => setRunIntegrationOnMerge(e.target.checked)}
                        />
                        <span>
                          {t('guard.runIntegrationAfterMerge', { branch: guard.mainBranch })}
                          {effectiveCommandPreview ? (
                            <span className="font-mono-token text-xs text-muted-foreground">
                              {' '}({effectiveCommandPreview})
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              {' '}{t('guard.skipsIfNone')}
                            </span>
                          )}
                        </span>
                      </label>

                      <div className="flex flex-wrap items-center gap-2">
                        {selectedEntry.canReject && (
                          <Button
                            type="button"
                            variant="destructive"
                            disabled={rejectMutation.isPending || approveMergeMutation.isPending}
                            onClick={() => {
                              setRejectNote(selectedEntry.task.rejectionNote ?? '');
                              setRejectRequeue(true);
                              setRejectModalOpen(true);
                            }}
                          >
                            {t('guard.rejectSendBack')}
                          </Button>
                        )}
                        {selectedEntry.canApproveMerge && (
                          <Button
                            type="button"
                            disabled={approveMergeMutation.isPending || rejectMutation.isPending}
                            onClick={() => {
                              if (selectedEntry.task.status === 'review_failed') {
                                setOverrideModalTaskId(selectedEntry.task.id);
                              } else {
                                approveMergeMutation.mutate({
                                  taskId: selectedEntry.task.id,
                                  runIntegration: runIntegrationOnMerge,
                                  allowFailedReview: false,
                                });
                              }
                            }}
                          >
                            {approveMergeMutation.isPending
                              ? t('guard.merging')
                              : t('guard.approveMerge')}
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </section>

              {/* Automated Review */}
              <section className="rounded-[8px] border border-border bg-card p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-base font-semibold">{t('guard.autoReviewTitle')}</h3>
                    <p className="text-xs text-muted-foreground">{t('guard.autoReviewDesc')}</p>
                  </div>
                  {selectedEntry.reviews.length > 1 && (
                    <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('guard.autoReviewTitle')}>
                      {selectedEntry.reviews.map((rev) => (
                        <Button
                          key={rev.id}
                          type="button"
                          variant={activeReview?.id === rev.id ? 'default' : 'outline'}
                          onClick={() => {
                            setSelectedRound(rev.round);
                            setShowVerifyOutput(false);
                          }}
                        >
                          {t('guard.roundLabel', { n: rev.round })}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>

                {!activeReview ? (
                  <p className="mt-4 text-sm text-muted-foreground">
                    {selectedEntry.task.status === 'reviewing'
                      ? t('guard.reviewRunning')
                      : t('guard.noReviewRecorded')}
                  </p>
                ) : (
                  <div className="mt-4 space-y-4">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <Badge style={guardStatusStyle(activeReview.status)}>
                        {t('guard.verdictLabel', { status: activeReview.status })}
                      </Badge>
                      <Badge>
                        {t('guard.reviewerLabel', {
                          name: activeReview.reviewerProfileName,
                          provider: activeReview.reviewerProvider,
                        })}
                      </Badge>
                      {activeReview.reviewerModel && (
                        <Badge>Model: {activeReview.reviewerModel}</Badge>
                      )}
                      <Badge
                        className="h-auto max-w-full py-1 whitespace-normal break-all"
                        style={guardStatusStyle(activeReview.verifyExitCode === 0 ? 'passed' : 'failed')}
                      >
                        {activeReview.verifyCommand}: exit {activeReview.verifyExitCode}
                      </Badge>
                      <Badge style={guardStatusStyle(activeReview.humanDecision)}>
                        Gate 2: {activeReview.humanDecision}
                      </Badge>
                    </div>

                    <div className="rounded-[6px] border border-border bg-background p-3.5 text-sm">
                      <p className="font-medium">{t('guard.summaryLabel')}</p>
                      <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                        {activeReview.contract.summary}
                      </p>
                      {activeReview.humanNote && (
                        <p className="mt-2 text-xs text-muted-foreground">
                          <span className="font-semibold text-foreground">{t('guard.humanNoteLabel')} </span>
                          {activeReview.humanNote}
                        </p>
                      )}
                    </div>

                    {activeReview.scopeWarnings.length > 0 && (
                      <div
                        className="rounded-[6px] border px-3.5 py-3 text-sm"
                        style={{
                          backgroundColor: 'var(--error-tint)',
                          borderColor: 'var(--error)',
                          color: 'var(--error)',
                        }}
                      >
                        <p className="font-semibold">{t('work.scopeWarnings')}</p>
                        <ul className="mt-1 list-disc pl-5 font-mono-token text-xs">
                          {activeReview.scopeWarnings.map((w) => (
                            <li key={w}>{w}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <div>
                      <Button
                        type="button"
                        variant="outline"
                        aria-expanded={showVerifyOutput}
                        onClick={() => setShowVerifyOutput((v) => !v)}
                      >
                        {showVerifyOutput ? t('guard.hideVerifyOutput') : t('guard.showVerifyOutput')}
                      </Button>
                      {showVerifyOutput && (
                        <pre className="mt-2 max-h-64 overflow-x-auto overflow-y-auto rounded-[6px] border border-border bg-background p-3 font-mono-token text-xs">
                          {activeReview.verifyOutput || t('guard.noOutputCaptured')}
                        </pre>
                      )}
                    </div>

                    <div className="space-y-2">
                      <h4 className="text-sm font-semibold">
                        {t('guard.findingsCount', { count: activeReview.contract.findings.length })}
                      </h4>
                      {activeReview.contract.findings.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          {t('guard.noIssuesRound', { round: activeReview.round })}
                        </p>
                      ) : (
                        <ul className="space-y-2">
                          {activeReview.contract.findings.map((finding, i) => (
                            <li
                              key={`${te(finding.severity)}-${finding.file ?? ''}-${i}`}
                              className="rounded-[6px] border border-border bg-background p-3 text-sm"
                            >
                              <div className="flex flex-wrap items-center gap-2">
                                <span
                                  className={`inline-flex items-center rounded-[4px] border px-2 py-0.5 font-mono-token text-xs font-semibold uppercase ${severityClasses(
                                    finding.severity,
                                  )}`}
                                >
                                  {te(finding.severity)}
                                </span>
                                {finding.file && (
                                  <span className="font-mono-token text-xs text-muted-foreground">
                                    {finding.file}
                                  </span>
                                )}
                              </div>
                              <p className="mt-1.5 text-sm">{finding.note}</p>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                )}
              </section>

              {/* Branch Diff */}
              <section className="rounded-[8px] border border-border bg-card p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-base font-semibold">{t('guard.branchDiffTitle')}</h3>
                    <p className="text-xs text-muted-foreground">
                      {t('guard.branchDiffDesc', {
                        branch: selectedEntry.task.branchName ?? 'branch',
                        main: guard.mainBranch,
                      })}
                    </p>
                  </div>
                  {diffQuery.data?.diff && (
                    <div className="flex flex-wrap items-center gap-2 font-mono-token text-xs">
                      <Badge>{t('guard.filesCount', { count: diffQuery.data.diff.files.length })}</Badge>
                      <Badge style={guardStatusStyle('passed')}>
                        +{diffQuery.data.diff.totalAdditions}
                      </Badge>
                      <Badge style={guardStatusStyle('failed')}>
                        -{diffQuery.data.diff.totalDeletions}
                      </Badge>
                    </div>
                  )}
                </div>

                {!selectedEntry.diffAvailable ? (
                  <p className="mt-4 text-sm text-muted-foreground">{t('guard.noDiffAvailable')}</p>
                ) : diffQuery.isLoading ? (
                  <div className="mt-4">
                    <LoadingPanel label={t('guard.loadingDiff')} />
                  </div>
                ) : diffQuery.isError ? (
                  <div className="mt-4">
                    <ErrorPanel
                      title={t('guard.diffError')}
                      detail={(diffQuery.error as Error).message}
                      onRetry={() => diffQuery.refetch()}
                    />
                  </div>
                ) : diffQuery.data?.diff.files.length === 0 ? (
                  <p className="mt-4 text-sm text-muted-foreground">{t('guard.noFileChanges')}</p>
                ) : (
                  <div className="mt-4 space-y-3">
                    {diffQuery.data?.diff.repos && diffQuery.data.diff.repos.length > 1 && (
                      <div className="flex flex-wrap items-center gap-2 font-mono-token text-xs">
                        {diffQuery.data.diff.repos
                          .filter((r) => r.fileCount > 0)
                          .map((r) => (
                            <Badge key={r.repoPath}>
                              {r.repoPath === '.' ? t('guard.repoRoot') : `${r.repoPath}/`} · {r.baseBranch} (+{r.additions}/-{r.deletions})
                            </Badge>
                          ))}
                      </div>
                    )}
                    {diffQuery.data?.diff.truncated && (
                      <p className="text-xs text-muted-foreground">{t('guard.diffTruncated')}</p>
                    )}
                    {[...(diffQuery.data?.diff.files ?? [])]
                      .sort((a, b) => {
                        const aMeta = a.path.startsWith('.dalang/') ? 1 : 0;
                        const bMeta = b.path.startsWith('.dalang/') ? 1 : 0;
                        return aMeta - bMeta;
                      })
                      .map((file: TaskDiffFileDTO) => {
                        const collapsed = Boolean(collapsedDiffPaths[file.path]);
                        const patchLines = file.patch ? file.patch.split('\n') : [];
                        return (
                          <div key={file.path} className="min-w-0 overflow-hidden rounded-[6px] border border-border">
                            <button
                              type="button"
                              aria-expanded={!collapsed}
                              onClick={() => toggleDiffFile(file.path)}
                              className="flex min-h-11 w-full cursor-pointer flex-wrap items-center justify-between gap-2 bg-muted/50 px-3 py-2 text-left hover:bg-muted"
                            >
                              <div className="flex min-w-0 items-center gap-2">
                                {file.repo && (
                                  <Badge>{file.repo === '.' ? t('guard.repoRoot') : `${file.repo}/`}</Badge>
                                )}
                                <Badge>{te(file.status)}</Badge>
                                <span className="truncate font-mono-token text-xs font-medium">{file.path}</span>
                              </div>
                              <span className="font-mono-token text-xs text-muted-foreground">
                                +{file.additions} / -{file.deletions}{' '}
                                ({collapsed ? t('common.show') : t('common.hide')})
                              </span>
                            </button>
                            {!collapsed && (
                              <div className="overflow-x-auto border-t border-border bg-background">
                                {patchLines.length === 0 ? (
                                  <p className="p-3 font-mono-token text-xs text-muted-foreground">
                                    {t('guard.binaryOrEmpty')}
                                  </p>
                                ) : (
                                  <pre className="py-2 font-mono-token text-xs leading-relaxed">
                                    {patchLines.map((line, lineIdx) => (
                                      <div
                                        key={lineIdx}
                                        className={`min-w-max px-3 whitespace-pre ${diffLineClasses(line)}`}
                                      >
                                        {line || ' '}
                                      </div>
                                    ))}
                                  </pre>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      )}

      {/* Post-merge integration suite */}
      <section className="rounded-[8px] border border-border bg-card p-5">
        <div className="space-y-1">
          <h3 className="text-base font-semibold">{t('guard.integrationTitle')}</h3>
          <p className="text-sm text-muted-foreground">
            {t('guard.integrationDesc', { branch: guard.mainBranch })}
          </p>
        </div>

        <form
          className="mt-4 flex flex-col gap-3 md:flex-row md:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            saveCommandMutation.mutate(cmdDraft.trim() ? cmdDraft.trim() : null);
          }}
        >
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor="integration-command-input">{t('guard.integrationCmdLabel')}</Label>
            <Input
              id="integration-command-input"
              value={cmdDraft}
              onChange={(e) => setCmdDraft(e.target.value)}
              placeholder={guard.detectedIntegrationCommand ?? 'e.g. pnpm test'}
            />
            {guard.detectedIntegrationCommand && (
              <p className="text-xs text-muted-foreground">
                {t('guard.integrationDetected')}{' '}
                <span className="font-mono-token">{guard.detectedIntegrationCommand}</span>
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="outline" disabled={saveCommandMutation.isPending}>
              {saveCommandMutation.isPending ? t('common.saving') : t('guard.saveCommand')}
            </Button>
            <Button
              type="button"
              disabled={
                runIntegrationMutation.isPending ||
                !effectiveCommandPreview ||
                (needsUnconfinedWarning && !allowUnconfinedIntegration)
              }
              onClick={() => runIntegrationMutation.mutate()}
            >
              {runIntegrationMutation.isPending
                ? t('guard.runningSuite')
                : t('guard.runIntegration')}
            </Button>
          </div>
        </form>

        {needsUnconfinedWarning && (
          <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[var(--primary)]"
              checked={allowUnconfinedIntegration}
              onChange={(e) => setAllowUnconfinedIntegration(e.target.checked)}
            />
            <span>{t('guard.unconfinedIntegration', { platform: guard.platform })}</span>
          </label>
        )}

        <div className="mt-5 space-y-2">
          <h4 className="text-sm font-semibold">{t('guard.recentIntegrations')}</h4>
          {guard.integrationRuns.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('guard.noIntegrationsYet')}</p>
          ) : (
            <ul className="space-y-2">
              {guard.integrationRuns.map((irun: IntegrationRunDTO) => {
                const isExpanded = expandedIntegrationId === irun.id;
                return (
                  <li key={irun.id} className="rounded-[6px] border border-border bg-background p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <Badge style={guardStatusStyle(irun.status)}>{te(irun.status)}</Badge>
                        <span className="min-w-0 max-w-full font-mono-token text-xs font-medium break-all">
                          {irun.command}
                        </span>
                        {irun.taskExternalId && <Badge>{irun.taskExternalId}</Badge>}
                        {irun.mergeCommitSha && (
                          <span className="font-mono-token text-xs text-muted-foreground">
                            @{irun.mergeCommitSha.slice(0, 8)}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {irun.exitCode !== null && (
                          <span className="font-mono-token text-xs text-muted-foreground">
                            exit {irun.exitCode}
                          </span>
                        )}
                        <Button
                          type="button"
                          variant="outline"
                          aria-expanded={isExpanded}
                          onClick={() => setExpandedIntegrationId(isExpanded ? null : irun.id)}
                        >
                          {isExpanded ? t('guard.hideLog') : t('guard.viewLog')}
                        </Button>
                      </div>
                    </div>
                    {isExpanded && (
                      <pre className="mt-3 max-h-60 overflow-x-auto overflow-y-auto rounded-[6px] border border-border bg-card p-3 font-mono-token text-xs">
                        {irun.output || t('guard.noOutputCaptured')}
                      </pre>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      {/* Remote Push & PR */}
      <section className="rounded-[8px] border border-border bg-card p-5">
        <div className="space-y-1">
          <h3 className="text-base font-semibold">{t('guard.remoteTitle')}</h3>
          <p className="text-sm text-muted-foreground">{t('guard.remoteDesc')}</p>
        </div>

        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            saveRemoteSettingsMutation.mutate({
              gitRemote: remoteDraft.trim() || null,
              pushAfterMerge: pushAfterMergeDraft,
              createPrAfterMerge: createPrAfterMergeDraft,
            });
          }}
        >
          <div className="grid gap-3 md:grid-cols-3 md:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="guard-git-remote">{t('guard.gitRemoteLabel')}</Label>
              <Input
                id="guard-git-remote"
                value={remoteDraft}
                onChange={(e) => setRemoteDraft(e.target.value)}
                placeholder={guard.gitRemote ?? 'origin'}
              />
            </div>

            <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[var(--primary)]"
                checked={pushAfterMergeDraft}
                onChange={(e) => setPushAfterMergeDraft(e.target.checked)}
              />
              <span>{t('guard.pushAfterMerge', { branch: guard.mainBranch })}</span>
            </label>

            <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[var(--primary)]"
                checked={createPrAfterMergeDraft}
                onChange={(e) => setCreatePrAfterMergeDraft(e.target.checked)}
              />
              <span>{t('guard.openPrAfterMerge')}</span>
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <p className="text-xs text-muted-foreground">
              {guard.ghAvailable ? t('guard.ghAvailable') : t('guard.ghMissing')}
            </p>
            <Button type="submit" variant="outline" disabled={saveRemoteSettingsMutation.isPending}>
              {saveRemoteSettingsMutation.isPending ? t('common.saving') : t('guard.saveRemote')}
            </Button>
          </div>
        </form>
      </section>

      {/* Reject Modal */}
      <ModalDialog
        open={rejectModalOpen}
        title={t('guard.rejectModalTitle', { id: selectedEntry?.task.externalId ?? '' })}
        onClose={() => setRejectModalOpen(false)}
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!selectedEntry) return;
            rejectMutation.mutate({
              taskId: selectedEntry.task.id,
              note: rejectNote.trim(),
              requeue: rejectRequeue,
            });
          }}
        >
          <p className="text-sm text-muted-foreground">
            {t('guard.rejectDesc', { branch: guard.mainBranch })}
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="reject-note-input">{t('guard.rejectFeedbackLabel')}</Label>
            <Textarea
              id="reject-note-input"
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
              placeholder={t('guard.rejectFeedbackPlaceholder')}
            />
          </div>
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[var(--primary)]"
              checked={rejectRequeue}
              onChange={(e) => setRejectRequeue(e.target.checked)}
            />
            <span>{t('guard.rejectRequeueLabel')}</span>
          </label>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setRejectModalOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="destructive" disabled={rejectMutation.isPending}>
              {rejectMutation.isPending ? t('guard.rejecting') : t('guard.confirmReject')}
            </Button>
          </div>
        </form>
      </ModalDialog>

      {/* Override Modal */}
      <ModalDialog
        open={Boolean(overrideModalTaskId)}
        title={t('guard.overrideTitle')}
        onClose={() => setOverrideModalTaskId(null)}
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t('guard.overrideDesc', { branch: guard.mainBranch })}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOverrideModalTaskId(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={approveMergeMutation.isPending}
              onClick={() => {
                if (!overrideModalTaskId) return;
                approveMergeMutation.mutate({
                  taskId: overrideModalTaskId,
                  runIntegration: runIntegrationOnMerge,
                  allowFailedReview: true,
                });
              }}
            >
              {approveMergeMutation.isPending ? t('guard.merging') : t('guard.overrideConfirm')}
            </Button>
          </div>
        </div>
      </ModalDialog>
    </div>
  );
}
