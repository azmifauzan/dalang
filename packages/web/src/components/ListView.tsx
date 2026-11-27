import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type DragEvent, type FormEvent } from 'react';
import {
  analyzePlanDependencies,
  formatPlanDependencySummary,
  type AgentProfileDTO,
  type CreateTaskInput,
  type EditableTaskStatus,
  type PlanTaskRole,
  type ProjectSummary,
  type TaskComplexity,
  type TaskDTO,
  type TaskOutputKind,
  type TaskStatus,
} from '@dalang/shared';
import { useI18n } from '../i18n/index.js';
import { api } from '../lib/api.js';
import { DependencyGraph } from './DependencyGraph.js';
import { EmptyPanel, ErrorPanel, LoadingPanel, ModalDialog } from './StateViews.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';

const EXECUTION_STATUSES = new Set<TaskStatus>([
  'approved',
  'running',
  'reviewing',
  'awaiting_merge',
  'review_failed',
  'done',
  'failed',
  'stopped',
]);

function linesToArray(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

interface TaskFormState {
  id?: string;
  externalId?: string;
  title: string;
  milestone: string;
  role: PlanTaskRole;
  complexity: TaskComplexity;
  output: TaskOutputKind;
  status: EditableTaskStatus;
  goal: string;
  filesAllowed: string;
  filesReference: string;
  acceptanceCriteria: string;
  verify: string;
  needsSplit: boolean;
  profileOverride: string;
  dependsOn: string[];
}

function emptyTaskForm(defaultMilestone = 'M1'): TaskFormState {
  return {
    title: '',
    milestone: defaultMilestone,
    role: 'engineer',
    complexity: 'low',
    output: 'files',
    status: 'ready',
    goal: '',
    filesAllowed: '',
    filesReference: 'PROJECT.md',
    acceptanceCriteria: '',
    verify: '',
    needsSplit: false,
    profileOverride: '',
    dependsOn: [],
  };
}

function taskToForm(task: TaskDTO, profiles: AgentProfileDTO[]): TaskFormState {
  const matchedProfile = task.profileOverride
    ? profiles.find((p) => p.id === task.profileOverride || p.name === task.profileOverride)
    : undefined;
  return {
    id: task.id,
    externalId: task.externalId,
    title: task.title,
    milestone: task.milestone,
    role: task.role,
    complexity: task.complexity,
    output: task.output ?? 'files',
    status:
      task.status === 'draft' || task.status === 'needs_split' || task.status === 'ready'
        ? task.status
        : 'ready',
    goal: task.goal,
    filesAllowed: task.filesAllowed.join('\n'),
    filesReference: task.filesReference.join('\n'),
    acceptanceCriteria: task.acceptanceCriteria.join('\n'),
    verify: task.verify ?? '',
    needsSplit: task.needsSplit,
    profileOverride: matchedProfile?.id ?? task.profileOverride ?? '',
    dependsOn: task.dependsOn,
  };
}

export function ListView({
  project,
  sessionId,
  onGoToAgree,
  onGoToWork,
}: {
  project: ProjectSummary;
  sessionId?: string;
  onGoToAgree: () => void;
  onGoToWork?: () => void;
}) {
  const qc = useQueryClient();
  const { t, te } = useI18n();
  const [milestoneFilter, setMilestoneFilter] = useState<string>('ALL');
  const [viewMode, setViewMode] = useState<'kanban' | 'graph'>('kanban');
  const [modalOpen, setModalOpen] = useState(false);
  const [formState, setFormState] = useState<TaskFormState>(emptyTaskForm());
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [liveStatusAnnouncement, setLiveStatusAnnouncement] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const columns: Array<{ id: TaskStatus; title: string; note: string }> = [
    { id: 'draft', title: t('plan.col.draft'), note: t('plan.col.draftNote') },
    { id: 'needs_split', title: t('plan.col.needs_split'), note: t('plan.col.needs_splitNote') },
    { id: 'ready', title: t('plan.col.ready'), note: t('plan.col.readyNote') },
    { id: 'approved', title: t('plan.col.approved'), note: t('plan.col.approvedNote') },
  ];

  const planQuery = useQuery({
    queryKey: ['plan', project.id, sessionId ?? 'default'],
    queryFn: () => api.getPlan(project.id, sessionId),
  });

  const profilesQuery = useQuery({
    queryKey: ['profiles'],
    queryFn: () => api.listProfiles(),
  });

  const generateMutation = useMutation({
    mutationFn: () => api.generatePlan(project.id, sessionId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plan', project.id] });
      qc.invalidateQueries({ queryKey: ['sessions', project.id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  const approvePlanMutation = useMutation({
    mutationFn: () => api.approvePlan(project.id, sessionId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plan', project.id] });
      qc.invalidateQueries({ queryKey: ['execution', project.id] });
      qc.invalidateQueries({ queryKey: ['sessions', project.id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  const createTaskMutation = useMutation({
    mutationFn: (body: CreateTaskInput) => api.createTask(project.id, body, sessionId),
    onSuccess: () => {
      setModalOpen(false);
      qc.invalidateQueries({ queryKey: ['plan', project.id] });
      qc.invalidateQueries({ queryKey: ['sessions', project.id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  const updateTaskMutation = useMutation({
    mutationFn: ({ taskId, body }: { taskId: string; body: Partial<CreateTaskInput> }) =>
      api.updateTask(project.id, taskId, body, sessionId),
    onSuccess: () => {
      setModalOpen(false);
      qc.invalidateQueries({ queryKey: ['plan', project.id] });
    },
  });

  const deleteTaskMutation = useMutation({
    mutationFn: (taskId: string) => api.deleteTask(project.id, taskId, sessionId),
    onSuccess: () => {
      setModalOpen(false);
      qc.invalidateQueries({ queryKey: ['plan', project.id] });
      qc.invalidateQueries({ queryKey: ['sessions', project.id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  const reorderMutation = useMutation({
    mutationFn: (updates: Array<{ id: string; status?: EditableTaskStatus; position: number }>) =>
      api.reorderTasks(project.id, { updates }, sessionId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plan', project.id] });
    },
  });

  const plan = planQuery.data?.plan ?? null;
  const profiles = profilesQuery.data?.profiles ?? [];
  const isLocked = plan?.status === 'approved';
  const hasApprovedBrief = project.latestBriefStatus === 'approved';

  const visibleTasks = (plan?.tasks ?? []).filter(
    (task) => milestoneFilter === 'ALL' || task.milestone === milestoneFilter,
  );

  const openCreateModal = () => {
    setFormState(emptyTaskForm(plan?.milestones[0]?.id ?? ''));
    setFormError(null);
    setConfirmingDelete(false);
    setModalOpen(true);
  };

  const openEditModal = (task: TaskDTO) => {
    setFormState(taskToForm(task, profiles));
    setFormError(null);
    setConfirmingDelete(false);
    setModalOpen(true);
  };

  const handleSaveTask = (e: FormEvent) => {
    e.preventDefault();
    const criteria = linesToArray(formState.acceptanceCriteria);
    if (criteria.length === 0) {
      setFormError(t('plan.incompleteError'));
      return;
    }
    setFormError(null);
    const payload: CreateTaskInput = {
      title: formState.title.trim(),
      milestone: formState.milestone,
      role: formState.role,
      complexity: formState.complexity,
      output: formState.output,
      status: formState.status,
      goal: formState.goal.trim(),
      filesAllowed: formState.output === 'answer' ? [] : linesToArray(formState.filesAllowed),
      filesReference: linesToArray(formState.filesReference),
      acceptanceCriteria: criteria,
      verify: formState.verify.trim() || null,
      needsSplit: formState.status === 'needs_split',
      profileOverride: formState.profileOverride || null,
      dependsOn: formState.dependsOn,
    };

    if (formState.id) {
      updateTaskMutation.mutate({ taskId: formState.id, body: payload });
    } else {
      createTaskMutation.mutate(payload);
    }
  };

  const moveTaskInColumn = (colTasks: TaskDTO[], index: number, delta: -1 | 1) => {
    if (!plan || isLocked) return;
    const targetIdx = index + delta;
    if (targetIdx < 0 || targetIdx >= colTasks.length) return;
    const reordered = [...colTasks];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(targetIdx, 0, moved);
    const updates = reordered.map((tk, pos) => ({ id: tk.id, position: pos }));
    reorderMutation.mutate(updates);
    setLiveStatusAnnouncement(
      `Moved ${moved.externalId} ${moved.title} to position ${targetIdx + 1} of ${reordered.length}`,
    );
  };

  const moveTaskToStatus = (task: TaskDTO, nextStatus: EditableTaskStatus) => {
    if (!plan || isLocked || task.status === nextStatus) return;
    const targetCol = (plan.tasks ?? []).filter((tk) => tk.status === nextStatus);
    reorderMutation.mutate([{ id: task.id, status: nextStatus, position: targetCol.length }]);
    setLiveStatusAnnouncement(`Moved ${task.externalId} to ${nextStatus}`);
  };

  const handleDropOnColumn = (e: DragEvent<HTMLElement>, targetStatus: TaskStatus) => {
    e.preventDefault();
    if (!draggedTaskId || !plan || isLocked || targetStatus === 'approved') return;
    const task = plan.tasks.find((tk) => tk.id === draggedTaskId);
    setDraggedTaskId(null);
    if (task && task.status !== targetStatus) {
      moveTaskToStatus(task, targetStatus as EditableTaskStatus);
    }
  };

  return (
    <div className="space-y-5">
      <div className="sr-only" role="status" aria-live="polite">
        {liveStatusAnnouncement}
      </div>

      {/* Header bar */}
      <div
        className="flex flex-wrap items-center justify-between gap-4 rounded-[8px] border p-4"
        style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
      >
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">{t('plan.title')}</h2>
            {plan && (
              <Badge
                style={{
                  color: isLocked ? 'var(--pass)' : 'var(--text-primary)',
                  borderColor: isLocked ? 'var(--pass)' : 'var(--border-subtle)',
                }}
              >
                v{plan.version} · {plan.status.toUpperCase()}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
            {t('plan.subtitle')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {plan && plan.milestones.length > 0 && (
            <div>
              <Label htmlFor="milestone-filter" className="sr-only">
                {t('plan.filterMilestone')}
              </Label>
              <NativeSelect
                id="milestone-filter"
                value={milestoneFilter}
                onChange={(e) => setMilestoneFilter(e.target.value)}
                className="w-auto"
              >
                <option value="ALL">{t('plan.allMilestones', { count: plan.tasks.length })}</option>
                {plan.milestones.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}: {m.title}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}

          {plan && (
            <div
              role="group"
              aria-label={t('plan.title')}
              className="inline-flex rounded-[6px] border border-input bg-card p-0.5"
            >
              <button
                type="button"
                aria-pressed={viewMode === 'kanban'}
                onClick={() => setViewMode('kanban')}
                className={`min-h-11 cursor-pointer rounded-[4px] px-3 text-sm font-medium transition-colors duration-150 ${
                  viewMode === 'kanban'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-foreground hover:bg-muted'
                }`}
              >
                {t('plan.viewKanban')}
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
                {t('plan.viewGraph')}
              </button>
            </div>
          )}

          {/* With no plan yet, the single "make the plan" button is in the panel below. */}
          {plan && !isLocked && (
            <Button
              type="button"
              onClick={() => generateMutation.mutate()}
              disabled={generateMutation.isPending || !hasApprovedBrief}
              variant="outline"
            >
              {generateMutation.isPending ? t('plan.generating') : t('plan.regenerate')}
            </Button>
          )}

          {plan && !isLocked && (
            <>
              <Button type="button" onClick={openCreateModal} variant="outline">
                {t('plan.addTask')}
              </Button>
              <Button
                type="button"
                onClick={() => approvePlanMutation.mutate()}
                disabled={approvePlanMutation.isPending}
              >
                {approvePlanMutation.isPending ? t('plan.approving') : t('plan.approvePlan')}
              </Button>
            </>
          )}

          {plan && isLocked && onGoToWork && (
            <Button type="button" onClick={onGoToWork}>
              {t('plan.openWork')}
            </Button>
          )}
        </div>
      </div>

      {planQuery.isLoading && <LoadingPanel label={t('plan.loading')} />}

      {planQuery.isError && (
        <ErrorPanel
          title={t('plan.loadError')}
          detail={planQuery.error.message}
          onRetry={() => planQuery.refetch()}
        />
      )}

      {(generateMutation.isError || approvePlanMutation.isError) && (
        <ErrorPanel
          title={t('plan.actionFailed')}
          detail={
            generateMutation.error?.message ||
            approvePlanMutation.error?.message ||
            t('common.unknownError')
          }
        />
      )}

      {!planQuery.isLoading && !planQuery.isError && !plan && (
        <EmptyPanel
          title={hasApprovedBrief ? t('plan.emptyReadyTitle') : t('plan.emptyNeedBriefTitle')}
          description={hasApprovedBrief ? t('plan.emptyReadyDesc') : t('plan.emptyNeedBriefDesc')}
          action={
            hasApprovedBrief ? (
              <Button
                type="button"
                onClick={() => generateMutation.mutate()}
                disabled={generateMutation.isPending}
              >
                {generateMutation.isPending ? t('plan.generating') : t('plan.generateNow')}
              </Button>
            ) : (
              <Button type="button" onClick={onGoToAgree}>
                {t('plan.openBrief')}
              </Button>
            )
          }
        />
      )}

      {plan && plan.tasks.length > 1 && (() => {
        const analysis = analyzePlanDependencies(
          plan.tasks.map((tk) => ({ externalId: tk.externalId, title: tk.title, dependsOn: tk.dependsOn })),
        );
        const summary = formatPlanDependencySummary(analysis);
        if (!summary) return null;
        return (
          <div
            data-testid="plan-critical-path"
            className="rounded-[6px] border px-4 py-2.5 text-xs"
            style={{ backgroundColor: 'var(--bg-well)', borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
          >
            <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>
              Plan shape:
            </span>{' '}
            {summary}
          </div>
        );
      })()}

      {plan && viewMode === 'graph' && (
        <DependencyGraph
          tasks={visibleTasks}
          onSelectTask={(taskId) => {
            const found = visibleTasks.find((tk) => tk.id === taskId);
            if (found) openEditModal(found);
          }}
          emptyMessage={t('plan.noTasksMatchFilter')}
        />
      )}

      {plan && viewMode === 'kanban' && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {columns.map((col) => {
            const colTasks = visibleTasks
              .filter((tk) =>
                col.id === 'approved' ? EXECUTION_STATUSES.has(tk.status) : tk.status === col.id,
              )
              .sort((a, b) => a.position - b.position);

            return (
              <section
                key={col.id}
                aria-label={col.title}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => handleDropOnColumn(e, col.id)}
                className="flex flex-col rounded-[6px] border p-3"
                style={{
                  backgroundColor: 'var(--bg-well)',
                  borderColor: 'var(--border-subtle)',
                  minHeight: '240px',
                }}
              >
                <div className="mb-3 flex items-baseline justify-between gap-2 px-1">
                  <div>
                    <h3 className="text-sm font-semibold">{col.title}</h3>
                    <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                      {col.note}
                    </p>
                  </div>
                  <Badge>{colTasks.length}</Badge>
                </div>

                {colTasks.length === 0 ? (
                  <div
                    className="flex flex-1 items-center justify-center rounded border border-dashed p-4 text-center text-xs"
                    style={{
                      borderColor: 'var(--border-control)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    {t('plan.noTasksInCol', { col: col.title })}
                  </div>
                ) : (
                  <ul className="space-y-3">
                    {colTasks.map((task, idx) => (
                      <li
                        key={task.id}
                        draggable={!isLocked}
                        onDragStart={() => setDraggedTaskId(task.id)}
                        onDragEnd={() => setDraggedTaskId(null)}
                        className="rounded-[6px] border p-3"
                        style={{
                          backgroundColor: 'var(--bg-surface)',
                          borderColor: 'var(--border-subtle)',
                        }}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <Badge>{task.externalId}</Badge>
                          <div className="flex flex-wrap items-center gap-1 text-xs">
                            {task.output === 'answer' && <Badge>{te('answer')}</Badge>}
                            {task.status !== col.id && <Badge>{te(task.status)}</Badge>}
                            <Badge>{task.milestone}</Badge>
                            <Badge>{te(task.complexity)}</Badge>
                          </div>
                        </div>

                        <h4 className="mt-2 text-sm font-semibold">{task.title}</h4>
                        <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                          {task.goal}
                        </p>

                        <div className="mt-2 space-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                          <div>
                            {t('plan.roleLabel')}: <strong>{te(task.role)}</strong> · {t('plan.profileLabel')}:{' '}
                            <strong>
                              {(task.profileOverride &&
                                profiles.find(
                                  (p) =>
                                    p.id === task.profileOverride ||
                                    p.name === task.profileOverride,
                                )?.name) ||
                                task.profileOverride ||
                                t('plan.routingDefault')}
                            </strong>
                          </div>
                          {task.dependsOn.length > 0 && (
                            <div className="font-mono-token">
                              {t('plan.dependsOn', { deps: task.dependsOn.join(', ') })}
                            </div>
                          )}
                          <div
                            className="truncate font-mono-token"
                            title={task.verify ?? t('plan.verifySkipped')}
                          >
                            {task.verify ? t('plan.verify', { cmd: task.verify }) : t('plan.verifySkipped')}
                          </div>
                        </div>

                        <div
                          className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-2"
                          style={{ borderColor: 'var(--border-subtle)' }}
                        >
                          <Button
                            type="button"
                            onClick={() => openEditModal(task)}
                            className="text-xs"
                            variant="outline"
                          >
                            {isLocked ? t('common.inspect') : t('common.edit')}
                          </Button>

                          {!isLocked && (
                            <div className="flex items-center gap-1">
                              <Button
                                type="button"
                                onClick={() => moveTaskInColumn(colTasks, idx, -1)}
                                disabled={idx === 0 || reorderMutation.isPending}
                                className="px-2 text-xs"
                                aria-label={`Move ${task.externalId} up`}
                                variant="outline"
                              >
                                {t('common.up')}
                              </Button>
                              <Button
                                type="button"
                                onClick={() => moveTaskInColumn(colTasks, idx, 1)}
                                disabled={idx === colTasks.length - 1 || reorderMutation.isPending}
                                className="px-2 text-xs"
                                aria-label={`Move ${task.externalId} down`}
                                variant="outline"
                              >
                                {t('common.down')}
                              </Button>
                            </div>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}

      <ModalDialog
        open={modalOpen}
        title={formState.id ? t('plan.taskTitle', { id: formState.externalId ?? '' }) : t('plan.newTask')}
        onClose={() => setModalOpen(false)}
      >
        <form onSubmit={handleSaveTask} className="space-y-4">
          <div>
            <Label htmlFor="task-title" className="block text-sm font-medium">
              {t('plan.fieldTitle')}
            </Label>
            <Input
              id="task-title"
              type="text"
              required
              disabled={isLocked}
              value={formState.title}
              onChange={(e) => setFormState({ ...formState, title: e.target.value })}
              className="mt-1"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="task-milestone" className="block text-sm font-medium">
                {t('plan.fieldMilestone')}
              </Label>
              <NativeSelect
                id="task-milestone"
                required
                disabled={isLocked}
                value={formState.milestone}
                onChange={(e) => setFormState({ ...formState, milestone: e.target.value })}
                className="mt-1"
              >
                {(plan?.milestones ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}: {m.title}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div>
              <Label htmlFor="task-role" className="block text-sm font-medium">
                {t('plan.fieldRole')}
              </Label>
              <NativeSelect
                id="task-role"
                disabled={isLocked}
                value={formState.role}
                onChange={(e) =>
                  setFormState({ ...formState, role: e.target.value as PlanTaskRole })
                }
                className="mt-1"
              >
                <option value="engineer">{te('engineer')}</option>
                <option value="qa">{te('qa')}</option>
              </NativeSelect>
            </div>
            <div>
              <Label htmlFor="task-complexity" className="block text-sm font-medium">
                {t('plan.fieldComplexity')}
              </Label>
              <NativeSelect
                id="task-complexity"
                disabled={isLocked}
                value={formState.complexity}
                onChange={(e) =>
                  setFormState({ ...formState, complexity: e.target.value as TaskComplexity })
                }
                className="mt-1"
              >
                <option value="low">{te('low')}</option>
                <option value="medium">{te('medium')}</option>
                <option value="high">{te('high')}</option>
              </NativeSelect>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="task-status" className="block text-sm font-medium">
                {t('plan.fieldStatus')}
              </Label>
              <NativeSelect
                id="task-status"
                disabled={isLocked}
                value={formState.status}
                onChange={(e) =>
                  setFormState({ ...formState, status: e.target.value as EditableTaskStatus })
                }
                className="mt-1"
              >
                {columns
                  .filter((c) => c.id !== 'approved')
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
              </NativeSelect>
            </div>

            <div>
              <Label htmlFor="task-output" className="block text-sm font-medium">
                {t('plan.fieldOutput')}
              </Label>
              <NativeSelect
                id="task-output"
                disabled={isLocked}
                value={formState.output}
                onChange={(e) =>
                  setFormState({ ...formState, output: e.target.value as TaskOutputKind })
                }
                className="mt-1"
              >
                <option value="files">{t('plan.output.files')}</option>
                <option value="answer">{t('plan.output.answer')}</option>
              </NativeSelect>
            </div>

            <div>
              <Label htmlFor="task-profile" className="block text-sm font-medium">
                {t('plan.fieldProfile')}
              </Label>
              <NativeSelect
                id="task-profile"
                disabled={isLocked}
                value={formState.profileOverride}
                onChange={(e) => setFormState({ ...formState, profileOverride: e.target.value })}
                className="mt-1"
              >
                <option value="">{t('plan.useRoutingDefault')}</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.provider})
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>

          <div>
            <Label htmlFor="task-goal" className="block text-sm font-medium">
              {t('plan.fieldGoal')}
            </Label>
            <Textarea
              id="task-goal"
              rows={2}
              required
              disabled={isLocked}
              value={formState.goal}
              onChange={(e) => setFormState({ ...formState, goal: e.target.value })}
              className="mt-1"
            />
          </div>

          <div>
            <Label htmlFor="task-verify" className="block text-sm font-medium">
              {t('plan.fieldVerify')}
            </Label>
            <Input
              id="task-verify"
              type="text"
              disabled={isLocked}
              value={formState.verify}
              onChange={(e) => setFormState({ ...formState, verify: e.target.value })}
              placeholder={t('plan.fieldVerifyPlaceholder')}
              className="mt-1 font-mono-token text-sm"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="task-allowed" className="block text-sm font-medium">
                {t('plan.fieldAllowed')}
              </Label>
              <Textarea
                id="task-allowed"
                rows={3}
                disabled={isLocked}
                value={formState.filesAllowed}
                onChange={(e) => setFormState({ ...formState, filesAllowed: e.target.value })}
                className="mt-1 font-mono-token text-xs"
              />
            </div>
            <div>
              <Label htmlFor="task-ref" className="block text-sm font-medium">
                {t('plan.fieldReference')}
              </Label>
              <Textarea
                id="task-ref"
                rows={3}
                disabled={isLocked}
                value={formState.filesReference}
                onChange={(e) => setFormState({ ...formState, filesReference: e.target.value })}
                className="mt-1 font-mono-token text-xs"
              />
            </div>
          </div>

          <div>
            <Label htmlFor="task-criteria" className="block text-sm font-medium">
              {t('plan.fieldCriteria')}
            </Label>
            <Textarea
              id="task-criteria"
              rows={3}
              required
              disabled={isLocked}
              value={formState.acceptanceCriteria}
              onChange={(e) =>
                setFormState({ ...formState, acceptanceCriteria: e.target.value })
              }
              className="mt-1"
            />
          </div>

          {plan && (
            <fieldset>
              <legend className="text-sm font-medium">{t('plan.fieldDepends')}</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {plan.tasks
                  .filter((other) => other.id !== formState.id)
                  .map((other) => {
                    const checked = formState.dependsOn.includes(other.externalId);
                    return (
                      <Label
                        key={other.id}
                        className="flex min-h-[44px] cursor-pointer items-center gap-2 rounded border px-3 py-1 text-xs"
                        style={{
                          borderColor: checked ? 'var(--accent)' : 'var(--border-subtle)',
                          backgroundColor: checked ? 'var(--accent-tint)' : 'transparent',
                        }}
                      >
                        <input
                          type="checkbox"
                          disabled={isLocked}
                          checked={checked}
                          onChange={() => {
                            const next = checked
                              ? formState.dependsOn.filter((d) => d !== other.externalId)
                              : [...formState.dependsOn, other.externalId];
                            setFormState({ ...formState, dependsOn: next });
                          }}
                        />
                        <span className="font-mono-token">{other.externalId}</span>
                        <span className="max-w-[160px] truncate">{other.title}</span>
                      </Label>
                    );
                  })}
              </div>
            </fieldset>
          )}

          {formError && <ErrorPanel title={t('plan.incompleteTitle')} detail={formError} />}

          {(createTaskMutation.isError || updateTaskMutation.isError || deleteTaskMutation.isError) && (
            <ErrorPanel
              title={t('plan.updateFailed')}
              detail={
                createTaskMutation.error?.message ||
                updateTaskMutation.error?.message ||
                deleteTaskMutation.error?.message ||
                t('common.unknownError')
              }
            />
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
            {formState.id && !isLocked ? (
              <Button
                type="button"
                onClick={() => {
                  if (confirmingDelete) deleteTaskMutation.mutate(formState.id!);
                  else setConfirmingDelete(true);
                }}
                disabled={deleteTaskMutation.isPending}
                style={{ color: 'var(--error)', borderColor: 'var(--error)' }}
                variant="outline"
              >
                {confirmingDelete
                  ? t('plan.confirmDeleteTask', { id: formState.externalId ?? '' })
                  : t('plan.deleteTask')}
              </Button>
            ) : (
              <span />
            )}

            <div className="flex gap-2">
              <Button type="button" onClick={() => setModalOpen(false)} variant="outline">
                {isLocked ? t('common.close') : t('common.cancel')}
              </Button>
              {!isLocked && (
                <Button
                  type="submit"
                  disabled={createTaskMutation.isPending || updateTaskMutation.isPending}
                >
                  {formState.id ? t('plan.saveTask') : t('plan.createTask')}
                </Button>
              )}
            </div>
          </div>
        </form>
      </ModalDialog>
    </div>
  );
}
