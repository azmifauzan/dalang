import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type DragEvent, type FormEvent } from 'react';
import type {
  CreateTaskInput,
  EditableTaskStatus,
  PlanTaskRole,
  ProjectSummary,
  TaskComplexity,
  TaskDTO,
  TaskStatus,
} from '@dalang/shared';
import { api } from '../lib/api.js';
import { EmptyPanel, ErrorPanel, LoadingPanel, ModalDialog } from './StateViews.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';

const COLUMNS: Array<{ id: TaskStatus; title: string; note: string }> = [
  { id: 'draft', title: 'Draft', note: 'Needs review before ready' },
  { id: 'needs_split', title: 'Needs split', note: 'Flagged for decomposition' },
  { id: 'ready', title: 'Ready', note: 'Scoped & ready for approval' },
  { id: 'approved', title: 'Approved', note: 'Locked for v0.2 execution' },
];

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

function taskToForm(task: TaskDTO): TaskFormState {
  return {
    id: task.id,
    externalId: task.externalId,
    title: task.title,
    milestone: task.milestone,
    role: task.role,
    complexity: task.complexity,
    status: task.status === 'approved' ? 'ready' : task.status,
    goal: task.goal,
    filesAllowed: task.filesAllowed.join('\n'),
    filesReference: task.filesReference.join('\n'),
    acceptanceCriteria: task.acceptanceCriteria.join('\n'),
    verify: task.verify,
    needsSplit: task.needsSplit,
    profileOverride: task.profileOverride ?? '',
    dependsOn: task.dependsOn,
  };
}

export function ListView({
  project,
  onGoToAgree,
}: {
  project: ProjectSummary;
  onGoToAgree: () => void;
}) {
  const qc = useQueryClient();
  const [milestoneFilter, setMilestoneFilter] = useState<string>('ALL');
  const [modalOpen, setModalOpen] = useState(false);
  const [formState, setFormState] = useState<TaskFormState>(emptyTaskForm());
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [liveStatusAnnouncement, setLiveStatusAnnouncement] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const planQuery = useQuery({
    queryKey: ['plan', project.id],
    queryFn: () => api.getPlan(project.id),
  });

  const profilesQuery = useQuery({
    queryKey: ['profiles'],
    queryFn: () => api.listProfiles(),
  });

  const generateMutation = useMutation({
    mutationFn: () => api.generatePlan(project.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plan', project.id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  const approvePlanMutation = useMutation({
    mutationFn: () => api.approvePlan(project.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plan', project.id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  const createTaskMutation = useMutation({
    mutationFn: (body: CreateTaskInput) => api.createTask(project.id, body),
    onSuccess: () => {
      setModalOpen(false);
      qc.invalidateQueries({ queryKey: ['plan', project.id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  const updateTaskMutation = useMutation({
    mutationFn: ({ taskId, body }: { taskId: string; body: Partial<CreateTaskInput> }) =>
      api.updateTask(project.id, taskId, body),
    onSuccess: () => {
      setModalOpen(false);
      qc.invalidateQueries({ queryKey: ['plan', project.id] });
    },
  });

  const deleteTaskMutation = useMutation({
    mutationFn: (taskId: string) => api.deleteTask(project.id, taskId),
    onSuccess: () => {
      setModalOpen(false);
      qc.invalidateQueries({ queryKey: ['plan', project.id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  const reorderMutation = useMutation({
    mutationFn: (updates: Array<{ id: string; status?: EditableTaskStatus; position: number }>) =>
      api.reorderTasks(project.id, { updates }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plan', project.id] });
    },
  });

  const plan = planQuery.data?.plan ?? null;
  const profiles = profilesQuery.data?.profiles ?? [];
  const isLocked = plan?.status === 'approved';
  const hasApprovedBrief = project.latestBriefStatus === 'approved';

  const visibleTasks = (plan?.tasks ?? []).filter(
    (t) => milestoneFilter === 'ALL' || t.milestone === milestoneFilter,
  );

  const openCreateModal = () => {
    setFormState(emptyTaskForm(plan?.milestones[0]?.id ?? ''));
    setFormError(null);
    setConfirmingDelete(false);
    setModalOpen(true);
  };

  const openEditModal = (task: TaskDTO) => {
    setFormState(taskToForm(task));
    setFormError(null);
    setConfirmingDelete(false);
    setModalOpen(true);
  };

  const handleSaveTask = (e: FormEvent) => {
    e.preventDefault();
    const criteria = linesToArray(formState.acceptanceCriteria);
    if (criteria.length === 0 || !formState.verify.trim()) {
      setFormError('Add at least one acceptance criterion and a verify command.');
      return;
    }
    setFormError(null);
    const payload: CreateTaskInput = {
      title: formState.title.trim(),
      milestone: formState.milestone,
      role: formState.role,
      complexity: formState.complexity,
      status: formState.status,
      goal: formState.goal.trim(),
      filesAllowed: linesToArray(formState.filesAllowed),
      filesReference: linesToArray(formState.filesReference),
      acceptanceCriteria: criteria,
      verify: formState.verify.trim(),
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
    const updates = reordered.map((t, pos) => ({ id: t.id, position: pos }));
    reorderMutation.mutate(updates);
    setLiveStatusAnnouncement(
      `Moved ${moved.externalId} ${moved.title} to position ${targetIdx + 1} of ${reordered.length}`,
    );
  };

  const moveTaskToStatus = (task: TaskDTO, nextStatus: EditableTaskStatus) => {
    if (!plan || isLocked || task.status === nextStatus) return;
    const targetCol = (plan.tasks ?? []).filter((t) => t.status === nextStatus);
    reorderMutation.mutate([
      { id: task.id, status: nextStatus, position: targetCol.length },
    ]);
    setLiveStatusAnnouncement(`Moved ${task.externalId} to ${nextStatus}`);
  };

  const handleDropOnColumn = (e: DragEvent<HTMLElement>, targetStatus: TaskStatus) => {
    e.preventDefault();
    if (!draggedTaskId || !plan || isLocked || targetStatus === 'approved') return;
    const task = plan.tasks.find((t) => t.id === draggedTaskId);
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
        className="flex flex-wrap items-center justify-between gap-4 rounded-md border p-4"
        style={{
          backgroundColor: 'var(--bg-surface)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold">List (Plan & Kanban)</h1>
            {plan && (
              <Badge

                style={{
                  color: isLocked ? 'var(--pass)' : 'var(--text-primary)',
                  borderColor: isLocked ? 'var(--pass)' : 'var(--border-subtle)',
                }}
              >
                PLAN v{plan.version} · {plan.status.toUpperCase()}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
            Inspect milestones, adjust dependencies, assign agent profiles, and reorder tasks before approving.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {plan && plan.milestones.length > 0 && (
            <div>
              <Label htmlFor="milestone-filter" className="sr-only">
                Filter by milestone
              </Label>
              <NativeSelect
                id="milestone-filter"
                value={milestoneFilter}
                onChange={(e) => setMilestoneFilter(e.target.value)}
                className="w-auto"
              >
                <option value="ALL">All milestones ({plan.tasks.length})</option>
                {plan.milestones.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}: {m.title}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}

          {!isLocked && (
            <Button
              type="button"
              onClick={() => generateMutation.mutate()}
              disabled={generateMutation.isPending || !hasApprovedBrief}

              title={!hasApprovedBrief ? 'Approve a brief in Agree first' : undefined}
              variant="outline"
            >
              {generateMutation.isPending
                ? 'Generating plan...'
                : plan
                  ? 'Regenerate plan'
                  : 'Generate plan from brief'}
            </Button>
          )}

          {plan && !isLocked && (
            <>
              <Button type="button" onClick={openCreateModal} variant="outline">
                Add task
              </Button>
              <Button
                type="button"
                onClick={() => approvePlanMutation.mutate()}
                disabled={approvePlanMutation.isPending}
              >
                {approvePlanMutation.isPending ? 'Approving...' : 'Approve plan'}
              </Button>
            </>
          )}
        </div>
      </div>

      {planQuery.isLoading && <LoadingPanel label="Loading plan and kanban tasks..." />}

      {planQuery.isError && (
        <ErrorPanel
          title="Could not load plan"
          detail={planQuery.error.message}
          onRetry={() => planQuery.refetch()}
        />
      )}

      {(generateMutation.isError || approvePlanMutation.isError) && (
        <ErrorPanel
          title="Plan action failed"
          detail={
            generateMutation.error?.message ||
            approvePlanMutation.error?.message ||
            'Unknown error'
          }
        />
      )}

      {!planQuery.isLoading && !planQuery.isError && !plan && (
        <EmptyPanel
          title={hasApprovedBrief ? 'Ready to generate task plan' : 'Approve a brief first'}
          description={
            hasApprovedBrief
              ? 'Your brief is approved. Generate the milestone and task breakdown to populate the Kanban board.'
              : 'Go to Agree, review or edit your project brief, and click Approve Brief (Gate 1) before generating tasks.'
          }
          action={
            hasApprovedBrief ? (
              <Button
                type="button"
                onClick={() => generateMutation.mutate()}
                disabled={generateMutation.isPending}
              >
                {generateMutation.isPending ? 'Generating plan...' : 'Generate plan now'}
              </Button>
            ) : (
              <Button type="button" onClick={onGoToAgree}>
                Open Agree
              </Button>
            )
          }
        />
      )}

      {plan && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {COLUMNS.map((col) => {
            const colTasks = visibleTasks
              .filter((t) => t.status === col.id)
              .sort((a, b) => a.position - b.position);

            return (
              <section
                key={col.id}
                aria-label={`${col.title} column`}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => handleDropOnColumn(e, col.id)}
                className="flex flex-col rounded-md border p-3"
                style={{
                  backgroundColor: 'var(--bg-well)',
                  borderColor: 'var(--border-subtle)',
                  minHeight: '260px',
                }}
              >
                <div className="mb-3 flex items-baseline justify-between gap-2 px-1">
                  <div>
                    <h2 className="text-sm font-semibold">{col.title}</h2>
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
                    No tasks in {col.title}
                  </div>
                ) : (
                  <ul className="space-y-3">
                    {colTasks.map((task, idx) => (
                      <li
                        key={task.id}
                        draggable={!isLocked}
                        onDragStart={() => setDraggedTaskId(task.id)}
                        onDragEnd={() => setDraggedTaskId(null)}
                        className="rounded-md border p-3"
                        style={{
                          backgroundColor: 'var(--bg-surface)',
                          borderColor: 'var(--border-subtle)',
                        }}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <Badge>{task.externalId}</Badge>
                          <div className="flex flex-wrap items-center gap-1 text-xs">
                            <Badge>{task.milestone}</Badge>
                            <Badge>{task.complexity}</Badge>
                          </div>
                        </div>

                        <h3 className="mt-2 text-sm font-semibold">{task.title}</h3>
                        <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                          {task.goal}
                        </p>

                        <div className="mt-2 space-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                          <div>
                            Role: <strong>{task.role}</strong> · Profile:{' '}
                            <strong>{task.profileOverride || 'routing default'}</strong>
                          </div>
                          {task.dependsOn.length > 0 && (
                            <div className="font-mono-token">
                              Depends on: {task.dependsOn.join(', ')}
                            </div>
                          )}
                          <div className="truncate font-mono-token" title={task.verify}>
                            Verify: {task.verify}
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
                            {isLocked ? 'Inspect' : 'Edit'}
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
                                Up
                              </Button>
                              <Button
                                type="button"
                                onClick={() => moveTaskInColumn(colTasks, idx, 1)}
                                disabled={idx === colTasks.length - 1 || reorderMutation.isPending}
                                className="px-2 text-xs"
                                aria-label={`Move ${task.externalId} down`}
                                variant="outline"
                              >
                                Down
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
        title={formState.id ? `Task ${formState.externalId}` : 'New Task'}
        onClose={() => setModalOpen(false)}
      >
        <form onSubmit={handleSaveTask} className="space-y-4">
          <div>
            <Label htmlFor="task-title" className="block text-sm font-medium">
              Title
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
                Milestone
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
                Role
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
                <option value="engineer">engineer</option>
                <option value="qa">qa</option>
              </NativeSelect>
            </div>
            <div>
              <Label htmlFor="task-complexity" className="block text-sm font-medium">
                Complexity
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
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </NativeSelect>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="task-status" className="block text-sm font-medium">
                Column status
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
                {COLUMNS.filter((c) => c.id !== 'approved').map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </NativeSelect>
            </div>

            <div>
              <Label htmlFor="task-profile" className="block text-sm font-medium">
                Agent profile override
              </Label>
              <NativeSelect
                id="task-profile"
                disabled={isLocked}
                value={formState.profileOverride}
                onChange={(e) =>
                  setFormState({ ...formState, profileOverride: e.target.value })
                }
                className="mt-1"
              >
                <option value="">Use routing rule default</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.name}>
                    {p.name} ({p.provider})
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>

          <div>
            <Label htmlFor="task-goal" className="block text-sm font-medium">
              Goal
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
              Verify command
            </Label>
            <Input
              id="task-verify"
              type="text"
              required
              disabled={isLocked}
              value={formState.verify}
              onChange={(e) => setFormState({ ...formState, verify: e.target.value })}
              placeholder="Exact command that proves the task is done"
              className="mt-1 font-mono-token text-sm"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="task-allowed" className="block text-sm font-medium">
                Allowed files (one glob per line)
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
                Reference files (one per line)
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
              Acceptance criteria (one per line)
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
              <legend className="text-sm font-medium">Depends on tasks</legend>
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

          {formError && <ErrorPanel title="Task is incomplete" detail={formError} />}

          {(createTaskMutation.isError || updateTaskMutation.isError || deleteTaskMutation.isError) && (
            <ErrorPanel
              title="Task update failed"
              detail={
                createTaskMutation.error?.message ||
                updateTaskMutation.error?.message ||
                deleteTaskMutation.error?.message ||
                'Unknown error'
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
                {confirmingDelete ? `Confirm: delete ${formState.externalId}` : 'Delete task'}
              </Button>
            ) : (
              <span />
            )}

            <div className="flex gap-2">
              <Button type="button" onClick={() => setModalOpen(false)} variant="outline">
                {isLocked ? 'Close' : 'Cancel'}
              </Button>
              {!isLocked && (
                <Button
                  type="submit"
                  disabled={createTaskMutation.isPending || updateTaskMutation.isPending}
                >
                  {formState.id ? 'Save task changes' : 'Create task'}
                </Button>
              )}
            </div>
          </div>
        </form>
      </ModalDialog>
    </div>
  );
}
