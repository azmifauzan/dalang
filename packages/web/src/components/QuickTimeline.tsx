import type { TaskStatus } from '@dalang/shared';
import { useI18n } from '../i18n/index.js';

export type QuickStageId = 'request' | 'work' | 'review' | 'merge';

export function deriveQuickStage(
  hasPlan: boolean,
  planApproved: boolean,
  taskStatus?: TaskStatus | null,
): { current: QuickStageId; completed: Set<QuickStageId> } {
  const completed = new Set<QuickStageId>();
  if (!hasPlan || !planApproved) {
    return { current: 'request', completed };
  }
  completed.add('request');

  if (taskStatus === 'done') {
    completed.add('work');
    completed.add('review');
    completed.add('merge');
    return { current: 'merge', completed };
  }
  if (taskStatus === 'awaiting_merge' || taskStatus === 'review_failed') {
    completed.add('work');
    completed.add('review');
    return { current: 'merge', completed };
  }
  if (taskStatus === 'reviewing') {
    completed.add('work');
    return { current: 'review', completed };
  }
  return { current: 'work', completed };
}

export function QuickTimeline({
  hasPlan,
  planApproved,
  taskStatus,
}: {
  hasPlan: boolean;
  planApproved: boolean;
  taskStatus?: TaskStatus | null;
}) {
  const { t } = useI18n();
  const { current, completed } = deriveQuickStage(hasPlan, planApproved, taskStatus);

  const steps: Array<{ id: QuickStageId; num: number; label: string }> = [
    { id: 'request', num: 1, label: t('sessions.quick.step1') },
    { id: 'work', num: 2, label: t('sessions.quick.step2') },
    { id: 'review', num: 3, label: t('sessions.quick.step3') },
    { id: 'merge', num: 4, label: t('sessions.quick.step4') },
  ];

  return (
    <nav
      aria-label={t('sessions.quick.timelineAria')}
      className="rounded-[8px] border p-3"
      style={{
        backgroundColor: 'var(--bg-surface)',
        borderColor: 'var(--border-subtle)',
      }}
    >
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {steps.map((step) => {
          const isDone = completed.has(step.id);
          const isCurrent = current === step.id && !(isDone && step.id === 'merge');
          return (
            <li
              key={step.id}
              aria-current={isCurrent ? 'step' : undefined}
              className="flex min-h-[44px] items-center gap-2 rounded-[6px] border px-3 py-2 text-sm"
              style={{
                backgroundColor: isCurrent
                  ? 'var(--accent)'
                  : isDone
                    ? 'var(--pass-tint)'
                    : 'var(--bg-well)',
                borderColor: isCurrent
                  ? 'var(--accent)'
                  : isDone
                    ? 'var(--pass)'
                    : 'var(--border-subtle)',
                color: isCurrent
                  ? 'var(--accent-ink)'
                  : isDone
                    ? 'var(--pass)'
                    : 'var(--text-primary)',
              }}
            >
              <span
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] font-mono-token text-xs font-bold"
                style={{
                  backgroundColor: isCurrent ? 'rgba(255,255,255,0.18)' : 'var(--bg-surface)',
                  color: isCurrent ? 'var(--accent-ink)' : 'var(--text-primary)',
                }}
              >
                {isDone ? '✓' : step.num}
              </span>
              <span className="truncate font-medium">{step.label}</span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
