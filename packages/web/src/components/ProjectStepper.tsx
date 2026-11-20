import type { ProjectSummary, SessionSummaryDTO } from '@dalang/shared';
import { useI18n } from '../i18n/index.js';

export type ProjectStepId = 'discuss' | 'brief' | 'plan' | 'work' | 'review';

export interface ProjectStepperProps {
  project: ProjectSummary;
  session?: SessionSummaryDTO | null;
  currentStep: ProjectStepId;
  onSelectStep: (step: ProjectStepId) => void;
  allTasksDone?: boolean;
}

export function ProjectStepper({
  project,
  session,
  currentStep,
  onSelectStep,
  allTasksDone = false,
}: ProjectStepperProps) {
  const { t } = useI18n();

  const latestBriefStatus = session ? session.latestBriefStatus : project.latestBriefStatus;
  const planStatus = session ? session.planStatus : project.planStatus;

  const hasBrief = latestBriefStatus !== 'none';
  const briefApproved = latestBriefStatus === 'approved';
  const planApproved = planStatus === 'approved';

  const steps: Array<{
    id: ProjectStepId;
    num: number;
    label: string;
    code: string;
    done: boolean;
    enabled: boolean;
  }> = [
    {
      id: 'discuss',
      num: 1,
      label: t('step.1.label'),
      code: t('step.1.code'),
      done: hasBrief,
      enabled: true,
    },
    {
      id: 'brief',
      num: 2,
      label: t('step.2.label'),
      code: t('step.2.code'),
      done: briefApproved,
      enabled: true,
    },
    {
      id: 'plan',
      num: 3,
      label: t('step.3.label'),
      code: t('step.3.code'),
      done: planApproved,
      enabled: true,
    },
    {
      id: 'work',
      num: 4,
      label: t('step.4.label'),
      code: t('step.4.code'),
      done: allTasksDone,
      enabled: planApproved,
    },
    {
      id: 'review',
      num: 5,
      label: t('step.5.label'),
      code: t('step.5.code'),
      done: allTasksDone,
      enabled: planApproved,
    },
  ];

  return (
    <div
      className="rounded-[8px] border p-3"
      style={{
        backgroundColor: 'var(--bg-surface)',
        borderColor: 'var(--border-subtle)',
      }}
    >
      {/* 5-step guided stepper */}
      <nav aria-label={t('nav.projectStepsAria')}>
        <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-5">
          {steps.map((step) => {
            const isCurrent = currentStep === step.id;
            const disabled = !step.enabled;
            return (
              <li key={step.id}>
                <button
                  type="button"
                  disabled={disabled}
                  aria-current={isCurrent ? 'step' : undefined}
                  title={disabled ? t('step.lockedHint') : undefined}
                  onClick={() => onSelectStep(step.id)}
                  className="flex min-h-[44px] w-full items-center justify-between gap-2 rounded-[6px] border px-3 py-2 text-left text-sm transition-colors duration-150"
                  style={{
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    opacity: disabled ? 0.55 : 1,
                    backgroundColor: isCurrent
                      ? 'var(--accent)'
                      : step.done
                        ? 'var(--pass-tint)'
                        : 'var(--bg-well)',
                    borderColor: isCurrent
                      ? 'var(--accent)'
                      : step.done
                        ? 'var(--pass)'
                        : 'var(--border-subtle)',
                    color: isCurrent
                      ? 'var(--accent-ink)'
                      : step.done
                        ? 'var(--pass)'
                        : 'var(--text-primary)',
                  }}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] font-mono-token text-xs font-bold"
                      style={{
                        backgroundColor: isCurrent
                          ? 'rgba(255,255,255,0.18)'
                          : 'var(--bg-surface)',
                        color: isCurrent ? 'var(--accent-ink)' : 'var(--text-primary)',
                      }}
                    >
                      {step.done && !isCurrent ? '✓' : step.num}
                    </span>
                    <span className="truncate font-medium">{step.label}</span>
                  </span>
                  <span
                    className="shrink-0 font-mono-token text-[10px]"
                    style={{
                      opacity: isCurrent ? 0.9 : 0.75,
                    }}
                  >
                    {step.code}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
    </div>
  );
}
