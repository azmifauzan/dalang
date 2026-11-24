import { describeFallback } from './FallbackFields.js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectSummary, TaskRunDTO } from '@dalang/shared';
import { useI18n } from '../i18n/index.js';
import {
  buildInitialFeedFromRuns,
  parseNativeSubagentsFromLog,
  type ActivityFeedItem,
} from '../lib/activity.js';
import { api } from '../lib/api.js';
import { DependencyGraph } from './DependencyGraph.js';
import { EmptyPanel, ErrorPanel, LoadingPanel } from './StateViews.js';
import { WorkStage } from './WorkStage.js';
import { TaskSteering } from './TaskSteering.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';

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

export function WorkView({
  project,
  sessionId,
  liveLogsByRunId,
  liveActivity,
  onGoToPlan,
  onGoToReview,
}: {
  project: ProjectSummary;
  sessionId?: string;
  liveLogsByRunId: Record<string, string[]>;
  liveActivity: ActivityFeedItem[];
  onGoToPlan: () => void;
  onGoToReview: () => void;
}) {
  const qc = useQueryClient();
  const { t, te } = useI18n();
  const [subTab, setSubTab] = useState<'tasks' | 'routing' | 'graph'>('tasks');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [allowUnconfined, setAllowUnconfined] = useState(false);
  const [confirmRollbackRunId, setConfirmRollbackRunId] = useState<string | null>(null);
  const logPreRef = useRef<HTMLPreElement | null>(null);
  const inspectorRef = useRef<HTMLElement | null>(null);

  const executionQuery = useQuery({
    queryKey: ['execution', project.id, sessionId ?? 'default'],
    queryFn: () => api.getExecutionState(project.id, sessionId),
    refetchInterval: (query) => {
      const ex = query.state.data?.execution;
      if (!ex) return false;
      return (ex.activeRuns?.length ?? 0) > 0 || ex.activeRun || ex.queueRunning ? 2500 : false;
    },
  });

  const profilesQuery = useQuery({
    queryKey: ['profiles'],
    queryFn: () => api.listProfiles(),
  });

  const routingQuery = useQuery({
    queryKey: ['routing'],
    queryFn: () => api.listRoutingRules(),
  });

  const execution = executionQuery.data?.execution;
  const profiles = profilesQuery.data?.profiles ?? [];
  const rules = routingQuery.data?.rules ?? [];
  const previews = execution?.dispatchPreviews ?? [];
  const runs = execution?.runs ?? [];
  const activeRuns = execution?.activeRuns ?? (execution?.activeRun ? [execution.activeRun] : []);
  const providerStates = execution?.providerStates ?? [];
  const hasActiveExecution = activeRuns.length > 0 || Boolean(execution?.queueRunning);

  const combinedFeed = useMemo(() => {
    const projectLive = liveActivity.filter((item) => item.projectId === project.id);
    if (projectLive.length > 0) return projectLive;
    return buildInitialFeedFromRuns(runs);
  }, [liveActivity, project.id, runs]);

  useEffect(() => {
    if (!execution) return;
    if (selectedTaskId) {
      const runningForSelected = activeRuns.find((r) => r.taskId === selectedTaskId);
      if (runningForSelected && runningForSelected.id !== selectedRunId) {
        setSelectedRunId(runningForSelected.id);
      }
      return;
    }
    if (activeRuns.length > 0) {
      setSelectedTaskId(activeRuns[0].taskId);
      setSelectedRunId(activeRuns[0].id);
      return;
    }
    if (previews.length > 0) {
      const firstRunTask = runs[0]?.taskId ?? previews[0].taskId;
      setSelectedTaskId(firstRunTask);
    }
  }, [activeRuns.map((r) => r.id).join(','), previews.length, selectedTaskId]);

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
    mutationFn: () => api.startExecution(project.id, { sessionId, allowUnconfined }),
    onSuccess: (res) => {
      if (res.run) {
        setSelectedTaskId(res.run.taskId);
        setSelectedRunId(res.run.id);
      }
      qc.invalidateQueries({ queryKey: ['execution', project.id] });
      qc.invalidateQueries({ queryKey: ['plan', project.id] });
      qc.invalidateQueries({ queryKey: ['sessions', project.id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
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
      qc.invalidateQueries({ queryKey: ['sessions', project.id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  const stopMutation = useMutation({
    mutationFn: (taskId?: string) =>
      api.stopExecution(project.id, taskId ? { taskId, sessionId } : { sessionId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['execution', project.id] });
      qc.invalidateQueries({ queryKey: ['plan', project.id] });
      qc.invalidateQueries({ queryKey: ['sessions', project.id] });
    },
  });

  const rollbackMutation = useMutation({
    mutationFn: (runId: string) => api.rollbackRun(project.id, runId),
    onSuccess: () => {
      setConfirmRollbackRunId(null);
      qc.invalidateQueries({ queryKey: ['execution', project.id] });
      qc.invalidateQueries({ queryKey: ['plan', project.id] });
      qc.invalidateQueries({ queryKey: ['sessions', project.id] });
    },
  });

  const assignMutation = useMutation({
    mutationFn: ({ taskId, profileOverride }: { taskId: string; profileOverride: string | null }) =>
      api.assignTaskProfile(project.id, taskId, profileOverride),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['execution', project.id] });
      qc.invalidateQueries({ queryKey: ['plan', project.id] });
    },
  });

  const topLevelPreviews = previews.filter((p) => p.delegationDepth === 0);
  const subtasksByParentId = useMemo(() => {
    const map = new Map<string, typeof previews>();
    for (const p of previews) {
      if (p.delegationDepth > 0 && p.parentTaskId) {
        const list = map.get(p.parentTaskId) ?? [];
        list.push(p);
        map.set(p.parentTaskId, list);
      }
    }
    return map;
  }, [previews]);
  const doneCount = topLevelPreviews.filter((p) => p.status === 'done').length;
  const eligibleCount = topLevelPreviews.filter((p) => p.eligible).length;
  const needsUnconfinedOptIn = Boolean(execution && !execution.sandboxReady);
  const canStartQueue =
    Boolean(execution) &&
    execution?.planStatus === 'approved' &&
    eligibleCount > 0 &&
    !hasActiveExecution &&
    (!needsUnconfinedOptIn || allowUnconfined);

  const liveLines = inspectedRun ? (liveLogsByRunId[inspectedRun.id] ?? []) : [];
  const displayedLogText =
    inspectedRun?.status === 'running'
      ? liveLines.join('\n')
      : logQuery.data?.content || liveLines.join('\n');
  const nativeSubagents = useMemo(
    () => parseNativeSubagentsFromLog(displayedLogText),
    [displayedLogText],
  );
  const selectedSubtasks = selectedTask ? (subtasksByParentId.get(selectedTask.taskId) ?? []) : [];

  useEffect(() => {
    if (inspectedRun?.status === 'running' && logPreRef.current) {
      logPreRef.current.scrollTop = logPreRef.current.scrollHeight;
    }
  }, [inspectedRun?.status, liveLines.length]);

  const handleStageSelectTask = (taskId: string) => {
    setSubTab('tasks');
    setSelectedTaskId(taskId);
    const activeForTask = activeRuns.find((r) => r.taskId === taskId);
    const latestForTask = runs.find((r) => r.taskId === taskId);
    setSelectedRunId(activeForTask?.id ?? latestForTask?.id ?? null);
    setConfirmRollbackRunId(null);
    inspectorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  return (
    <div className="space-y-5">
      {/* Work header bar */}
      <div
        className="flex flex-wrap items-center justify-between gap-4 rounded-[8px] border p-4"
        style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
      >
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">{t('work.title')}</h2>
            {execution && (
              <Badge style={hasActiveExecution ? statusColors('running') : undefined}>
                {doneCount} / {topLevelPreviews.length}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
            {t('work.subtitle')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" onClick={onGoToReview}>
            {t('work.openReview')}
          </Button>
          {hasActiveExecution ? (
            <Button
              type="button"
              variant="destructive"
              onClick={() => stopMutation.mutate(undefined)}
              disabled={stopMutation.isPending}
            >
              {stopMutation.isPending
                ? t('work.stopping')
                : activeRuns.length > 1
                  ? t('work.stopAll')
                  : t('work.stopRun')}
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => startQueueMutation.mutate()}
              disabled={!canStartQueue || startQueueMutation.isPending}
            >
              {startQueueMutation.isPending ? t('work.starting') : t('work.startRun')}
            </Button>
          )}
        </div>
      </div>

      {needsUnconfinedOptIn && execution && (
        <section
          aria-label={t('work.sandboxNotice')}
          className="rounded-[8px] border p-4"
          style={{ backgroundColor: 'var(--error-tint)', borderColor: 'var(--error)' }}
        >
          <p className="text-sm font-semibold" style={{ color: 'var(--error)' }}>
            {t('work.sandboxTitle', { platform: execution.platform })}
          </p>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-primary)' }}>
            {t('work.sandboxDesc')}
          </p>
          <Label
            htmlFor="work-allow-unconfined"
            className="mt-2 flex min-h-[44px] cursor-pointer items-center gap-3 text-sm font-medium"
          >
            <input
              id="work-allow-unconfined"
              type="checkbox"
              checked={allowUnconfined}
              onChange={(e) => setAllowUnconfined(e.target.checked)}
              className="h-4 w-4 accent-[var(--primary)]"
            />
            <span>{t('work.sandboxOptIn')}</span>
          </Label>
        </section>
      )}

      {executionQuery.isLoading && <LoadingPanel label={t('work.loading')} />}
      {executionQuery.isError && (
        <ErrorPanel
          title={t('work.loadError')}
          detail={executionQuery.error.message}
          onRetry={() => executionQuery.refetch()}
        />
      )}

      {(startQueueMutation.isError ||
        runTaskMutation.isError ||
        stopMutation.isError ||
        rollbackMutation.isError ||
        assignMutation.isError) && (
        <ErrorPanel
          title={t('work.actionError')}
          detail={
            startQueueMutation.error?.message ||
            runTaskMutation.error?.message ||
            stopMutation.error?.message ||
            rollbackMutation.error?.message ||
            assignMutation.error?.message ||
            t('common.unknownError')
          }
        />
      )}

      {!executionQuery.isLoading && !executionQuery.isError && execution?.planStatus !== 'approved' && (
        <EmptyPanel
          title={t('work.emptyPlanTitle')}
          description={t('work.emptyPlanDesc')}
          action={
            <Button type="button" onClick={onGoToPlan}>
              {t('work.goToPlan')}
            </Button>
          }
        />
      )}

      {!executionQuery.isLoading && !executionQuery.isError && execution?.planStatus === 'approved' && (
        <div className="space-y-5">
          {/* Wayang Kelir Stage + Factual Activity Feed */}
          <WorkStage
            activeRuns={activeRuns}
            previews={previews}
            providerStates={providerStates}
            activityFeed={combinedFeed}
            onSelectTask={handleStageSelectTask}
          />

          {/* Sub-view tabs: Tasks & live logs | Routing & queue | Dependency graph */}
          <div
            role="tablist"
            aria-label={t('work.title')}
            className="inline-flex flex-wrap gap-1 rounded-[6px] border p-1"
            style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
          >
            {(
              [
                { id: 'tasks', label: t('work.tab.tasks') },
                { id: 'routing', label: t('work.tab.routing') },
                { id: 'graph', label: t('work.tab.graph') },
              ] as const
            ).map((tabItem) => (
              <button
                key={tabItem.id}
                type="button"
                role="tab"
                aria-selected={subTab === tabItem.id}
                onClick={() => setSubTab(tabItem.id)}
                className="min-h-[44px] cursor-pointer rounded-[4px] px-3.5 text-sm font-medium transition-colors duration-150"
                style={{
                  backgroundColor: subTab === tabItem.id ? 'var(--accent)' : 'transparent',
                  color: subTab === tabItem.id ? 'var(--accent-ink)' : 'var(--text-primary)',
                }}
              >
                {tabItem.label}
              </button>
            ))}
          </div>

          {/* SUB-TAB 1: TASKS & LIVE LOGS */}
          {subTab === 'tasks' && (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
              {/* Left column: task cards */}
              <section aria-labelledby="work-tasks-heading" className="min-w-0 space-y-3 lg:col-span-5">
                <div className="flex items-center justify-between gap-2">
                  <h3 id="work-tasks-heading" className="text-base font-semibold">
                    {t('work.tasksHeading', { count: topLevelPreviews.length })}
                  </h3>
                  <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {t('work.waveOrder')}
                  </span>
                </div>

                <ul className="space-y-3">
                  {topLevelPreviews.map((task) => {
                    const taskHistory = runs.filter((r) => r.taskId === task.taskId);
                    const latestRun = taskHistory[0] ?? null;
                    const resumableRun =
                      taskHistory.find(
                        (r) => Boolean(r.cliSessionId) && r.provider === task.resolvedProvider,
                      ) ?? null;
                    const isSelected = selectedTaskId === task.taskId;
                    const activeForThisTask = activeRuns.find((r) => r.taskId === task.taskId) ?? null;
                    const isRunningThis = Boolean(activeForThisTask) || task.status === 'running';
                    const blockedBySandbox = needsUnconfinedOptIn && !allowUnconfined;
                    const canRunFresh =
                      !isRunningThis &&
                      !blockedBySandbox &&
                      !task.blockedByOverlapWith &&
                      task.dependenciesSatisfied &&
                      task.status !== 'reviewing' &&
                      task.status !== 'awaiting_merge';
                    const canResume =
                      canRunFresh &&
                      Boolean(resumableRun) &&
                      (task.status === 'stopped' || task.status === 'failed');
                    const childSubtasks = subtasksByParentId.get(task.taskId) ?? [];

                    return (
                      <li
                        key={task.taskId}
                        className="rounded-[6px] border p-4"
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
                              setSelectedRunId(activeForThisTask?.id ?? latestRun?.id ?? null);
                              setConfirmRollbackRunId(null);
                            }}
                            className="min-h-[44px] flex-1 cursor-pointer text-left"
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono-token text-xs font-bold">
                                [{task.externalId}]
                              </span>
                              <span className="text-sm font-semibold">{task.title}</span>
                            </div>
                            <div
                              className="mt-1 flex flex-wrap items-center gap-1.5 text-xs"
                              style={{ color: 'var(--text-secondary)' }}
                            >
                              <span>{t('graph.waveLabel', { n: task.wave + 1 })}</span>
                              <span>·</span>
                              <span>{task.milestone}</span>
                              <span>·</span>
                              <span>
                                {task.resolvedProfileName} ({task.resolvedProvider})
                              </span>
                            </div>
                          </button>
                          <Badge style={statusColors(task.status)}>{te(task.status)}</Badge>
                        </div>

                        {task.quotaReroutedReason && (
                          <p className="mt-2 text-xs font-medium" style={{ color: 'var(--accent)' }}>
                            {t('work.quotaFallback', { reason: task.quotaReroutedReason })}
                          </p>
                        )}

                        {task.blockedReason && task.status !== 'running' && task.status !== 'done' && (
                          <p className="mt-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                            {task.blockedReason}
                          </p>
                        )}

                        {activeForThisTask?.canSteer && <TaskSteering key={activeForThisTask.id} run={activeForThisTask} />}
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          {isRunningThis ? (
                            <Button
                              type="button"
                              variant="destructive"
                              onClick={() => stopMutation.mutate(task.taskId)}
                              disabled={stopMutation.isPending}
                            >
                              {t('work.stopTask')}
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
                                  ? t('work.retryTask')
                                  : t('work.runTask')}
                              </Button>
                              {(task.status === 'awaiting_merge' ||
                                task.status === 'review_failed' ||
                                task.status === 'reviewing' ||
                                task.status === 'done') && (
                                <Button type="button" variant="outline" onClick={onGoToReview}>
                                  {t('work.openReview')}
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
                                  {t('work.resumeSession')}
                                </Button>
                              )}
                            </>
                          )}
                        </div>

                        {childSubtasks.length > 0 && (
                          <div
                            className="mt-3 space-y-2 border-t pt-3"
                            style={{ borderColor: 'var(--border-subtle)' }}
                          >
                            <div
                              className="text-xs font-semibold uppercase tracking-wide"
                              style={{ color: 'var(--text-secondary)' }}
                            >
                              {t('work.delegatedSubtasks', { count: childSubtasks.length })}
                            </div>
                            <ul className="space-y-1.5">
                              {childSubtasks.map((sub) => {
                                const subActive = activeRuns.find((r) => r.taskId === sub.taskId) ?? null;
                                const subLatest = runs.find((r) => r.taskId === sub.taskId) ?? null;
                                const subSelected = selectedTaskId === sub.taskId;
                                return (
                                  <li key={sub.taskId}>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setSelectedTaskId(sub.taskId);
                                        setSelectedRunId(subActive?.id ?? subLatest?.id ?? null);
                                        setConfirmRollbackRunId(null);
                                      }}
                                      className="flex min-h-[44px] w-full cursor-pointer flex-wrap items-center justify-between gap-2 rounded-[4px] border px-2.5 py-1.5 text-left text-xs transition-colors duration-150"
                                      style={{
                                        backgroundColor: subSelected ? 'var(--bg-well)' : 'transparent',
                                        borderColor: subSelected ? 'var(--accent)' : 'var(--border-subtle)',
                                      }}
                                    >
                                      <span className="min-w-0 flex-1">
                                        <span className="font-mono-token font-bold">
                                          [{sub.externalId}]
                                        </span>{' '}
                                        <span className="font-medium">{sub.title}</span>
                                        <span
                                          className="ml-1.5 font-mono-token"
                                          style={{ color: 'var(--text-secondary)' }}
                                        >
                                          ({sub.resolvedProfileName} · {sub.resolvedProvider})
                                        </span>
                                      </span>
                                      <Badge style={statusColors(sub.status)}>{te(sub.status)}</Badge>
                                    </button>
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>

              {/* Right column: Run inspector & logs */}
              <section
                ref={inspectorRef}
                aria-labelledby="work-inspector-heading"
                className="min-w-0 space-y-4 lg:col-span-7"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 id="work-inspector-heading" className="text-base font-semibold">
                    {t('work.inspectorHeading')}
                  </h3>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {taskRuns.length > 1 &&
                      taskRuns.map((r) => (
                        <Button
                          key={r.id}
                          type="button"
                          variant={inspectedRun?.id === r.id ? 'default' : 'outline'}
                          onClick={() => setSelectedRunId(r.id)}
                        >
                          {t('work.attempt', { n: r.attempt })}
                        </Button>
                      ))}
                  </div>
                </div>

                {!inspectedRun ? (
                  <EmptyPanel
                    title={
                      selectedTask
                        ? t('work.noRunsForTask', { id: selectedTask.externalId })
                        : t('work.noRunsTitle')
                    }
                    description={t('work.noRunsDesc')}
                  />
                ) : (
                  <div
                    className="space-y-4 rounded-[6px] border p-4"
                    style={{
                      backgroundColor: 'var(--bg-surface)',
                      borderColor: 'var(--border-subtle)',
                    }}
                  >
                    <div
                      className="flex flex-wrap items-start justify-between gap-3 border-b pb-3"
                      style={{ borderColor: 'var(--border-subtle)' }}
                    >
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono-token text-xs font-bold">
                            [{inspectedRun.taskExternalId}]
                          </span>
                          <h4 className="text-sm font-semibold">{inspectedRun.taskTitle}</h4>
                          <Badge>{te(inspectedRun.kind)}</Badge>
                          <Badge style={statusColors(inspectedRun.status)}>{te(inspectedRun.status)}</Badge>
                          {inspectedRun.usedFallback && <Badge>{t('common.fallbackBadge')}</Badge>}
                        </div>
                        <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                          {inspectedRun.profileName} ({inspectedRun.provider}
                          {inspectedRun.model ? `/${inspectedRun.model}` : ''}) · #{inspectedRun.attempt} ·{' '}
                          {formatDuration(inspectedRun.durationMs)}
                          {inspectedRun.exitCode !== null ? ` · exit ${inspectedRun.exitCode}` : ''}
                        </p>
                        <p className="mt-1 font-mono-token text-xs" style={{ color: 'var(--text-secondary)' }}>
                          Checkpoint: {inspectedRun.commitBefore?.slice(0, 7) ?? 'none'} -&gt;{' '}
                          {inspectedRun.commitAfter?.slice(0, 7) ?? 'pending'}
                          {inspectedRun.branchName ? ` · ${inspectedRun.branchName}` : ''}
                        </p>
                      </div>

                      {inspectedRun.commitBefore &&
                        inspectedRun.status !== 'running' &&
                        inspectedRun.status !== 'rolled_back' &&
                        !activeRuns.some((r) => r.taskId === inspectedRun.taskId) && (
                          <div>
                            {confirmRollbackRunId === inspectedRun.id ? (
                              <div className="flex flex-wrap items-center gap-2">
                                <Button
                                  type="button"
                                  variant="destructive"
                                  disabled={rollbackMutation.isPending}
                                  onClick={() => rollbackMutation.mutate(inspectedRun.id)}
                                >
                                  {rollbackMutation.isPending
                                    ? t('work.rollingBack')
                                    : t('work.confirmRollback')}
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  onClick={() => setConfirmRollbackRunId(null)}
                                >
                                  {t('common.cancel')}
                                </Button>
                              </div>
                            ) : (
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => setConfirmRollbackRunId(inspectedRun.id)}
                              >
                                {t('work.rollback')}
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
                        <p className="font-semibold">{t('work.scopeWarnings')}</p>
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
                        <p className="font-semibold">{t('work.resultSummary')}</p>
                        <p>{inspectedRun.result.summary}</p>
                        {inspectedRun.result.changed_files.length > 0 && (
                          <p className="font-mono-token text-xs" style={{ color: 'var(--text-secondary)' }}>
                            {t('work.changedFiles', {
                              files: inspectedRun.result.changed_files.join(', '),
                            })}
                          </p>
                        )}
                      </div>
                    )}

                    {selectedSubtasks.length > 0 && (
                      <div
                        className="space-y-2 rounded border p-3 text-xs"
                        style={{
                          backgroundColor: 'var(--bg-well)',
                          borderColor: 'var(--border-subtle)',
                        }}
                      >
                        <p className="font-semibold">
                          {t('work.delegatedSubtasks', { count: selectedSubtasks.length })}
                        </p>
                        <ul className="space-y-1.5">
                          {selectedSubtasks.map((sub) => {
                            const subActive = activeRuns.find((r) => r.taskId === sub.taskId) ?? null;
                            const subLatest = runs.find((r) => r.taskId === sub.taskId) ?? null;
                            return (
                              <li key={sub.taskId}>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSelectedTaskId(sub.taskId);
                                    setSelectedRunId(subActive?.id ?? subLatest?.id ?? null);
                                  }}
                                  className="flex min-h-[44px] w-full cursor-pointer flex-wrap items-center justify-between gap-2 rounded-[4px] border px-2.5 py-1.5 text-left"
                                  style={{
                                    backgroundColor: 'var(--bg-surface)',
                                    borderColor: 'var(--border-subtle)',
                                  }}
                                >
                                  <span>
                                    <span className="font-mono-token font-bold">[{sub.externalId}]</span>{' '}
                                    {sub.title} · {sub.resolvedProfileName} ({sub.resolvedProvider})
                                  </span>
                                  <Badge style={statusColors(sub.status)}>{te(sub.status)}</Badge>
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    )}

                    {nativeSubagents.length > 0 && (
                      <div
                        className="space-y-2 rounded border p-3 text-xs"
                        style={{
                          backgroundColor: 'var(--bg-well)',
                          borderColor: 'var(--border-subtle)',
                        }}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="font-semibold">
                            {t('work.nativeSubagentsTitle', { count: nativeSubagents.length })}
                          </p>
                          <Badge>{t('work.readOnlyBadge')}</Badge>
                        </div>
                        <ul className="space-y-1.5">
                          {nativeSubagents.map((entry) => (
                            <li
                              key={entry.id}
                              className="flex flex-wrap items-start justify-between gap-2 rounded-[4px] border px-2.5 py-1.5"
                              style={{
                                backgroundColor: 'var(--bg-surface)',
                                borderColor: 'var(--border-subtle)',
                              }}
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="font-mono-token font-semibold">
                                    [{entry.source === 'claude' ? 'Claude' : 'Antigravity'} · {entry.toolName}]
                                  </span>
                                  <span className="font-medium">{entry.label}</span>
                                </div>
                                {entry.detail && (
                                  <p
                                    className="mt-0.5 truncate"
                                    style={{ color: 'var(--text-secondary)' }}
                                    title={entry.detail}
                                  >
                                    {entry.detail}
                                  </p>
                                )}
                              </div>
                              <Badge style={statusColors(entry.status)}>{te(entry.status)}</Badge>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <div>
                      <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
                        <span className="font-medium">{t('work.cliLog')}</span>
                        <span className="truncate font-mono-token" style={{ color: 'var(--text-secondary)' }}>
                          {inspectedRun.logPath}
                        </span>
                      </div>
                      <pre
                        ref={logPreRef}
                        className="max-h-[400px] overflow-auto rounded border p-3 font-mono-token text-xs break-words whitespace-pre-wrap"
                        style={{
                          backgroundColor: 'var(--bg-canvas)',
                          borderColor: 'var(--border-subtle)',
                          color: 'var(--text-primary)',
                        }}
                      >
                        {logQuery.isLoading && inspectedRun.status !== 'running'
                          ? t('work.loadingLog')
                          : displayedLogText || t('work.waitingLog')}
                      </pre>
                    </div>
                  </div>
                )}

                {runs.length > 0 && (
                  <div
                    className="rounded-[6px] border p-4"
                    style={{
                      backgroundColor: 'var(--bg-surface)',
                      borderColor: 'var(--border-subtle)',
                    }}
                  >
                    <h4 className="text-sm font-semibold">
                      {t('work.runArchive', { count: runs.length })}
                    </h4>
                    <ul className="mt-2 space-y-2">
                      {runs.slice(0, 12).map((r) => (
                        <li key={r.id}>
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedTaskId(r.taskId);
                              setSelectedRunId(r.id);
                            }}
                            className="flex min-h-[44px] w-full cursor-pointer flex-wrap items-center justify-between gap-2 rounded border px-3 py-2 text-left text-xs"
                            style={{
                              backgroundColor:
                                inspectedRun?.id === r.id ? 'var(--bg-well)' : 'transparent',
                              borderColor:
                                inspectedRun?.id === r.id ? 'var(--accent)' : 'var(--border-subtle)',
                            }}
                          >
                            <span>
                              <span className="font-mono-token font-bold">[{r.taskExternalId}]</span>{' '}
                              {r.profileName} ({r.provider}) · {te(r.kind)} · #{r.attempt}
                              {r.usedFallback ? ' [fallback]' : ''}
                            </span>
                            <span className="flex items-center gap-2">
                              <span style={{ color: 'var(--text-secondary)' }}>
                                {formatDuration(r.durationMs)}
                              </span>
                              <Badge style={statusColors(r.status)}>{te(r.status)}</Badge>
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

          {/* SUB-TAB 2: ROUTING & QUEUE (Preserves all AssignView actions) */}
          {subTab === 'routing' && (
            <div className="space-y-5">
              {providerStates.length > 0 && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  {providerStates.map((ps) => (
                    <div
                      key={ps.accountKey}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-[6px] border p-3"
                      style={{
                        backgroundColor: 'var(--bg-surface)',
                        borderColor:
                          ps.inCooldown || ps.quotaExhausted
                            ? 'var(--error)'
                            : ps.activeCount > 0
                              ? 'var(--accent)'
                              : 'var(--border-subtle)',
                      }}
                    >
                      <div>
                        <div className="font-mono-token text-xs font-semibold uppercase">
                          {ps.provider}
                        </div>
                        <div className="mt-0.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
                          {ps.inCooldown
                            ? ps.cooldownReason ?? t('work.stageCooldown')
                            : ps.quotaExhausted
                              ? ps.quotaReason ?? t('common.quotaExhausted')
                              : t('work.providerAvailable')}
                        </div>
                      </div>
                      <Badge>
                        {t('work.slotsActive', { active: ps.activeCount, max: ps.maxParallel })}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}

              <section
                aria-labelledby="work-queue-heading"
                className="rounded-[6px] border p-4"
                style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
              >
                <div className="mb-3">
                  <h3 id="work-queue-heading" className="text-base font-semibold">
                    {t('work.queueHeading')}
                  </h3>
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {t('work.readyToDispatch', { count: eligibleCount })}
                  </p>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-left text-sm">
                    <thead>
                      <tr
                        className="border-b text-xs uppercase"
                        style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                      >
                        <th className="py-2.5 pr-3 font-medium">{t('work.colTask')}</th>
                        <th className="py-2.5 pr-3 font-medium">{t('work.colRoleLevel')}</th>
                        <th className="py-2.5 pr-3 font-medium">{t('work.colWaveParallel')}</th>
                        <th className="py-2.5 pr-3 font-medium">{t('work.colReadiness')}</th>
                        <th className="py-2.5 pr-3 font-medium">{t('work.colProfile')}</th>
                        <th className="py-2.5 font-medium">{t('work.colFallback')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {previews.map((item) => {
                        const selectId = `assign-profile-${item.taskId}`;
                        const currentOverride =
                          item.selectionSource === 'override' ? item.resolvedProfileId : '';
                        return (
                          <tr
                            key={item.taskId}
                            className="border-b align-top last:border-b-0"
                            style={{ borderColor: 'var(--border-subtle)' }}
                          >
                            <th scope="row" className="py-3 pr-3 font-normal">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-mono-token text-xs font-bold">
                                  [{item.externalId}]
                                </span>
                                <span className="font-medium">{item.title}</span>
                              </div>
                              <div className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                                {item.milestone}
                                {item.dependsOn.length > 0 && ` · ${item.dependsOn.join(', ')}`}
                              </div>
                            </th>
                            <td className="py-3 pr-3 whitespace-nowrap">
                              <Badge>{te(item.role)}</Badge>
                              <span className="ml-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
                                {te(item.complexity)}
                              </span>
                            </td>
                            <td className="py-3 pr-3 text-xs">
                              <Badge>{t('graph.waveLabel', { n: item.wave + 1 })}</Badge>
                              <p
                                className="mt-1"
                                style={{
                                  color: item.blockedByOverlapWith
                                    ? 'var(--error)'
                                    : 'var(--text-secondary)',
                                }}
                              >
                                {item.overlappingTasks.length > 0
                                  ? t('work.overlapWith', { tasks: item.overlappingTasks.join(', ') })
                                  : t('work.isolatedWorktree')}
                              </p>
                            </td>
                            <td className="py-3 pr-3">
                              <Badge style={statusColors(item.eligible ? 'running' : item.status)}>
                                {item.eligible ? te('eligible') : te(item.status)}
                              </Badge>
                              {item.blockedReason && (
                                <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                                  {item.blockedReason}
                                </p>
                              )}
                            </td>
                            <td className="py-3 pr-3">
                              <Label htmlFor={selectId} className="sr-only">
                                {item.externalId}
                              </Label>
                              <NativeSelect
                                id={selectId}
                                value={currentOverride}
                                disabled={item.status === 'running' || assignMutation.isPending}
                                onChange={(e) =>
                                  assignMutation.mutate({
                                    taskId: item.taskId,
                                    profileOverride: e.target.value || null,
                                  })
                                }
                                className="min-w-[180px] text-sm"
                              >
                                <option value="">
                                  Auto ({item.resolvedProfileName} · {item.resolvedProvider})
                                </option>
                                {profiles.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {p.name} ({p.provider}
                                    {p.model ? `/${p.model}` : ''})
                                  </option>
                                ))}
                              </NativeSelect>
                            </td>
                            <td className="py-3 text-xs whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
                              {describeFallback(item.fallback, t('common.cliDefault')) ?? t('common.none')}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>

              {rules.length > 0 && (
                <section
                  className="rounded-[6px] border p-4"
                  style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
                >
                  <h3 className="text-base font-semibold">{t('work.activeRulesHeading')}</h3>
                  <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {t('work.activeRulesDesc')}
                  </p>
                  <ul className="mt-3 space-y-1.5 text-xs">
                    {rules.map((r, i) => (
                      <li key={r.id} className="flex flex-wrap items-center gap-2">
                        <Badge>#{i + 1}</Badge>
                        <span className="font-mono-token">
                          {te(r.role)} ({r.complexity ? te(r.complexity) : t('common.any').toLowerCase()})
                        </span>
                        <span>→</span>
                        <strong>{r.profileName}</strong>
                        {r.fallback && (
                          <span style={{ color: 'var(--text-secondary)' }}>
                            ({t('work.colFallback')}: {describeFallback(r.fallback, t('common.cliDefault'))})
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}

          {/* SUB-TAB 3: DEPENDENCY GRAPH */}
          {subTab === 'graph' && (
            <DependencyGraph
              previews={previews}
              selectedTaskId={selectedTaskId}
              onSelectTask={handleStageSelectTask}
            />
          )}
        </div>
      )}
    </div>
  );
}
