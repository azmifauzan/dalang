import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { CHAT_IMAGE_TYPES, MAX_CHAT_IMAGES, MAX_CHAT_IMAGE_BYTES, type ChatImage, type EffortLevel, type ProviderId, type ProviderStatus, type SessionMode, type SessionSummaryDTO } from '@dalang/shared';
import { useI18n } from '../i18n/index.js';
import { ModelPicker } from './ModelPicker.js';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

const MODE_RANK: Record<SessionMode, number> = {
  auto: 0,
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
  images: ChatImage[];
  onImagesChange: (images: ChatImage[]) => void;
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
  images,
  onImagesChange,
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
  const fileInput = useRef<HTMLInputElement>(null);
  const [readingImages, setReadingImages] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const supportsImages = modelPicker?.provider !== 'antigravity';
  const attachLabel = t(readingImages ? 'chat.readingImages' : 'chat.attachImages');

  const currentPersistedMode: SessionMode | null = session ? session.mode : null;
  const isWorking = session?.workState === 'working';

  const getDisabledReason = (mode: SessionMode): string | null => {
    if (!currentPersistedMode) return null;
    // A question is read-only, so it can be asked anywhere. Only a lighter way of working is refused.
    if (mode === 'ask' || mode === 'auto') return null;
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
    (['auto', 'ask', 'quick', 'full'] as const)
      .map((m) => getDisabledReason(m))
      .find((r) => Boolean(r)) ?? null;

  const placeholder = isFinishedSession && selectedMode === 'ask'
    ? t('sessions.followUpPlaceholder')
    : (selectedMode === 'ask' || selectedMode === 'auto')
      ? t('sessions.askPlaceholder')
      : selectedMode === 'quick'
        ? t('sessions.quickPlaceholder')
        : t('sessions.fullPlaceholder');

  const helperHint = isFinishedSession
    ? t('sessions.followUpHint')
    : selectedMode === 'auto'
      ? t('sessions.autoHint')
      : selectedMode === 'ask'
        ? t('sessions.readOnlyHint')
        : selectedMode === 'quick'
          ? t('sessions.quickHint')
          : t('sessions.fullHint');

  const resolvedSubmitLabel =
    submitLabel ??
    (busy
      ? t('sessions.sending')
      : (selectedMode === 'ask' || selectedMode === 'auto')
        ? t('sessions.sendAsk')
        : selectedMode === 'quick'
          ? t('sessions.sendQuick')
          : t('sessions.sendFull'));

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab' && e.shiftKey) {
      const modes: SessionMode[] = ['auto', 'ask', 'quick', 'full'];
      const available = modes.filter((mode) => !getDisabledReason(mode));
      if (!busy && available.length) {
        e.preventDefault();
        onSelectMode(available[(available.indexOf(selectedMode) + 1) % available.length]);
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      e.currentTarget.form?.requestSubmit();
    }
  };

  const canSend = !busy && !readingImages && (supportsImages || images.length === 0)
    && (value.trim().length > 0 || canSubmitEmpty || images.length > 0);

  async function addImages(files: File[]) {
    if (!files.length || busy || readingImages || !supportsImages) return;
    setImageError(null);
    if (images.length + files.length > MAX_CHAT_IMAGES || files.some((file) =>
      !CHAT_IMAGE_TYPES.some((type) => type === file.type) || file.size === 0 || file.size > MAX_CHAT_IMAGE_BYTES,
    )) {
      setImageError(t('chat.imagesLimit'));
      return;
    }
    setReadingImages(true);
    try {
      const additions = await Promise.all(files.map((file) => new Promise<ChatImage>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = reject;
        reader.onload = () => resolve({
          name: file.name.slice(0, 255),
          mimeType: file.type as ChatImage['mimeType'],
          data: String(reader.result).split(',')[1],
        });
        reader.readAsDataURL(file);
      })));
      onImagesChange([...images, ...additions]);
    } catch {
      setImageError(t('chat.imagesReadError'));
    } finally {
      setReadingImages(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        if (canSend) onSubmit(e);
        else e.preventDefault();
      }}
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
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files);
          if (!files.length || !supportsImages) return;
          e.preventDefault();
          void addImages(files);
        }}
        placeholder={placeholder}
        disabled={busy}
        aria-label={label ?? placeholder}
      />

      {images.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2" aria-label={t('chat.attachedImages')}>
          {images.map((image, index) => (
            <li key={`${image.name}-${index}`} className="flex min-w-0 max-w-full items-center gap-2 rounded-md border border-input p-1">
              <img className="size-11 rounded object-cover" alt="" src={`data:${image.mimeType};base64,${image.data}`} />
              <span className="max-w-32 truncate text-xs" title={image.name}>{image.name}</span>
              <Button
                type="button" variant="outline" className="px-2 text-xs"
                aria-label={t('chat.removeImage', { name: image.name })}
                disabled={busy || readingImages}
                onClick={() => onImagesChange(images.filter((_, item) => item !== index))}
              >
                {t('common.remove')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {imageError && <p role="alert" className="mt-2 text-sm text-destructive">{imageError}</p>}
      {!supportsImages && <p className="mt-2 text-xs text-muted-foreground">{t('chat.imagesProvider')}</p>}

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

        <input
          type="file" ref={fileInput} className="hidden" multiple accept={CHAT_IMAGE_TYPES.join(',')}
          onChange={(e) => {
            void addImages(Array.from(e.currentTarget.files ?? []));
            e.currentTarget.value = '';
          }}
        />
        <Button
          type="button" variant="outline" className="size-11 border-transparent bg-transparent px-0"
          aria-label={attachLabel}
          disabled={busy || readingImages || !supportsImages || images.length >= MAX_CHAT_IMAGES}
          title={readingImages ? attachLabel : t('chat.imagesLimit')}
          onClick={() => fileInput.current?.click()}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m20.5 11.5-8.8 8.8a5 5 0 0 1-7.1-7.1l9.5-9.5a3.5 3.5 0 0 1 5 5l-9.6 9.6a2 2 0 0 1-2.8-2.8l8.8-8.8" />
          </svg>
        </Button>

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
          {(['auto', 'ask', 'quick', 'full'] as const).map((mode) => {
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
