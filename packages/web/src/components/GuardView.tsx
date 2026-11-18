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
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { EmptyPanel, ErrorPanel, LoadingPanel, ModalDialog } from '@/components/StateViews';

interface GuardViewProps {
  project: ProjectSummary;
  onGoToNavigate?: () => void;
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

function formatStatusLabel(status: string): string {
  switch (status) {
    case 'awaiting_merge':
      return 'Awaiting merge';
    case 'review_failed':
      return 'Review failed';
    case 'reviewing':
      return 'Reviewing';
    case 'done':
      return 'Merged';
    default:
      return status.replace(/_/g, ' ');
  }
}

export function GuardView({ project, onGoToNavigate }: GuardViewProps) {
  const qc = useQueryClient();
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
  const [allowUnconfinedIntegration, setAllowUnconfinedIntegration] = useState(false);
  const [expandedIntegrationId, setExpandedIntegrationId] = useState<string | null>(null);
  const [collapsedDiffPaths, setCollapsedDiffPaths] = useState<Record<string, boolean>>({});
  const [actionMessage, setActionMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const guardQuery = useQuery({
    queryKey: ['guard', project.id],
    queryFn: () => api.getGuardState(project.id),
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
    const latest = selectedEntry.latestReview?.round ?? selectedEntry.reviews[selectedEntry.reviews.length - 1]?.round ?? null;
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
    qc.invalidateQueries({ queryKey: ['projects'] });
  };

  const approveMergeMutation = useMutation({
    mutationFn: (vars: { taskId: string; runIntegration: boolean; allowFailedReview: boolean }) =>
      api.approveMergeTask(project.id, vars.taskId, {
        runIntegration: vars.runIntegration,
        allowFailedReview: vars.allowFailedReview,
      }),
    onSuccess: (data) => {
      setOverrideModalTaskId(null);
      if (data.integrationRun) {
        setExpandedIntegrationId(data.integrationRun.id);
      }
      const integrationSummary = data.integrationRun
        ? ` Integration status: ${data.integrationRun.status}.`
        : '';
      setActionMessage({
        kind: 'ok',
        text: `Merged ${data.task.externalId} to ${guard?.mainBranch ?? 'main'} (${data.mergeCommitSha.slice(0, 8)}).${integrationSummary}`,
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
        text: data.task.status === 'approved'
          ? `Rejected ${data.task.externalId} and re-queued it for another coding pass.`
          : `Rejected ${data.task.externalId} and recorded feedback.`,
      });
      invalidateAll();
    },
    onError: (err) => {
      setActionMessage({ kind: 'err', text: (err as Error).message });
    },
  });

  const saveCommandMutation = useMutation({
    mutationFn: (integrationCommand: string | null) =>
      api.updateProjectSettings(project.id, { integrationCommand }),
    onSuccess: (res) => {
      setCmdDraft(res.project.integrationCommand ?? '');
      setActionMessage({ kind: 'ok', text: 'Integration test command saved.' });
      invalidateAll();
    },
    onError: (err) => {
      setActionMessage({ kind: 'err', text: (err as Error).message });
    },
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
        text: `Integration run finished: ${res.integrationRun.status}${
          res.integrationRun.exitCode !== null ? ` (exit ${res.integrationRun.exitCode})` : ''
        }.`,
      });
      invalidateAll();
    },
    onError: (err) => {
      setActionMessage({ kind: 'err', text: (err as Error).message });
    },
  });

  if (guardQuery.isLoading) {
    return <LoadingPanel label="Loading Guard reviews, diffs, and integration history..." />;
  }

  if (guardQuery.isError || !guard) {
    return (
      <ErrorPanel
        title="Could not load Guard state"
        detail={(guardQuery.error as Error)?.message ?? 'Unknown error'}
        onRetry={() => guardQuery.refetch()}
      />
    );
  }

  const awaitingCount = guard.tasks.filter((e) => e.task.status === 'awaiting_merge').length;
  const failedCount = guard.tasks.filter((e) => e.task.status === 'review_failed').length;
  const doneCount = guard.tasks.filter((e) => e.task.status === 'done').length;

  const effectiveCommandPreview = cmdDraft.trim() || guard.integrationCommand || guard.detectedIntegrationCommand || '';
  const needsUnconfinedWarning = !guard.sandboxReady;

  const toggleDiffFile = (filePath: string) => {
    setCollapsedDiffPaths((prev) => ({ ...prev, [filePath]: !prev[filePath] }));
  };

  return (
    <div className="space-y-6">
      {/* Guard Stage Header */}
      <section className="rounded-[8px] border border-border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight">Guard</h1>
              <Badge>Gate 2: {guard.mainBranch}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              Review automated verification findings, inspect branch diffs, and decide whether to merge onto{' '}
              <span className="font-mono-token text-foreground">{guard.mainBranch}</span> or send tasks back.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {onGoToNavigate && (
              <Button type="button" variant="outline" onClick={onGoToNavigate}>
                Back to Navigate
              </Button>
            )}
            <Button type="button" variant="outline" onClick={() => guardQuery.refetch()}>
              Refresh
            </Button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          <Badge style={awaitingCount > 0 ? guardStatusStyle('awaiting_merge') : undefined}>
            Awaiting merge: {awaitingCount}
          </Badge>
          <Badge style={failedCount > 0 ? guardStatusStyle('review_failed') : undefined}>
            Review failed: {failedCount}
          </Badge>
          <Badge style={doneCount > 0 ? guardStatusStyle('done') : undefined}>
            Merged: {doneCount}
          </Badge>
          <Badge>
            Integration runs: {guard.integrationRuns.length}
          </Badge>
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

      {/* Main Split Workspace: Task Gate Queue + Inspector */}
      {sortedEntries.length === 0 ? (
        <EmptyPanel
          title="No tasks ready for Guard yet"
          description="Run approved tasks in Navigate first. Completed coder branches enter automated code review and arrive here for your merge decision."
          action={
            onGoToNavigate ? (
              <Button type="button" onClick={onGoToNavigate}>
                Open Navigate
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(260px,330px)_minmax(0,1fr)]">
          {/* Task Gate Queue */}
          <aside
            aria-label="Guard task queue"
            className="min-w-0 rounded-[8px] border border-border bg-card p-3"
          >
            <div className="mb-2 flex items-center justify-between px-1">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Tasks ({sortedEntries.length})
              </h2>
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
                      className={`min-h-11 w-full rounded-[6px] border px-3 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
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
                        <span>
                          Rounds: {entry.task.reviewRounds}
                        </span>
                        {entry.latestReview && (
                          <span className="font-mono-token">
                            Verify: {entry.latestReview.verifyExitCode === 0 ? 'OK' : `exit ${entry.latestReview.verifyExitCode}`}
                          </span>
                        )}
                        {entry.latestReview && entry.latestReview.contract.findings.length > 0 && (
                          <span>
                            Findings: {entry.latestReview.contract.findings.length}
                          </span>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>

          {/* Selected Task Review & Diff Inspector */}
          {selectedEntry && (
            <div className="min-w-0 space-y-6">
              {/* Task Gate Summary & Human Decision Bar */}
              <section className="rounded-[8px] border border-border bg-card p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge>{selectedEntry.task.externalId}</Badge>
                      <Badge style={guardStatusStyle(selectedEntry.task.status)}>
                        {formatStatusLabel(selectedEntry.task.status)}
                      </Badge>
                      {selectedEntry.task.branchName && (
                        <Badge className="h-auto max-w-full whitespace-normal break-all py-1">
                          {selectedEntry.task.branchName}
                        </Badge>
                      )}
                      {selectedEntry.task.mergeCommitSha && (
                        <Badge>
                          Merged {selectedEntry.task.mergeCommitSha.slice(0, 8)}
                        </Badge>
                      )}
                    </div>
                    <h2 className="text-lg font-semibold leading-snug">{selectedEntry.task.title}</h2>
                    <p className="text-sm text-muted-foreground">{selectedEntry.task.goal}</p>
                  </div>
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
                    <span className="font-semibold">Note: </span>
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
                          Run post-merge integration tests on{' '}
                          <span className="font-mono-token">{guard.mainBranch}</span>
                          {effectiveCommandPreview ? (
                            <span className="font-mono-token text-xs text-muted-foreground">
                              {' '}({effectiveCommandPreview})
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground"> (skips if none set)</span>
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
                            Reject and send back
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
                            {approveMergeMutation.isPending ? 'Merging...' : 'Approve and merge'}
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </section>

              {/* Review Rounds & Findings */}
              <section className="rounded-[8px] border border-border bg-card p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-base font-semibold">Automated review</h3>
                    <p className="text-xs text-muted-foreground">
                      Independent reviewer checks verify output, acceptance criteria, and file scope.
                    </p>
                  </div>
                  {selectedEntry.reviews.length > 1 && (
                    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Review rounds">
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
                          Round {rev.round}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>

                {!activeReview ? (
                  <p className="mt-4 text-sm text-muted-foreground">
                    {selectedEntry.task.status === 'reviewing'
                      ? 'Automated review is currently running for this task.'
                      : 'No completed review report is recorded for this task.'}
                  </p>
                ) : (
                  <div className="mt-4 space-y-4">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <Badge style={guardStatusStyle(activeReview.status)}>
                        Verdict: {activeReview.status}
                      </Badge>
                      <Badge>
                        Reviewer: {activeReview.reviewerProfileName} ({activeReview.reviewerProvider})
                      </Badge>
                      {activeReview.reviewerModel && (
                        <Badge>Model: {activeReview.reviewerModel}</Badge>
                      )}
                      <Badge
                        className="h-auto max-w-full whitespace-normal break-all py-1"
                        style={guardStatusStyle(activeReview.verifyExitCode === 0 ? 'passed' : 'failed')}
                      >
                        {activeReview.verifyCommand}: exit {activeReview.verifyExitCode}
                      </Badge>
                      <Badge style={guardStatusStyle(activeReview.humanDecision)}>
                        Gate 2: {activeReview.humanDecision}
                      </Badge>
                    </div>

                    <div className="rounded-[6px] border border-border bg-background p-3.5 text-sm">
                      <p className="font-medium">Summary</p>
                      <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                        {activeReview.contract.summary}
                      </p>
                      {activeReview.humanNote && (
                        <p className="mt-2 text-xs text-muted-foreground">
                          <span className="font-semibold text-foreground">Human note: </span>
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
                        <p className="font-semibold">Scope warnings (outside files_allowed)</p>
                        <ul className="mt-1 list-disc pl-5 font-mono-token text-xs">
                          {activeReview.scopeWarnings.map((w) => (
                            <li key={w}>{w}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Verify command output toggle */}
                    <div>
                      <Button
                        type="button"
                        variant="outline"
                        aria-expanded={showVerifyOutput}
                        onClick={() => setShowVerifyOutput((v) => !v)}
                      >
                        {showVerifyOutput ? 'Hide verify output' : 'Show verify output'}
                      </Button>
                      {showVerifyOutput && (
                        <pre className="mt-2 max-h-64 overflow-x-auto overflow-y-auto rounded-[6px] border border-border bg-background p-3 font-mono-token text-xs">
                          {activeReview.verifyOutput || '(no output captured)'}
                        </pre>
                      )}
                    </div>

                    {/* Findings */}
                    <div className="space-y-2">
                      <h4 className="text-sm font-semibold">
                        Findings ({activeReview.contract.findings.length})
                      </h4>
                      {activeReview.contract.findings.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          No issues reported in round {activeReview.round}.
                        </p>
                      ) : (
                        <ul className="space-y-2">
                          {activeReview.contract.findings.map((finding, i) => (
                            <li
                              key={`${finding.severity}-${finding.file ?? ''}-${i}`}
                              className="rounded-[6px] border border-border bg-background p-3 text-sm"
                            >
                              <div className="flex flex-wrap items-center gap-2">
                                <span
                                  className={`inline-flex items-center rounded-[4px] border px-2 py-0.5 font-mono-token text-xs font-semibold uppercase ${severityClasses(
                                    finding.severity,
                                  )}`}
                                >
                                  {finding.severity}
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

              {/* Per-Task Branch Diff */}
              <section className="rounded-[8px] border border-border bg-card p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-base font-semibold">Branch diff</h3>
                    <p className="text-xs text-muted-foreground">
                      Changes introduced on {selectedEntry.task.branchName ?? 'task branch'} relative to{' '}
                      {guard.mainBranch}.
                    </p>
                  </div>
                  {diffQuery.data?.diff && (
                    <div className="flex flex-wrap items-center gap-2 font-mono-token text-xs">
                      <Badge>{diffQuery.data.diff.files.length} file(s)</Badge>
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
                  <p className="mt-4 text-sm text-muted-foreground">
                    No unmerged or recorded branch commits are available for diff inspection.
                  </p>
                ) : diffQuery.isLoading ? (
                  <div className="mt-4">
                    <LoadingPanel label="Computing unified diff..." />
                  </div>
                ) : diffQuery.isError ? (
                  <div className="mt-4">
                    <ErrorPanel
                      title="Could not load branch diff"
                      detail={(diffQuery.error as Error).message}
                      onRetry={() => diffQuery.refetch()}
                    />
                  </div>
                ) : diffQuery.data?.diff.files.length === 0 ? (
                  <p className="mt-4 text-sm text-muted-foreground">No file changes detected in this branch diff.</p>
                ) : (
                  <div className="mt-4 space-y-3">
                    {diffQuery.data?.diff.truncated && (
                      <p className="text-xs text-muted-foreground">
                        Large diff output truncated for display safety. Inspect the git branch locally for full patches.
                      </p>
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
                            className="flex min-h-11 w-full flex-wrap items-center justify-between gap-2 bg-muted/50 px-3 py-2 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              <Badge>{file.status}</Badge>
                              <span className="truncate font-mono-token text-xs font-medium">{file.path}</span>
                            </div>
                            <span className="font-mono-token text-xs text-muted-foreground">
                              +{file.additions} / -{file.deletions} {collapsed ? '(show)' : '(hide)'}
                            </span>
                          </button>
                          {!collapsed && (
                            <div className="overflow-x-auto border-t border-border bg-background">
                              {patchLines.length === 0 ? (
                                <p className="p-3 font-mono-token text-xs text-muted-foreground">
                                  (Binary file or empty patch)
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

      {/* Post-Merge Integration Suite (F-20) */}
      <section className="rounded-[8px] border border-border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-base font-semibold">Post-merge integration tests</h2>
            <p className="text-sm text-muted-foreground">
              Runs the project-wide test suite directly on <span className="font-mono-token">{guard.mainBranch}</span>{' '}
              after merges or manually on demand.
            </p>
          </div>
        </div>

        <form
          className="mt-4 flex flex-col gap-3 md:flex-row md:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            saveCommandMutation.mutate(cmdDraft.trim() ? cmdDraft.trim() : null);
          }}
        >
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor="integration-command-input">Integration command</Label>
            <Input
              id="integration-command-input"
              value={cmdDraft}
              onChange={(e) => setCmdDraft(e.target.value)}
              placeholder={guard.detectedIntegrationCommand ?? 'e.g. pnpm test'}
            />
            {guard.detectedIntegrationCommand && (
              <p className="text-xs text-muted-foreground">
                Auto-detected from repository:{' '}
                <span className="font-mono-token">{guard.detectedIntegrationCommand}</span>
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              variant="outline"
              disabled={saveCommandMutation.isPending}
            >
              {saveCommandMutation.isPending ? 'Saving...' : 'Save command'}
            </Button>
            <Button
              type="button"
              disabled={
                runIntegrationMutation.isPending ||
                (!effectiveCommandPreview) ||
                (needsUnconfinedWarning && !allowUnconfinedIntegration)
              }
              onClick={() => runIntegrationMutation.mutate()}
            >
              {runIntegrationMutation.isPending ? 'Running suite...' : 'Run integration suite'}
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
            <span>
              Linux bubblewrap sandbox is unavailable on this host ({guard.platform}). Allow running the integration
              command without filesystem isolation.
            </span>
          </label>
        )}

        <div className="mt-5 space-y-2">
          <h3 className="text-sm font-semibold">Recent integration runs</h3>
          {guard.integrationRuns.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No integration runs recorded yet. Approve a merge or click Run integration suite above.
            </p>
          ) : (
            <ul className="space-y-2">
              {guard.integrationRuns.map((irun: IntegrationRunDTO) => {
                const isExpanded = expandedIntegrationId === irun.id;
                return (
                  <li key={irun.id} className="rounded-[6px] border border-border bg-background p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <Badge style={guardStatusStyle(irun.status)}>{irun.status}</Badge>
                        <span className="min-w-0 max-w-full break-all font-mono-token text-xs font-medium">
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
                          {isExpanded ? 'Hide log' : 'View log'}
                        </Button>
                      </div>
                    </div>
                    {isExpanded && (
                      <pre className="mt-3 max-h-60 overflow-x-auto overflow-y-auto rounded-[6px] border border-border bg-card p-3 font-mono-token text-xs">
                        {irun.output || '(no output)'}
                      </pre>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      {/* Reject & Send Back Modal */}
      <ModalDialog
        open={rejectModalOpen}
        title={selectedEntry ? `Reject ${selectedEntry.task.externalId}` : 'Reject task'}
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
            Rejecting removes the unmerged task branch without touching <span className="font-mono-token">{guard.mainBranch}</span>.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="reject-note-input">Feedback for coder</Label>
            <Textarea
              id="reject-note-input"
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
              placeholder="Explain what needs to change before merging..."
            />
          </div>
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[var(--primary)]"
              checked={rejectRequeue}
              onChange={(e) => setRejectRequeue(e.target.checked)}
            />
            <span>Re-queue task as approved so Navigate can re-run it with this note</span>
          </label>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setRejectModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={rejectMutation.isPending}>
              {rejectMutation.isPending ? 'Rejecting...' : 'Confirm reject'}
            </Button>
          </div>
        </form>
      </ModalDialog>

      {/* Failed Review Override Modal */}
      <ModalDialog
        open={Boolean(overrideModalTaskId)}
        title="Merge task with failed automated review?"
        onClose={() => setOverrideModalTaskId(null)}
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Automated review did not pass for this task. You can still override Gate 2 and merge into{' '}
            <span className="font-mono-token">{guard.mainBranch}</span>, or cancel and reject it back to the coder.
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOverrideModalTaskId(null)}>
              Cancel
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
              {approveMergeMutation.isPending ? 'Merging...' : 'Override and merge'}
            </Button>
          </div>
        </div>
      </ModalDialog>
    </div>
  );
}
