import type {
  AgentProfileDTO,
  ProviderStatus,
  TaskComplexity,
  TaskRole,
} from '@dalang/shared';
import { castDisplayName, characterForProfile } from '../../assets/wayang/WayangFigure.js';
import { useI18n } from '../../i18n/index.js';
import { providerDisplayShort } from '../../lib/activity.js';
import { FallbackFields, describeFallback, fallbackFromForm } from '../FallbackFields.js';
import { ModalDialog } from '../StateViews.js';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { COMPLEXITY_OPTIONS, ROLE_OPTIONS, type RoutingFormState } from './agentHelpers.js';

export function RoutingEditorModal({
  open,
  form,
  onChange,
  profiles,
  providers,
  error,
  saving,
  onClose,
  onSubmit,
}: {
  open: boolean;
  form: RoutingFormState;
  onChange: (updater: (prev: RoutingFormState) => RoutingFormState) => void;
  profiles: AgentProfileDTO[];
  providers: ProviderStatus[];
  error: string | null;
  saving: boolean;
  onClose: () => void;
  onSubmit: (form: RoutingFormState) => void;
}) {
  const { t, te } = useI18n();

  const selectedProfile = profiles.find((p) => p.id === form.profileId) ?? null;
  const profileFallbackText = selectedProfile
    ? describeFallback(selectedProfile.fallback, t('common.cliDefault'))
    : null;

  const previewPrimaryCast = selectedProfile
    ? castDisplayName(
        characterForProfile(
          selectedProfile.name,
          form.role,
          false,
          form.complexity || null,
        ),
      )
    : '';
  const previewFallbackText = describeFallback(
    fallbackFromForm(form.fallback),
    t('common.cliDefault'),
  );
  const previewFallbackPart = previewFallbackText
    ? t('config.routing.fallbackPart', {
        target: previewFallbackText,
      })
    : '';
  const previewSentence = selectedProfile
    ? form.complexity
      ? t('config.routing.sentence', {
          complexity: te(form.complexity).toLowerCase(),
          role: te(form.role).toLowerCase(),
          primaryCast: previewPrimaryCast,
          primaryProfile: selectedProfile.name,
          primaryProvider: providerDisplayShort(selectedProfile.provider),
          fallbackPart: previewFallbackPart,
        })
      : t('config.routing.sentenceAny', {
          role: te(form.role).toLowerCase(),
          primaryCast: previewPrimaryCast,
          primaryProfile: selectedProfile.name,
          primaryProvider: providerDisplayShort(selectedProfile.provider),
          fallbackPart: previewFallbackPart,
        })
    : null;

  return (
    <ModalDialog
      open={open}
      title={form.id ? t('config.routing.modalEdit') : t('config.routing.modalNew')}
      onClose={onClose}
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(form);
        }}
      >
        {error && (
          <div
            role="alert"
            className="rounded-[6px] border px-3 py-2 text-sm"
            style={{
              backgroundColor: 'var(--error-tint)',
              borderColor: 'var(--error)',
              color: 'var(--error)',
            }}
          >
            {error}
          </div>
        )}

        <fieldset className="space-y-4">
          <legend className="text-sm font-semibold">{t('config.routing.sectionMatch')}</legend>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="route-role">{t('config.routing.fieldRole')}</Label>
              <NativeSelect
                id="route-role"
                name="role"
                value={form.role}
                onChange={(e) => onChange((f) => ({ ...f, role: e.target.value as TaskRole }))}
              >
                {ROLE_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    {te(r)}
                  </option>
                ))}
              </NativeSelect>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="route-complexity">{t('config.routing.fieldComplexity')}</Label>
              <NativeSelect
                id="route-complexity"
                name="complexity"
                value={form.complexity}
                onChange={(e) =>
                  onChange((f) => ({
                    ...f,
                    complexity: e.target.value as TaskComplexity | '',
                  }))
                }
              >
                <option value="">{t('config.routing.anyComplexity')}</option>
                {COMPLEXITY_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {te(c)}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="route-primary">{t('config.routing.fieldPrimary')}</Label>
            <NativeSelect
              id="route-primary"
              name="profileId"
              value={form.profileId}
              onChange={(e) => onChange((f) => ({ ...f, profileId: e.target.value }))}
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({providerDisplayShort(p.provider)} · {p.model || t('common.cliDefault')})
                </option>
              ))}
            </NativeSelect>
          </div>
        </fieldset>

        <fieldset
          className="rounded-[6px] border p-4"
          style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-canvas)' }}
        >
          <legend className="float-left mb-1 w-full text-sm font-semibold">
            {t('config.routing.fieldFallback')}
          </legend>
          <div className="clear-both space-y-3">
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              {profileFallbackText
                ? t('config.routing.fallbackInheritHint', { target: profileFallbackText })
                : t('config.routing.fallbackEmptyHint')}
            </p>
            <FallbackFields
              idPrefix="route-fallback"
              value={form.fallback}
              onChange={(fallback) => onChange((f) => ({ ...f, fallback }))}
              providers={providers}
            />
          </div>
        </fieldset>

        {previewSentence && (
          <div
            className="rounded-[6px] border px-3.5 py-2.5 text-xs"
            style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-well)' }}
          >
            <div className="font-semibold" style={{ color: 'var(--text-secondary)' }}>
              {t('config.routing.previewLabel')}
            </div>
            <p className="mt-1 text-sm font-medium">{previewSentence}</p>
          </div>
        )}

        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={saving || !form.profileId}>
            {saving ? t('common.saving') : t('config.routing.saveRule')}
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}
