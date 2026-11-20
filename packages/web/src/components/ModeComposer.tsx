import { type FormEvent, type KeyboardEvent } from 'react';
import type { EffortLevel, ProviderId, ProviderStatus, SessionMode, SessionSummaryDTO } from '@dalang/shared';
import { useI18n } from '../i18n/index.js';
import { ModelPicker } from './ModelPicker.js';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

const MODE_RANK: Record<SessionMode, number> = {
  ask: 0,
  quick: 1,
  full: 2,
};

/** Provider, model, and reasoning effort for the next message; the Lead config is the starting value. */
export interface ComposerModelPicker {
  provider: ProviderId;
  model: string;
  effort: EffortLevel | '';
  providers: ProviderStatus[];
  onChange: (provider: ProviderId, model: string, effort: EffortLevel | '') => void;
}

export interface ModeComposerProps {
  session: SessionSummaryDTO | null;
  selectedMode: SessionMode;
  onSelectMode: (mode: SessionMode) => void;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (e: FormEvent) => void;
  busy?: boolean;
  canSubmitEmpty?: boolean;
  isFinishedSession?: boolean;
  otherWorkingSessionTitle?: string | null;
  modelPicker?: ComposerModelPicker;
  label?: string;
  submitLabel?: string;
  id?: string;
}

export function ModeComposer({
  session,
  selectedMode,
  onSelectMode,
  value,
  onChange,
  onSubmit,
  busy = false,
  canSubmitEmpty = false,
  isFinishedSession = false,
  otherWorkingSessionTitle = null,
  modelPicker,
  label,
  submitLabel,
  id = 'session-composer',
}: ModeComposerProps) {
  const { t } = useI18n();

  const currentPersistedMode: SessionMode | null = session ? session.mode : null;
  const isWorking = session?.workState === 'working';

  const getDisabledReason = (mode: SessionMode): string | null => {
    if (!currentPersistedMode) return null;
    // A question is read-only, so it can be asked anywhere. Only a lighter way of working is refused.
    if (mode === 'ask') return null;
    if (MODE_RANK[mode] < MODE_RANK[currentPersistedMode]) {
      if (isWorking) {
        return t('sessions.modeDownDisabledWorking');
      }
      // Reopened finished Quick/Full sessions allow Ask-style follow-ups (and Quick cycles).
      if (isFinishedSession) {
        return null;
      }
      return t('sessions.modeDownDisabledOneWay');
    }
    return null;
  };

  const disabledHint =
    (['ask', 'quick', 'full'] as const)
      .map((m) => getDisabledReason(m))
      .find((r) => Boolean(r)) ?? null;

  const placeholder = isFinishedSession && selectedMode === 'ask'
    ? t('sessions.followUpPlaceholder')
    : selectedMode === 'ask'
      ? t('sessions.askPlaceholder')
      : selectedMode === 'quick'
        ? t('sessions.quickPlaceholder')
        : t('sessions.fullPlaceholder');

  const helperHint = isFinishedSession
    ? t('sessions.followUpHint')
    : selectedMode === 'ask'
      ? t('sessions.readOnlyHint')
      : selectedMode === 'quick'
        ? t('sessions.quickHint')
        : t('sessions.fullHint');

  const resolvedSubmitLabel =
    submitLabel ??
    (busy
      ? t('sessions.sending')
      : selectedMode === 'ask'
        ? t('sessions.sendAsk')
        : selectedMode === 'quick'
          ? t('sessions.sendQuick')
          : t('sessions.sendFull'));

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      e.currentTarget.form?.requestSubmit();
    }
  };

  const canSend = !busy && (value.trim().length > 0 || canSubmitEmpty);

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-[8px] border p-4"
      style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
    >
      {otherWorkingSessionTitle && selectedMode !== 'ask' && (
        <div
          role="status"
          className="mb-3 rounded-[6px] border px-3 py-2 text-xs"
          style={{
            backgroundColor: 'var(--accent-tint)',
            borderColor: 'var(--accent)',
            color: 'var(--text-primary)',
          }}
        >
          {t('sessions.workingBanner', { title: otherWorkingSessionTitle })}
        </div>
      )}

      {label && (
        <Label htmlFor={id} className="mb-2 block text-sm font-medium">
          {label}
        </Label>
      )}

      <Textarea
        id={id}
        rows={3}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={busy}
        aria-label={label ?? placeholder}
      />

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        {!modelPicker && (
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              {helperHint}
            </p>
            {disabledHint && (
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {disabledHint}
              </p>
            )}
          </div>
        )}

        {/* Segmented Ask | Quick | Full control */}
        <div
          role="group"
          aria-label={t('sessions.modeGroupAria')}
          className="inline-flex rounded-[6px] border p-0.5"
          style={{
            borderColor: 'var(--border-control)',
            backgroundColor: 'var(--bg-well)',
          }}
        >
          {(['ask', 'quick', 'full'] as const).map((mode) => {
            const active = selectedMode === mode;
            const disabledReason = getDisabledReason(mode);
            const disabled = Boolean(disabledReason) || busy;
            return (
              <button
                key={mode}
                type="button"
                data-mode-option={mode}
                aria-pressed={active}
                disabled={disabled}
                title={disabledReason ?? undefined}
                onClick={() => onSelectMode(mode)}
                className="min-h-[44px] rounded-[4px] px-3 text-xs font-semibold transition-colors duration-150"
                style={{
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  opacity: disabled && !active ? 0.45 : 1,
                  backgroundColor: active ? 'var(--accent)' : 'transparent',
                  color: active ? 'var(--accent-ink)' : 'var(--text-primary)',
                }}
              >
                {t(`sessions.mode.${mode}`)}
              </button>
            );
          })}
        </div>

        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {modelPicker && (
            <ModelPicker
              provider={modelPicker.provider}
              model={modelPicker.model}
              effort={modelPicker.effort}
              providers={modelPicker.providers}
              disabled={busy}
              onChange={modelPicker.onChange}
            />
          )}
          <Button type="submit" disabled={!canSend}>
            {resolvedSubmitLabel}
          </Button>
        </div>
      </div>

      {modelPicker && (
        <div className="mt-2 space-y-0.5">
          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            {helperHint}
          </p>
          {disabledHint && (
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              {disabledHint}
            </p>
          )}
        </div>
      )}
    </form>
  );
}
