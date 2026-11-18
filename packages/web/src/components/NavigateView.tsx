import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { ProjectSummary, TaskRunDTO } from '@dalang/shared';
import { api } from '../lib/api.js';
import { EmptyPanel, ErrorPanel, LoadingPanel } from './StateViews.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

function formatDuration(ms: number | null): string {
  if (ms === null) return 'running';
  if (ms < 1000) return `${ms} ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m ${rem}s`;
}

function statusColors(status: string): { color: string; borderColor: string } {
  if (status === 'done' || status === 'completed') {
    return { color: 'var(--pass)', borderColor: 'var(--pass)' };
  }
  if (status === 'failed' || status === 'review_failed') {
    return { color: 'var(--error)', borderColor: 'var(--error)' };
  }
  if (status === 'running' || status === 'reviewing' || status === 'awaiting_merge') {
    return { color: 'var(--accent)', borderColor: 'var(--accent)' };
  }
  return { color: 'var(--text-secondary)', borderColor: 'var(--border-subtle)' };
}

export function NavigateView({
  project,
  liveLogsByRunId,
  onGoToList,
  onGoToAssign,
  onGoToGuard,
}: {
  project: ProjectSummary;
  liveLogsByRunId: Record<string, string[]>;
  onGoToList: () => void;
  onGoToAssign: () => void;
  onGoToGuard?: () => void;
}) {
  const qc = useQueryClient();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [allowUnconfined, setAllowUnconfined] = useState(false);
  const [confirmRollbackRunId, setConfirmRollbackRunId] = useState<string | null>(null);
  const logPreRef = useRef<HTMLPreElement | null>(null);

  const executionQuery = useQuery({
    queryKey: ['execution', project.id],
    queryFn: () => api.getExecutionState(project.id),
    refetchInterval: (query) => (query.state.data?.execution.activeRun ? 2500 : false),
  });

  const execution = executionQuery.data?.execution;
  const previews = execution?.dispatchPreviews ?? [];
  const runs = execution?.runs ?? [];

  // Keep selected task & run synced to active run or first task
  useEffect(() => {
    if (!execution) return;
    if (execution.activeRun) {
      setSelectedTaskId(execution.activeRun.taskId);
      setSelectedRunId(execution.activeRun.id);
      return;
    }
    if (!selectedTaskId && previews.length > 0) {
      const firstRunTask = runs[0]?.taskId ?? previews[0].taskId;
      setSelectedTaskId(firstRunTask);
    }
  }, [execution?.activeRun?.id, previews.length]);

  const taskRuns = selectedTaskId ? runs.filter((r) => r.taskId === selectedTaskId) : runs;
  const inspectedRun: TaskRunDTO | null =
    taskRuns.find((r) => r.id === selectedRunId) ?? taskRuns[0] ?? null;
  const selectedTask = previews.find((p) => p.taskId === selectedTaskId) ?? null;

  const logQuery = useQuery({
    queryKey: ['run-log', project.id, inspectedRun?.id],
    queryFn: () => api.getRunLog(project.id, inspectedRun!.id),
    enabled: Boolean(inspectedRun && inspectedRun.status !== 'running'),
  });

  const startQueueMutation = useMutation({
    mutationFn: () => api.startExecution(project.id, { allowUnconfined }),
    onSuccess: (res) => {
      if (res.run) {
        setSelectedTaskId(res.run.taskId);
        setSelectedRunId(res.run.id);
      }
      qc.invalidateQueries({ queryKey: ['execution', project.id] });
      qc.invalidateQueries({ queryKey: ['plan', project.id] });
    },
  });

  const runTaskMutation = useMutation({
    mutationFn: ({ taskId, resumeSession }: { taskId: string; resumeSession?: boolean }) =>
      api.runTask(project.id, taskId, { allowUnconfined, resumeSession }),
    onSuccess: (res) => {
      if (res.run) {
        setSelectedTaskId(res.run.taskId);
        setSelectedRunId(res.run.id);
      }
      qc.invalidateQueries({ queryKey: ['execution', project.id] });
      qc.invalidateQueries({ queryKey: ['plan', project.id] });
    },
  });

  const stopMutation = useMutation({
    mutationFn: () => api.stopExecution(project.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['execution', project.id] });
      qc.invalidateQueries({ queryKey: ['plan', project.id] });
    },
  });

  const rollbackMutation = useMutation({
    mutationFn: (runId: string) => api.rollbackRun(project.id, runId),
    onSuccess: () => {
      setConfirmRollbackRunId(null);
      qc.invalidateQueries({ queryKey: ['execution', project.id] });
      qc.invalidateQueries({ queryKey: ['plan', project.id] });
    },
  });

  const doneCount = previews.filter((p) => p.status === 'done').length;
  const eligibleCount = previews.filter((p) => p.eligible).length;
  const needsUnconfinedOptIn = Boolean(execution && !execution.sandboxReady);
  const canStartQueue =
    Boolean(execution) &&
    execution?.planStatus === 'approved' &&
    eligibleCount > 0 &&
    !execution?.activeRun &&
    (!needsUnconfinedOptIn || allowUnconfined);

  const liveLines = inspectedRun ? (liveLogsByRunId[inspectedRun.id] ?? []) : [];
  const displayedLogText =
    inspectedRun?.status === 'running'
      ? liveLines.join('\n')
      : logQuery.data?.content || liveLines.join('\n');

  useEffect(() => {
    if (inspectedRun?.status === 'running' && logPreRef.current) {
      logPreRef.current.scrollTop = logPreRef.current.scrollHeight;
    }
  }, [inspectedRun?.status, liveLines.length]);

  return (
    <div className="space-y-5">
      {/* Execution header bar */}
      <div
        className="flex flex-wrap items-center justify-between gap-4 rounded-md border p-4"
        style={{
          backgroundColor: 'var(--bg-surface)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold">Navigate (Sequential Execution & Live Logs)</h1>
            {execution && (
              <Badge style={execution.activeRun ? statusColors('running') : undefined}>
                {execution.activeRun
                  ? `RUNNING ${execution.activeRun.taskExternalId}`
                  : `${doneCount} / ${previews.length} DONE`}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
            Execute one approved task at a time with pre/post git checkpoints, live CLI logs, stop, retry, and session resume.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" onClick={onGoToAssign}>
            Back to Assign
          </Button>
          {onGoToGuard && (
            <Button type="button" variant="outline" onClick={onGoToGuard}>
              Open Guard
            </Button>
          )}
          {execution?.activeRun ? (
            <Button
              type="button"
              variant="destructive"
              onClick={() => stopMutation.mutate()}
              disabled={stopMutation.isPending}
            >
              {stopMutation.isPending ? 'Stopping...' : 'Stop active run'}
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => startQueueMutation.mutate()}
              disabled={!canStartQueue || startQueueMutation.isPending}
            >
              {startQueueMutation.isPending ? 'Starting...' : 'Run sequential queue'}
            </Button>
          )}
        </div>
      </div>

      {needsUnconfinedOptIn && execution && (
        <section
          aria-label="Sandbox notice"
          className="rounded-md border p-4"
          style={{
            backgroundColor: 'var(--error-tint)',
            borderColor: 'var(--error)',
          }}
        >
          <p className="text-sm font-semibold" style={{ color: 'var(--error)' }}>
            Bubblewrap sandbox unavailable on {execution.platform}
          </p>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-primary)' }}>
            Tasks will execute without filesystem write isolation unless you opt in.
          </p>
          <Label
            htmlFor="navigate-allow-unconfined"
            className="mt-2 flex min-h-[44px] cursor-pointer items-center gap-3 text-sm font-medium"
          >
            <input
              id="navigate-allow-unconfined"
              type="checkbox"
              checked={allowUnconfined}
              onChange={(e) => setAllowUnconfined(e.target.checked)}
              className="h-4 w-4"
            />
            <span>Allow unconfined CLI execution</span>
          </Label>
        </section>
      )}

      {executionQuery.isLoading && <LoadingPanel label="Loading task runs and execution state..." />}

      {executionQuery.isError && (
        <ErrorPanel
          title="Could not load execution state"
          detail={executionQuery.error.message}
          onRetry={() => executionQuery.refetch()}
        />
      )}

      {(startQueueMutation.isError ||
        runTaskMutation.isError ||
        stopMutation.isError ||
        rollbackMutation.isError) && (
        <ErrorPanel
          title="Execution error"
          detail={
            startQueueMutation.error?.message ||
            runTaskMutation.error?.message ||
            stopMutation.error?.message ||
            rollbackMutation.error?.message ||
            'Unknown error'
          }
        />
      )}

      {!executionQuery.isLoading && !executionQuery.isError && execution?.planStatus !== 'approved' && (
        <EmptyPanel
          title="No approved plan ready for Navigate"
          description="Approve your task plan in List first, then verify routing in Assign before executing tasks here."
          action={
            <Button type="button" onClick={onGoToList}>
              Go to List
            </Button>
          }
        />
      )}

      {!executionQuery.isLoading && !executionQuery.isError && execution?.planStatus === 'approved' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* Left column: Task execution cards */}
          <section aria-labelledby="nav-tasks-heading" className="min-w-0 space-y-3 lg:col-span-5">
            <div className="flex items-center justify-between gap-2">
              <h2 id="nav-tasks-heading" className="text-base font-semibold">
                Tasks ({previews.length})
              </h2>
              <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                Sequential order
              </span>
            </div>

            {previews.length === 0 ? (
              <EmptyPanel
                title="No tasks in plan"
                description="Add tasks in List before running Navigate."
              />
            ) : (
              <ul className="space-y-3">
                {previews.map((task) => {
                  const taskHistory = runs.filter((r) => r.taskId === task.taskId);
                  const latestRun = taskHistory[0] ?? null;
                  const resumableRun =
                    taskHistory.find(
                      (r) => Boolean(r.cliSessionId) && r.provider === task.resolvedProvider,
                    ) ?? null;
                  const isSelected = selectedTaskId === task.taskId;
                  const isRunningThis = execution.activeRun?.taskId === task.taskId;
                  const anotherRunning = Boolean(execution.activeRun) && !isRunningThis;
                  const blockedBySandbox = needsUnconfinedOptIn && !allowUnconfined;
                  const canRunFresh =
                    !anotherRunning &&
                    !isRunningThis &&
                    !blockedBySandbox &&
                    task.dependenciesSatisfied &&
                    task.status !== 'running' &&
                    task.status !== 'reviewing' &&
                    task.status !== 'awaiting_merge';
                  const canResume =
                    canRunFresh &&
                    Boolean(resumableRun) &&
                    (task.status === 'stopped' || task.status === 'failed');

                  return (
                    <li
                      key={task.taskId}
                      className="rounded-md border p-4"
                      style={{
                        backgroundColor: 'var(--bg-surface)',
                        borderColor: isSelected ? 'var(--accent)' : 'var(--border-subtle)',
                      }}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedTaskId(task.taskId);
                            setSelectedRunId(latestRun?.id ?? null);
                            setConfirmRollbackRunId(null);
                          }}
                          className="min-h-[44px] flex-1 text-left"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono-token text-xs font-bold">
                              [{task.externalId}]
                            </span>
                            <span className="text-sm font-semibold">{task.title}</span>
                          </div>
                          <div
                            className="mt-1 flex flex-wrap items-center gap-2 text-xs"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            <span>{task.milestone}</span>
                            <span>{task.resolvedProfileName}</span>
                            <span>({task.resolvedProvider})</span>
                            {task.dependsOn.length > 0 && (
                              <span>deps: {task.dependsOn.join(', ')}</span>
                            )}
                          </div>
                        </button>

                        <Badge style={statusColors(task.status)}>{task.status}</Badge>
                      </div>

                      {task.blockedReason && task.status !== 'running' && task.status !== 'done' && (
                        <p className="mt-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                          {task.blockedReason}
                        </p>
                      )}

                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {isRunningThis ? (
                          <Button
                            type="button"
                            variant="destructive"
                            onClick={() => stopMutation.mutate()}
                            disabled={stopMutation.isPending}
                          >
                            Stop
                          </Button>
                        ) : (
                          <>
                            <Button
                              type="button"
                              variant={task.eligible ? 'default' : 'outline'}
                              disabled={!canRunFresh || runTaskMutation.isPending}
                              onClick={() =>
                                runTaskMutation.mutate({
                                  taskId: task.taskId,
                                  resumeSession: false,
                                })
                              }
                            >
                              {task.status === 'failed' ||
                              task.status === 'review_failed' ||
                              task.status === 'stopped' ||
                              task.status === 'done'
                                ? 'Retry'
                                : 'Run task'}
                            </Button>
                            {onGoToGuard &&
                              (task.status === 'awaiting_merge' ||
                                task.status === 'review_failed' ||
                                task.status === 'reviewing' ||
                                task.status === 'done') && (
                                <Button type="button" variant="outline" onClick={onGoToGuard}>
                                  Open Guard
                                </Button>
                              )}
                            {canResume && (
                              <Button
                                type="button"
                                variant="outline"
                                disabled={runTaskMutation.isPending}
                                onClick={() =>
                                  runTaskMutation.mutate({
                                    taskId: task.taskId,
                                    resumeSession: true,
                                  })
                                }
                              >
                                Resume session
                              </Button>
                            )}
                          </>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Right column: Run inspector, live logs, result, and rollback */}
          <section aria-labelledby="nav-inspector-heading" className="min-w-0 space-y-4 lg:col-span-7">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="nav-inspector-heading" className="text-base font-semibold">
                Run inspector & live logs
              </h2>
              {taskRuns.length > 1 && (
                <div className="flex flex-wrap gap-1.5">
                  {taskRuns.map((r) => (
                    <Button
                      key={r.id}
                      type="button"
                      variant={inspectedRun?.id === r.id ? 'default' : 'outline'}
                      onClick={() => setSelectedRunId(r.id)}
                    >
                      Attempt #{r.attempt}
                    </Button>
                  ))}
                </div>
              )}
            </div>

            {!inspectedRun ? (
              <EmptyPanel
                title={
                  selectedTask
                    ? `No runs yet for [${selectedTask.externalId}]`
                    : 'No task run recorded yet'
                }
                description={
                  selectedTask
                    ? `Click Run task on [${selectedTask.externalId}] (${selectedTask.title}), or start the sequential queue to stream live CLI logs here.`
                    : 'Select an eligible task and click Run task, or start the sequential queue to stream live CLI logs here.'
                }
              />
            ) : (
              <div
                className="space-y-4 rounded-md border p-4"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  borderColor: 'var(--border-subtle)',
                }}
              >
                {/* Run metadata */}
                <div
                  className="flex flex-wrap items-start justify-between gap-3 border-b pb-3"
                  style={{ borderColor: 'var(--border-subtle)' }}
                >
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono-token text-xs font-bold">
                        [{inspectedRun.taskExternalId}]
                      </span>
                      <h3 className="text-sm font-semibold">{inspectedRun.taskTitle}</h3>
                      <Badge>{inspectedRun.kind}</Badge>
                      <Badge style={statusColors(inspectedRun.status)}>{inspectedRun.status}</Badge>
                      {inspectedRun.usedFallback && <Badge>Fallback</Badge>}
                    </div>
                    <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                      Profile: {inspectedRun.profileName} ({inspectedRun.provider}
                      {inspectedRun.model ? `/${inspectedRun.model}` : ''}) · Attempt #{inspectedRun.attempt} ·{' '}
                      Duration: {formatDuration(inspectedRun.durationMs)}
                      {inspectedRun.exitCode !== null ? ` · Exit ${inspectedRun.exitCode}` : ''}
                    </p>
                    <p className="mt-1 font-mono-token text-xs" style={{ color: 'var(--text-secondary)' }}>
                      Checkpoint: {inspectedRun.commitBefore?.slice(0, 7) ?? 'none'} -&gt;{' '}
                      {inspectedRun.commitAfter?.slice(0, 7) ?? 'pending'}
                    </p>
                  </div>

                  {inspectedRun.commitBefore &&
                    inspectedRun.status !== 'running' &&
                    inspectedRun.status !== 'rolled_back' &&
                    !execution.activeRun && (
                      <div>
                        {confirmRollbackRunId === inspectedRun.id ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              type="button"
                              variant="destructive"
                              disabled={rollbackMutation.isPending}
                              onClick={() => rollbackMutation.mutate(inspectedRun.id)}
                            >
                              {rollbackMutation.isPending ? 'Rolling back...' : 'Confirm rollback'}
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              onClick={() => setConfirmRollbackRunId(null)}
                            >
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => setConfirmRollbackRunId(inspectedRun.id)}
                          >
                            Rollback to pre-run checkpoint
                          </Button>
                        )}
                      </div>
                    )}
                </div>

                {inspectedRun.failureReason && (
                  <div
                    role="alert"
                    className="rounded border px-3 py-2 text-sm"
                    style={{
                      backgroundColor: 'var(--error-tint)',
                      borderColor: 'var(--error)',
                      color: 'var(--error)',
                    }}
                  >
                    {inspectedRun.failureReason}
                  </div>
                )}

                {inspectedRun.scopeWarnings.length > 0 && (
                  <div
                    role="alert"
                    className="rounded border px-3 py-2 text-xs"
                    style={{
                      backgroundColor: 'var(--accent-tint)',
                      borderColor: 'var(--accent)',
                      color: 'var(--text-primary)',
                    }}
                  >
                    <p className="font-semibold">Scope warnings (outside files_allowed):</p>
                    <ul className="mt-1 list-disc pl-4">
                      {inspectedRun.scopeWarnings.map((w) => (
                        <li key={w} className="font-mono-token">
                          {w}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {inspectedRun.result && (
                  <div
                    className="space-y-2 rounded border p-3 text-sm"
                    style={{
                      backgroundColor: 'var(--bg-well)',
                      borderColor: 'var(--border-subtle)',
                    }}
                  >
                    <p className="font-semibold">Task result summary</p>
                    <p>{inspectedRun.result.summary}</p>
                    {inspectedRun.result.changed_files.length > 0 && (
                      <p className="font-mono-token text-xs" style={{ color: 'var(--text-secondary)' }}>
                        Changed files: {inspectedRun.result.changed_files.join(', ')}
                      </p>
                    )}
                    {inspectedRun.result.verify_command && (
                      <p className="font-mono-token text-xs" style={{ color: 'var(--text-secondary)' }}>
                        Verify: {inspectedRun.result.verify_command} (exit{' '}
                        {inspectedRun.result.verify_exit_code ?? 'n/a'})
                      </p>
                    )}
                    {inspectedRun.result.notes.length > 0 && (
                      <ul className="list-disc pl-4 text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {inspectedRun.result.notes.map((n, idx) => (
                          <li key={idx}>{n}</li>
                        ))}
                      </ul>
                    )}
                    {inspectedRun.result.blockers.length > 0 && (
                      <ul className="list-disc pl-4 text-xs" style={{ color: 'var(--error)' }}>
                        {inspectedRun.result.blockers.map((b, idx) => (
                          <li key={idx}>Blocker: {b}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {/* Live / Archived CLI output log */}
                <div>
                  <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium">CLI output log</span>
                    <span className="truncate font-mono-token" style={{ color: 'var(--text-secondary)' }}>
                      {inspectedRun.logPath}
                    </span>
                  </div>
                  <pre
                    ref={logPreRef}
                    className="max-h-[420px] overflow-auto rounded border p-3 font-mono-token text-xs break-words whitespace-pre-wrap"
                    style={{
                      backgroundColor: 'var(--bg-canvas)',
                      borderColor: 'var(--border-subtle)',
                      color: 'var(--text-primary)',
                    }}
                  >
                    {logQuery.isLoading && inspectedRun.status !== 'running'
                      ? 'Loading persisted log...'
                      : displayedLogText || 'Waiting for CLI output...'}
                  </pre>
                </div>
              </div>
            )}

            {/* Run archive across project (F-23) */}
            {runs.length > 0 && (
              <div
                className="rounded-md border p-4"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  borderColor: 'var(--border-subtle)',
                }}
              >
                <h3 className="text-sm font-semibold">Run archive ({runs.length})</h3>
                <ul className="mt-2 space-y-2">
                  {runs.slice(0, 12).map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedTaskId(r.taskId);
                          setSelectedRunId(r.id);
                        }}
                        className="flex min-h-[44px] w-full flex-wrap items-center justify-between gap-2 rounded border px-3 py-2 text-left text-xs"
                        style={{
                          backgroundColor:
                            inspectedRun?.id === r.id ? 'var(--bg-well)' : 'transparent',
                          borderColor:
                            inspectedRun?.id === r.id ? 'var(--accent)' : 'var(--border-subtle)',
                        }}
                      >
                        <span>
                          <span className="font-mono-token font-bold">[{r.taskExternalId}]</span>{' '}
                          {r.profileName} ({r.provider}) · {r.kind} · #{r.attempt}
                          {r.usedFallback ? ' [fallback]' : ''}
                        </span>
                        <span className="flex items-center gap-2">
                          <span style={{ color: 'var(--text-secondary)' }}>
                            {formatDuration(r.durationMs)}
                          </span>
                          <Badge style={statusColors(r.status)}>{r.status}</Badge>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
