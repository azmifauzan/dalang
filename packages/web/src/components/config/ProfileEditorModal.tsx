import { MAX_REVIEW_ROUNDS } from '@dalang/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  splitEffortModel,
  type EffortLevel,
  type PermissionMode,
  type ProviderId,
  type ProviderStatus,
} from '@dalang/shared';
import { useI18n } from '../../i18n/index.js';
import { modelLabel } from '../../lib/modelLabel.js';
import { FallbackFields } from '../FallbackFields.js';
import { ModalDialog } from '../StateViews.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import {
  EFFORT_OPTIONS,
  PERMISSION_OPTIONS,
  PROVIDER_OPTIONS,
  accountLoginCommand,
  configDirEnvHint,
  formatSecondsHuman,
  isProviderUsable,
  matchProviderModel,
  type ProfileFormState,
} from './agentHelpers.js';

const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function ProfileEditorModal({
  open,
  form,
  onChange,
  providers,
  keyringAccess,
  error,
  saving,
  initialShowAdvanced = false,
  onClose,
  onSubmit,
}: {
  open: boolean;
  form: ProfileFormState;
  onChange: (updater: (prev: ProfileFormState) => ProfileFormState) => void;
  providers: ProviderStatus[];
  keyringAccess: boolean;
  error: string | null;
  saving: boolean;
  initialShowAdvanced?: boolean;
  onClose: () => void;
  onSubmit: (form: ProfileFormState) => void;
}) {
  const { lang, t } = useI18n();
  const [advancedOpen, setAdvancedOpen] = useState(initialShowAdvanced);
  const [nameTouched, setNameTouched] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setNameTouched(false);
    setCopiedCmd(false);
    setAdvancedOpen(initialShowAdvanced || Boolean(form.configDir.trim()));
  }, [open, initialShowAdvanced, form.id, form.configDir]);

  const providerModels = useMemo(() => {
    const provider = providers.find((p) => p.id === form.provider);
    return provider?.models ?? [];
  }, [providers, form.provider]);

  const isAgy = form.provider === 'antigravity';
  const matchedModel = useMemo(
    () => matchProviderModel(providerModels, form.model, isAgy),
    [providerModels, form.model, isAgy],
  );
  const selectedModelInfo = matchedModel.modelInfo;
  const activeVariantValue = matchedModel.activeVariantValue;
  const currentSplit = isAgy ? splitEffortModel(form.model) : null;
  const modelSelectValue = selectedModelInfo
    ? selectedModelInfo.id
    : currentSplit
      ? currentSplit.base
      : form.model;
  const savedModelUnavailable = Boolean(
    form.model.trim() && providerModels.length > 0 && !selectedModelInfo,
  );
  const effortChoices: EffortLevel[] = selectedModelInfo
    ? selectedModelInfo.supportedEffortLevels.length > 0
      ? selectedModelInfo.supportedEffortLevels
      : []
    : EFFORT_OPTIONS;
  const effortLocked = Boolean(selectedModelInfo && selectedModelInfo.supportedEffortLevels.length === 0);

  const trimmedName = form.name.trim();
  const nameInvalid =
    nameTouched && (!trimmedName || !PROFILE_NAME_PATTERN.test(trimmedName));

  const changeModel = (selectedId: string) =>
    onChange((f) => {
      if (!selectedId) return { ...f, model: '' };
      const info = providerModels.find((m) => m.id === selectedId);
      if (!info) return { ...f, model: selectedId };
      const nextEffort: EffortLevel =
        info.defaultEffort ??
        (info.supportedEffortLevels.includes(f.effort)
          ? f.effort
          : (info.supportedEffortLevels[0] ?? f.effort));
      if (isAgy && info.supportedEffortLevels.length > 0) {
        return { ...f, model: `${info.id}-${nextEffort}`, effort: nextEffort };
      }
      return { ...f, model: info.value, effort: nextEffort };
    });

  const toggleVariant = (variantValue: string, enabled: boolean) =>
    onChange((f) => {
      if (!selectedModelInfo) return f;
      return { ...f, model: enabled ? variantValue : selectedModelInfo.value };
    });

  const changeEffort = (level: EffortLevel) =>
    onChange((f) => {
      if (isAgy && selectedModelInfo && selectedModelInfo.supportedEffortLevels.length > 0) {
        return { ...f, effort: level, model: `${selectedModelInfo.id}-${level}` };
      }
      const parts = isAgy ? splitEffortModel(f.model) : null;
      return { ...f, effort: level, model: parts ? `${parts.base}-${level}` : f.model };
    });

  const permissionLabel = (perm: PermissionMode) => {
    if (perm === 'read-only') return t('config.team.permReadOnly');
    if (perm === 'accept-edits') return t('config.team.permAcceptEdits');
    return t('config.team.permWorkspaceWrite');
  };

  const loginCmd = accountLoginCommand(form.provider, form.configDir);

  const copyLoginCmd = async () => {
    try {
      await navigator.clipboard.writeText(loginCmd);
      setCopiedCmd(true);
      setTimeout(() => setCopiedCmd(false), 1800);
    } catch {
      // Clipboard optional in non-secure contexts
    }
  };

  const advancedSummary = [
    permissionLabel(form.permissionMode).split(' (')[0],
    t('config.team.parallelShort', { count: form.maxParallel }),
    formatSecondsHuman(form.timeoutSeconds, lang),
    form.configDir.trim() ? t('config.team.customAccount') : t('config.team.defaultAccountShort'),
  ].join(' · ');

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!trimmedName || !PROFILE_NAME_PATTERN.test(trimmedName)) {
      setNameTouched(true);
      nameRef.current?.focus();
      return;
    }
    onSubmit(form);
  };

  return (
    <ModalDialog
      open={open}
      title={
        form.id
          ? t('config.team.modalEditTitle', { name: form.name })
          : t('config.team.modalNewTitle')
      }
      onClose={onClose}
    >
      <form className="space-y-5" onSubmit={handleFormSubmit} noValidate>
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

        {/* Section 1: Identity & Model */}
        <fieldset className="space-y-4">
          <legend className="text-sm font-semibold">{t('config.team.sectionBasics')}</legend>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="prof-name">
                {t('config.team.fieldName')} <span aria-hidden="true">*</span>
              </Label>
              <Input
                ref={nameRef}
                id="prof-name"
                name="name"
                required
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={nameInvalid || undefined}
                aria-describedby="prof-name-hint"
                value={form.name}
                onBlur={() => setNameTouched(true)}
                onChange={(e) => onChange((f) => ({ ...f, name: e.target.value }))}
                placeholder={t('config.team.namePlaceholder')}
              />
              <p
                id="prof-name-hint"
                className="text-xs"
                style={{ color: nameInvalid ? 'var(--error)' : 'var(--text-secondary)' }}
              >
                {nameInvalid ? t('config.team.nameInvalid') : t('config.team.nameHint')}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="prof-provider">{t('config.team.fieldProvider')}</Label>
              <NativeSelect
                id="prof-provider"
                name="provider"
                value={form.provider}
                onChange={(e) =>
                  onChange((f) => ({ ...f, provider: e.target.value as ProviderId, model: '' }))
                }
              >
                {PROVIDER_OPTIONS.map((opt) => {
                  const pStatus = providers.find((p) => p.id === opt.value);
                  const usable = isProviderUsable(pStatus, keyringAccess);
                  return (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                      {pStatus && !usable ? ` (${t('wizard.step3.notReady')})` : ''}
                    </option>
                  );
                })}
              </NativeSelect>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="prof-model">{t('config.team.fieldModel')}</Label>
              <NativeSelect
                id="prof-model"
                name="model"
                value={modelSelectValue}
                onChange={(e) => changeModel(e.target.value)}
              >
                <option value="">{t('common.cliDefault')}</option>
                {savedModelUnavailable && (
                  <option value={modelSelectValue}>
                    {form.model} ({t('config.team.unavailableTag')})
                  </option>
                )}
                {providerModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {modelLabel(m)}
                  </option>
                ))}
              </NativeSelect>
              {savedModelUnavailable && (
                <p className="text-xs" style={{ color: 'var(--error)' }}>
                  {t('config.team.modelUnavailable', { model: form.model })}
                </p>
              )}
              {selectedModelInfo?.description && (
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {selectedModelInfo.description}
                </p>
              )}
              {selectedModelInfo && selectedModelInfo.variants.length > 0 && (
                <div className="space-y-1 pt-1">
                  {selectedModelInfo.variants.map((variant) => (
                    <label
                      key={variant.id}
                      className="flex min-h-11 cursor-pointer items-center gap-2 text-xs"
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-[var(--primary)]"
                        checked={activeVariantValue === variant.value}
                        onChange={(e) => toggleVariant(variant.value, e.target.checked)}
                      />
                      <span>
                        {t('config.team.useVariant', { label: variant.label })}{' '}
                        <span className="font-mono-token" style={{ color: 'var(--text-secondary)' }}>
                          ({variant.value})
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="prof-effort">{t('config.team.fieldEffort')}</Label>
              <NativeSelect
                id="prof-effort"
                name="effort"
                disabled={effortLocked}
                value={
                  effortChoices.includes(form.effort)
                    ? form.effort
                    : (effortChoices[0] ?? form.effort)
                }
                onChange={(e) => changeEffort(e.target.value as EffortLevel)}
              >
                {(effortChoices.length > 0 ? effortChoices : EFFORT_OPTIONS).map((eff) => (
                  <option key={eff} value={eff}>
                    {t(`sessions.picker.effort.${eff}`)}
                    {selectedModelInfo?.defaultEffort === eff
                      ? ` (${t('common.default').toLowerCase()})`
                      : ''}
                  </option>
                ))}
              </NativeSelect>
              {effortLocked && (
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {t('config.team.effortLocked')}
                </p>
              )}
            </div>
          </div>

          {form.provider === 'antigravity' && (
            <div
              className="space-y-2 rounded-[6px] border p-3"
              style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-well)' }}
            >
              <div className="flex min-h-11 items-start gap-2.5">
                <input
                  id="prof-agy-keyring"
                  type="checkbox"
                  className="mt-1 size-4 accent-[var(--primary)]"
                  checked={form.antigravityKeyringAccess}
                  onChange={(e) =>
                    onChange((f) => ({ ...f, antigravityKeyringAccess: e.target.checked }))
                  }
                />
                <Label htmlFor="prof-agy-keyring" className="text-sm leading-snug font-medium">
                  {t('config.security.agyToggle')}
                </Label>
              </div>
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {t('wizard.step2.agyKeyringRisk')}
              </p>
            </div>
          )}
        </fieldset>

        {/* Section 2: Backup / Fallback */}
        <fieldset
          className="rounded-[6px] border p-4"
          style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-canvas)' }}
        >
          <legend className="float-left mb-1 w-full text-sm font-semibold">
            {t('config.team.sectionFallback')}
          </legend>
          <div className="clear-both space-y-3">
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              {t('config.team.fallbackHint')}
            </p>
            <FallbackFields
              idPrefix="prof-fallback"
              value={form.fallback}
              onChange={(fallback) => onChange((f) => ({ ...f, fallback }))}
              providers={providers}
            />
          </div>
        </fieldset>

        {/* Section 3: Advanced Settings (Progressive disclosure) */}
        <div
          className="rounded-[6px] border"
          style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-surface)' }}
        >
          <button
            type="button"
            aria-expanded={advancedOpen}
            aria-controls="prof-advanced-panel"
            onClick={() => setAdvancedOpen((v) => !v)}
            className="flex min-h-11 w-full cursor-pointer items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-muted"
          >
            <div className="min-w-0">
              <div className="text-sm font-semibold">{t('config.team.sectionAdvanced')}</div>
              {!advancedOpen && (
                <div className="truncate text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {advancedSummary}
                </div>
              )}
            </div>
            <span className="shrink-0 text-xs font-medium" style={{ color: 'var(--accent)' }}>
              {advancedOpen ? t('common.hide') : t('common.show')}
            </span>
          </button>

          {advancedOpen && (
            <div
              id="prof-advanced-panel"
              className="space-y-4 border-t p-4"
              style={{ borderColor: 'var(--border-subtle)' }}
            >
              {/* Separate account config dir + copyable sign-in helper */}
              <div className="space-y-2">
                <Label htmlFor="prof-config-dir">{t('config.team.fieldConfigDir')}</Label>
                <Input
                  id="prof-config-dir"
                  name="configDir"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-describedby="prof-config-dir-hint"
                  value={form.configDir}
                  onChange={(e) => onChange((f) => ({ ...f, configDir: e.target.value }))}
                  placeholder={t('config.team.configDirPlaceholder')}
                  className="font-mono-token text-sm"
                />
                <p
                  id="prof-config-dir-hint"
                  className="text-xs"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  <code className="font-mono-token">{configDirEnvHint(form.provider)}</code>.{' '}
                  {t('config.team.configDirSuffix')}
                </p>
                <div
                  className="space-y-1.5 rounded-[6px] border p-2.5"
                  style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-well)' }}
                >
                  <div className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                    {t('config.team.accountLoginHelper')}
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <code className="min-w-0 flex-1 break-all font-mono-token text-xs">
                      {loginCmd}
                    </code>
                    <Button type="button" variant="outline" onClick={copyLoginCmd}>
                      {copiedCmd ? t('common.copied') : t('common.copy')}
                    </Button>
                  </div>
                </div>
              </div>

              {/* Permission mode */}
              <div className="space-y-1.5">
                <Label htmlFor="prof-permission">{t('config.team.fieldPermission')}</Label>
                <NativeSelect
                  id="prof-permission"
                  name="permissionMode"
                  value={form.permissionMode}
                  onChange={(e) =>
                    onChange((f) => ({
                      ...f,
                      permissionMode: e.target.value as PermissionMode,
                    }))
                  }
                >
                  {PERMISSION_OPTIONS.map((perm) => (
                    <option key={perm} value={perm}>
                      {permissionLabel(perm)}
                    </option>
                  ))}
                </NativeSelect>
              </div>

              {/* Limits 2x2 */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="prof-parallel">{t('config.team.fieldParallel')}</Label>
                  <Input
                    id="prof-parallel"
                    name="maxParallel"
                    type="number"
                    min={1}
                    max={16}
                    value={form.maxParallel}
                    onChange={(e) =>
                      onChange((f) => ({
                        ...f,
                        maxParallel: Math.min(16, Math.max(1, Number(e.target.value) || 1)),
                      }))
                    }
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="prof-rounds">{t('config.team.fieldRounds')}</Label>
                  <Input
                    id="prof-rounds"
                    name="maxReviewRounds"
                    type="number"
                    min={1}
                    max={MAX_REVIEW_ROUNDS}
                    value={form.maxReviewRounds}
                    onChange={(e) =>
                      onChange((f) => ({
                        ...f,
                        maxReviewRounds: Math.min(MAX_REVIEW_ROUNDS, Math.max(1, Number(e.target.value) || 2)),
                      }))
                    }
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="prof-timeout">{t('config.team.fieldTimeout')}</Label>
                  <Input
                    id="prof-timeout"
                    name="timeoutSeconds"
                    type="number"
                    min={5}
                    max={7200}
                    aria-describedby="prof-timeout-human"
                    value={form.timeoutSeconds}
                    onChange={(e) =>
                      onChange((f) => ({
                        ...f,
                        timeoutSeconds: Math.min(7200, Math.max(5, Number(e.target.value) || 1800)),
                      }))
                    }
                  />
                  <p
                    id="prof-timeout-human"
                    className="text-xs"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    = {formatSecondsHuman(form.timeoutSeconds, lang)}
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="prof-idle-timeout">{t('config.team.fieldIdleTimeout')}</Label>
                  <Input
                    id="prof-idle-timeout"
                    name="idleTimeoutSeconds"
                    type="number"
                    min={5}
                    max={3600}
                    aria-describedby="prof-idle-human"
                    value={form.idleTimeoutSeconds}
                    onChange={(e) =>
                      onChange((f) => ({
                        ...f,
                        idleTimeoutSeconds: Math.min(
                          3600,
                          Math.max(5, Number(e.target.value) || 180),
                        ),
                      }))
                    }
                  />
                  <p
                    id="prof-idle-human"
                    className="text-xs"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    = {formatSecondsHuman(form.idleTimeoutSeconds, lang)}
                  </p>
                </div>
              </div>

              {/* Role instructions */}
              <div className="space-y-1.5">
                <Label htmlFor="prof-role-prompt">{t('config.team.fieldRolePrompt')}</Label>
                <Textarea
                  id="prof-role-prompt"
                  name="rolePrompt"
                  rows={4}
                  value={form.rolePrompt}
                  onChange={(e) => onChange((f) => ({ ...f, rolePrompt: e.target.value }))}
                  placeholder={t('config.team.rolePromptPlaceholder')}
                />
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? t('common.saving') : t('config.team.saveProfile')}
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}
