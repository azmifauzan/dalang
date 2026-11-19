import type { ExecutionStateDTO, ProjectSummary } from '@dalang/shared';
import { useI18n } from '../i18n/index.js';
import type { ProjectStepId } from './ProjectStepper.js';
import { Button } from '@/components/ui/button';

export interface NextStepCardProps {
  project: ProjectSummary;
  currentStep: ProjectStepId;
  execution?: ExecutionStateDTO | null;
  hasDiscussMessages: boolean;
  onNavigateStep: (step: ProjectStepId) => void;
  onQuickWriteBrief?: () => void;
  onQuickGeneratePlan?: () => void;
  onQuickStartWork?: () => void;
  busy?: boolean;
}

export function NextStepCard({
  project,
  currentStep,
  execution,
  hasDiscussMessages,
  onNavigateStep,
  onQuickWriteBrief,
  onQuickGeneratePlan,
  onQuickStartWork,
  busy = false,
}: NextStepCardProps) {
  const { t } = useI18n();

  let message: string;
  let ctaLabel: string;
  let onAction: () => void;

  const previews = execution?.dispatchPreviews ?? [];
  const activeRunsCount =
    execution?.activeRuns?.length ?? (execution?.activeRun ? 1 : 0);

  if (project.planStatus === 'approved') {
    const mergeWaiting = previews.filter(
      (p) => p.status === 'awaiting_merge' || p.status === 'review_failed',
    );
    const failedTasks = previews.filter(
      (p) => p.status === 'failed' || p.status === 'stopped',
    );
    const eligibleTasks = previews.filter((p) => p.eligible);
    const allDone = previews.length > 0 && previews.every((p) => p.status === 'done');

    if (mergeWaiting.length > 0) {
      message = t('nextStep.mergeDecision.text', {
        count: mergeWaiting.length,
        taskId: mergeWaiting[0].externalId,
      });
      ctaLabel = t('nextStep.mergeDecision.cta');
      onAction = () => onNavigateStep('review');
    } else if (failedTasks.length > 0) {
      message = t('nextStep.failedTask.text', { taskId: failedTasks[0].externalId });
      ctaLabel = t('nextStep.failedTask.cta');
      onAction = () => onNavigateStep('work');
    } else if (activeRunsCount > 0 || execution?.queueRunning) {
      message = t('nextStep.agentsWorking.text', {
        count: Math.max(1, activeRunsCount),
      });
      ctaLabel = t('nextStep.agentsWorking.cta');
      onAction = () => onNavigateStep('work');
    } else if (allDone) {
      message = t('nextStep.allDone.text', {
        count: previews.length,
        branch: project.mainBranch,
      });
      ctaLabel = t('nextStep.allDone.cta');
      onAction = () => onNavigateStep('review');
    } else {
      message = t('nextStep.readyToStart.text', {
        count: Math.max(eligibleTasks.length, project.taskCount),
      });
      ctaLabel = t('nextStep.readyToStart.cta');
      onAction =
        currentStep === 'work' && onQuickStartWork && execution?.sandboxReady
          ? onQuickStartWork
          : () => onNavigateStep('work');
    }
  } else if (project.planStatus === 'draft') {
    message = t('nextStep.planApprove.text', { count: project.taskCount });
    ctaLabel = t('nextStep.planApprove.cta');
    onAction = () => onNavigateStep('plan');
  } else if (project.latestBriefStatus === 'approved') {
    message = t('nextStep.planGenerate.text', {
      version: project.latestBriefVersion ?? 1,
    });
    ctaLabel = t('nextStep.planGenerate.cta');
    onAction =
      currentStep === 'plan' && onQuickGeneratePlan
        ? onQuickGeneratePlan
        : () => onNavigateStep('plan');
  } else if (project.latestBriefStatus === 'draft') {
    message = t('nextStep.briefApprove.text', {
      version: project.latestBriefVersion ?? 1,
    });
    ctaLabel = t('nextStep.briefApprove.cta');
    onAction = () => onNavigateStep('brief');
  } else if (hasDiscussMessages) {
    message = t('nextStep.discussFinish.text');
    ctaLabel = t('nextStep.discussFinish.cta');
    onAction =
      currentStep === 'discuss' && onQuickWriteBrief
        ? onQuickWriteBrief
        : () => onNavigateStep('discuss');
  } else {
    message = t('nextStep.discussStart.text');
    ctaLabel = t('nextStep.discussStart.cta');
    onAction = () => onNavigateStep('discuss');
  }

  return (
    <section
      aria-label={t('nextStep.eyebrow')}
      className="flex flex-wrap items-center justify-between gap-3 rounded-[8px] border px-4 py-3"
      style={{
        backgroundColor: 'var(--accent-tint)',
        borderColor: 'var(--accent)',
      }}
    >
      <div className="min-w-0 flex-1">
        <div
          className="font-mono-token text-[11px] font-semibold uppercase tracking-wide"
          style={{ color: 'var(--accent)' }}
        >
          {t('nextStep.eyebrow')}
        </div>
        <p className="mt-0.5 text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          {message}
        </p>
      </div>
      <Button type="button" disabled={busy} onClick={onAction}>
        {ctaLabel}
      </Button>
    </section>
  );
}
