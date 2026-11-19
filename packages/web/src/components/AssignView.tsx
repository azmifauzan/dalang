import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ProjectSummary } from '@dalang/shared';
import { api } from '../lib/api.js';
import { DependencyGraph } from './DependencyGraph.js';
import { EmptyPanel, ErrorPanel, LoadingPanel } from './StateViews.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';

export function AssignView({
  project,
  onGoToList,
  onGoToNavigate,
}: {
  project: ProjectSummary;
  onGoToList: () => void;
  onGoToNavigate: () => void;
}) {
  const qc = useQueryClient();
  const [allowUnconfined, setAllowUnconfined] = useState(false);
  const [viewMode, setViewMode] = useState<'table' | 'graph'>('table');

  const executionQuery = useQuery({
    queryKey: ['execution', project.id],
    queryFn: () => api.getExecutionState(project.id),
  });

  const profilesQuery = useQuery({
    queryKey: ['profiles'],
    queryFn: () => api.listProfiles(),
  });

  const routingQuery = useQuery({
    queryKey: ['routing'],
    queryFn: () => api.listRoutingRules(),
  });

  const assignMutation = useMutation({
    mutationFn: ({ taskId, profileOverride }: { taskId: string; profileOverride: string | null }) =>
      api.assignTaskProfile(project.id, taskId, profileOverride),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['execution', project.id] });
      qc.invalidateQueries({ queryKey: ['plan', project.id] });
    },
  });

  const startMutation = useMutation({
    mutationFn: () => api.startExecution(project.id, { allowUnconfined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['execution', project.id] });
      qc.invalidateQueries({ queryKey: ['plan', project.id] });
      onGoToNavigate();
    },
  });

  const execution = executionQuery.data?.execution;
  const profiles = profilesQuery.data?.profiles ?? [];
  const rules = routingQuery.data?.rules ?? [];
  const previews = execution?.dispatchPreviews ?? [];
  const providerStates = execution?.providerStates ?? [];
  const activeRunsCount = execution?.activeRuns?.length ?? (execution?.activeRun ? 1 : 0);
  const eligibleCount = previews.filter((p) => p.eligible).length;
  const doneCount = previews.filter((p) => p.status === 'done').length;

  const needsUnconfinedOptIn = Boolean(execution && !execution.sandboxReady);
  const canStart =
    Boolean(execution) &&
    execution?.planStatus === 'approved' &&
    eligibleCount > 0 &&
    !execution?.queueRunning &&
    activeRunsCount === 0 &&
    (!needsUnconfinedOptIn || allowUnconfined);

  return (
    <div className="space-y-6">
      {/* Header control bar */}
      <div
        className="flex flex-wrap items-center justify-between gap-4 rounded-md border p-4"
        style={{
          backgroundColor: 'var(--bg-surface)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold">Assign (Parallel Routing & Dispatch Queue)</h1>
            {execution && (
              <Badge>
                {doneCount} / {previews.length} done
              </Badge>
            )}
            {activeRunsCount > 0 && (
              <Badge
                style={{
                  color: 'var(--accent)',
                  borderColor: 'var(--accent)',
                  backgroundColor: 'var(--accent-tint)',
                }}
              >
                {activeRunsCount} running
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
            Verify dependency waves, non-overlapping file scopes, and agent profile routing before parallel execution starts.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" onClick={onGoToNavigate}>
            Open Navigate
          </Button>
          <Button
            type="button"
            onClick={() => startMutation.mutate()}
            disabled={!canStart || startMutation.isPending}
          >
            {startMutation.isPending
              ? 'Starting parallel run...'
              : execution?.queueRunning || activeRunsCount > 0
                ? 'Execution active'
                : 'Start parallel run'}
          </Button>
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
            Agent CLIs will run without filesystem write confinement. Acknowledge below to allow unconfined execution.
          </p>
          <Label
            htmlFor="assign-allow-unconfined"
            className="mt-2 flex min-h-[44px] cursor-pointer items-center gap-3 text-sm font-medium"
          >
            <input
              id="assign-allow-unconfined"
              type="checkbox"
              checked={allowUnconfined}
              onChange={(e) => setAllowUnconfined(e.target.checked)}
              className="h-4 w-4"
            />
            <span>Allow unconfined CLI execution on this project</span>
          </Label>
        </section>
      )}

      {executionQuery.isLoading && <LoadingPanel label="Loading dispatch queue and routing rules..." />}

      {executionQuery.isError && (
        <ErrorPanel
          title="Could not load execution state"
          detail={executionQuery.error.message}
          onRetry={() => executionQuery.refetch()}
        />
      )}

      {(assignMutation.isError || startMutation.isError) && (
        <ErrorPanel
          title="Dispatch action failed"
          detail={
            assignMutation.error?.message || startMutation.error?.message || 'Unknown error'
          }
        />
      )}

      {!executionQuery.isLoading && !executionQuery.isError && execution?.planStatus !== 'approved' && (
        <EmptyPanel
          title={execution?.planStatus === 'draft' ? 'Approve the plan first' : 'No plan generated yet'}
          description="Only approved plans can be dispatched. Review tasks, dependencies, and verify commands in List, then click Approve plan."
          action={
            <Button type="button" onClick={onGoToList}>
              Go to List
            </Button>
          }
        />
      )}

      {!executionQuery.isLoading && !executionQuery.isError && execution?.planStatus === 'approved' && (
        <div className="space-y-6">
          {/* Provider Concurrency & Quota Strip (F-12, F-13) */}
          {providerStates.length > 0 && (
            <section
              aria-label="Provider concurrency and quota status"
              className="grid grid-cols-1 gap-3 sm:grid-cols-3"
            >
              {providerStates.map((ps) => (
                <div
                  key={ps.provider}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
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
                        ? `Cooldown: ${ps.cooldownReason ?? 'rate limited'}`
                        : ps.quotaExhausted
                          ? ps.quotaReason ?? 'Quota exhausted'
                          : 'Healthy · available'}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Badge>
                      {ps.activeCount}/{ps.maxParallel} slots
                    </Badge>
                    {(ps.inCooldown || ps.quotaExhausted) && (
                      <Badge
                        style={{
                          color: 'var(--error)',
                          borderColor: 'var(--error)',
                          backgroundColor: 'var(--error-tint)',
                        }}
                      >
                        {ps.inCooldown ? 'COOLDOWN' : 'QUOTA'}
                      </Badge>
                    )}
                  </div>
                </div>
              ))}
            </section>
          )}

          {/* Task dispatch queue & dependency graph */}
          <section
            aria-labelledby="dispatch-table-heading"
            className="rounded-md border p-4"
            style={{
              backgroundColor: 'var(--bg-surface)',
              borderColor: 'var(--border-subtle)',
            }}
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 id="dispatch-table-heading" className="text-base font-semibold">
                  Approved task queue
                </h2>
                <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {eligibleCount} ready to dispatch next
                </span>
              </div>

              <div
                role="group"
                aria-label="Dispatch view mode"
                className="inline-flex rounded-[6px] border border-input bg-card p-0.5"
              >
                <button
                  type="button"
                  aria-pressed={viewMode === 'table'}
                  onClick={() => setViewMode('table')}
                  className={`min-h-11 cursor-pointer rounded-[4px] px-3 text-sm font-medium transition-colors duration-150 ${
                    viewMode === 'table'
                      ? 'bg-primary text-primary-foreground'
                      : 'text-foreground hover:bg-muted'
                  }`}
                >
                  Queue table
                </button>
                <button
                  type="button"
                  aria-pressed={viewMode === 'graph'}
                  onClick={() => setViewMode('graph')}
                  className={`min-h-11 cursor-pointer rounded-[4px] px-3 text-sm font-medium transition-colors duration-150 ${
                    viewMode === 'graph'
                      ? 'bg-primary text-primary-foreground'
                      : 'text-foreground hover:bg-muted'
                  }`}
                >
                  Dependency graph
                </button>
              </div>
            </div>

            {viewMode === 'graph' ? (
              <DependencyGraph previews={previews} onSelectTask={() => onGoToNavigate()} />
            ) : previews.length === 0 ? (
              <EmptyPanel
                title="No tasks in approved plan"
                description="This plan contains no tasks to dispatch."
              />
            ) : (
              <div
                tabIndex={0}
                role="region"
                aria-labelledby="dispatch-table-heading"
                className="overflow-x-auto"
              >
                <table className="w-full border-collapse text-left text-sm">
                  <caption className="sr-only">
                    Task dispatch readiness, parallelism waves, and assigned agent profiles
                  </caption>
                  <thead>
                    <tr
                      className="border-b text-xs uppercase"
                      style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                    >
                      <th scope="col" className="py-2.5 pr-3 font-medium">
                        Task
                      </th>
                      <th scope="col" className="py-2.5 pr-3 font-medium">
                        Role / Level
                      </th>
                      <th scope="col" className="py-2.5 pr-3 font-medium">
                        Wave / Parallel
                      </th>
                      <th scope="col" className="py-2.5 pr-3 font-medium">
                        Readiness
                      </th>
                      <th scope="col" className="py-2.5 pr-3 font-medium">
                        Assigned profile
                      </th>
                      <th scope="col" className="py-2.5 font-medium">
                        Fallback
                      </th>
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
                          className="border-b align-top"
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
                              Milestone {item.milestone}
                              {item.dependsOn.length > 0 && ` · Depends on: ${item.dependsOn.join(', ')}`}
                            </div>
                          </th>
                          <td className="py-3 pr-3 whitespace-nowrap">
                            <Badge>{item.role}</Badge>
                            <span
                              className="ml-1.5 text-xs"
                              style={{ color: 'var(--text-secondary)' }}
                            >
                              {item.complexity}
                            </span>
                          </td>
                          <td className="py-3 pr-3 text-xs">
                            <Badge>Wave {item.wave + 1}</Badge>
                            {item.overlappingTasks.length > 0 ? (
                              <p
                                className="mt-1"
                                style={{
                                  color: item.blockedByOverlapWith
                                    ? 'var(--error)'
                                    : 'var(--text-secondary)',
                                }}
                              >
                                Overlap: {item.overlappingTasks.join(', ')}
                              </p>
                            ) : (
                              <p className="mt-1" style={{ color: 'var(--text-secondary)' }}>
                                Isolated worktree
                              </p>
                            )}
                          </td>
                          <td className="py-3 pr-3">
                            <Badge
                              style={{
                                color:
                                  item.status === 'done'
                                    ? 'var(--pass)'
                                    : item.status === 'failed'
                                      ? 'var(--error)'
                                      : item.eligible
                                        ? 'var(--accent)'
                                        : 'var(--text-secondary)',
                                borderColor:
                                  item.status === 'done'
                                    ? 'var(--pass)'
                                    : item.status === 'failed'
                                      ? 'var(--error)'
                                      : 'var(--border-subtle)',
                              }}
                            >
                              {item.eligible ? 'eligible' : item.status}
                            </Badge>
                            {item.blockedReason && (
                              <p
                                className="mt-1 text-xs"
                                style={{ color: 'var(--text-secondary)' }}
                              >
                                {item.blockedReason}
                              </p>
                            )}
                          </td>
                          <td className="py-3 pr-3">
                            <Label htmlFor={selectId} className="sr-only">
                              Profile for {item.externalId}
                            </Label>
                            <NativeSelect
                              id={selectId}
                              value={currentOverride}
                              disabled={item.status === 'running' || assignMutation.isPending}
                              onChange={(e) => {
                                const val = e.target.value;
                                assignMutation.mutate({
                                  taskId: item.taskId,
                                  profileOverride: val ? val : null,
                                });
                              }}
                              className="min-w-[190px] text-sm"
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
                            <p
                              className="mt-1 text-xs"
                              style={{ color: 'var(--text-secondary)' }}
                            >
                              via {item.selectionSource.replace('_', ' ')}
                            </p>
                            {item.selectionNote && (
                              <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                                {item.selectionNote}
                              </p>
                            )}
                            {item.quotaReroutedReason && (
                              <p className="mt-1 text-xs font-medium" style={{ color: 'var(--accent)' }}>
                                Quota fallback: {item.quotaReroutedReason}
                              </p>
                            )}
                          </td>
                          <td
                            className="py-3 text-xs whitespace-nowrap"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            {item.fallbackProfileName ?? 'None'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Routing Rules reference */}
          <section
            aria-labelledby="routing-rules-heading"
            className="rounded-md border p-4"
            style={{
              backgroundColor: 'var(--bg-surface)',
              borderColor: 'var(--border-subtle)',
            }}
          >
            <h2 id="routing-rules-heading" className="text-base font-semibold">
              Active routing rules
            </h2>
            <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
              First matching rule selects the primary profile; backup profile runs automatically if the primary hits a rate limit, error, or timeout.
            </p>

            {routingQuery.isLoading ? (
              <LoadingPanel label="Loading routing rules..." />
            ) : routingQuery.isError ? (
              <ErrorPanel
                title="Could not load routing rules"
                detail={routingQuery.error.message}
              />
            ) : rules.length === 0 ? (
              <EmptyPanel
                title="No routing rules configured"
                description="Default seeded profiles will be used."
              />
            ) : (
              <div
                tabIndex={0}
                role="region"
                aria-labelledby="routing-rules-heading"
                className="mt-3 overflow-x-auto"
              >
                <table className="w-full border-collapse text-left text-sm">
                  <caption className="sr-only">Agent routing rule evaluation order</caption>
                  <thead>
                    <tr
                      className="border-b text-xs uppercase"
                      style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                    >
                      <th scope="col" className="py-2 pr-3 font-medium">
                        Order
                      </th>
                      <th scope="col" className="py-2 pr-3 font-medium">
                        Role
                      </th>
                      <th scope="col" className="py-2 pr-3 font-medium">
                        Complexity
                      </th>
                      <th scope="col" className="py-2 pr-3 font-medium">
                        Primary profile
                      </th>
                      <th scope="col" className="py-2 font-medium">
                        Fallback profile
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rules.map((rule) => (
                      <tr
                        key={rule.id}
                        className="border-b"
                        style={{ borderColor: 'var(--border-subtle)' }}
                      >
                        <th scope="row" className="py-2 pr-3 font-mono-token text-xs">
                          #{rule.sortOrder}
                        </th>
                        <td className="py-2 pr-3">{rule.role}</td>
                        <td className="py-2 pr-3">{rule.complexity ?? 'any'}</td>
                        <td className="py-2 pr-3 font-medium">{rule.profileName}</td>
                        <td className="py-2" style={{ color: 'var(--text-secondary)' }}>
                          {rule.fallbackProfileName ?? 'None'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
