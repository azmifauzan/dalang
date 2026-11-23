import { useState } from 'react';
import {
  DEFAULT_USAGE_REFRESH_MINUTES,
  USAGE_REFRESH_OPTIONS,
  type SettingsDTO,
  type UpdateSettingsInput,
} from '@dalang/shared';
import { useI18n } from '../../i18n/index.js';
import { useTheme, type ThemePreference } from '../../lib/theme.js';
import { ModalDialog } from '../StateViews.js';
import { Button } from '@/components/ui/button';

function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col justify-between gap-3 py-5 first:pt-0 last:pb-0 md:flex-row md:items-center md:gap-6">
      <div className="min-w-0 max-w-xl space-y-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          {description}
        </p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function GeneralTab({
  settings,
  savingSettings,
  settingsError,
  onUpdateSettings,
  onReopenWizard,
  resettingFactory,
  factoryResetError,
  onFactoryReset,
}: {
  settings: SettingsDTO | undefined;
  savingSettings: boolean;
  settingsError: string | null;
  onUpdateSettings: (patch: UpdateSettingsInput) => void;
  onReopenWizard: () => void;
  resettingFactory: boolean;
  factoryResetError: string | null;
  onFactoryReset: () => void;
}) {
  const { lang, setLang, t } = useI18n();
  const { preference, systemTheme, setPreference } = useTheme();
  const [confirmFactoryReset, setConfirmFactoryReset] = useState(false);
  const checkForUpdates = settings?.checkForUpdates ?? true;
  const usageMinutes = settings?.usageRefreshMinutes ?? DEFAULT_USAGE_REFRESH_MINUTES;

  return (
    <section className="space-y-6">
      <header className="border-b pb-4" style={{ borderColor: 'var(--border-subtle)' }}>
        <h1 className="text-2xl font-semibold tracking-tight">{t('config.general.title')}</h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
          {t('config.general.subtitle')}
        </p>
      </header>

      {settingsError && (
        <div
          role="alert"
          className="rounded-[6px] border px-3.5 py-2.5 text-sm"
          style={{
            backgroundColor: 'var(--error-tint)',
            borderColor: 'var(--error)',
            color: 'var(--error)',
          }}
        >
          {settingsError}
        </div>
      )}

      {/* Group 1: Language & Appearance */}
      <section
        aria-labelledby="general-workspace-heading"
        className="rounded-[8px] border p-5"
        style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
      >
        <h2
          id="general-workspace-heading"
          className="mb-4 text-base font-semibold"
        >
          {t('config.general.groupWorkspace')}
        </h2>

        <div className="divide-y divide-border">
          <SettingRow
            title={t('config.general.languageTitle')}
            description={t('config.general.languageDesc')}
          >
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label={t('config.general.languageTitle')}
            >
              <Button
                type="button"
                variant={lang === 'id' ? 'default' : 'outline'}
                aria-pressed={lang === 'id'}
                onClick={() => setLang('id')}
              >
                Bahasa Indonesia (ID)
              </Button>
              <Button
                type="button"
                variant={lang === 'en' ? 'default' : 'outline'}
                aria-pressed={lang === 'en'}
                onClick={() => setLang('en')}
              >
                English (EN)
              </Button>
            </div>
          </SettingRow>

          <SettingRow
            title={t('config.general.themeTitle')}
            description={t('config.general.themeDesc')}
          >
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label={t('config.general.themeTitle')}
            >
              {(
                [
                  { id: 'light', label: t('nav.themeLight') },
                  { id: 'dark', label: t('nav.themeDark') },
                  {
                    id: 'system',
                    label: t('config.general.systemCurrent', {
                      resolved:
                        systemTheme === 'dark' ? t('nav.themeDark') : t('nav.themeLight'),
                    }),
                  },
                ] as Array<{ id: ThemePreference; label: string }>
              ).map((opt) => (
                <Button
                  key={opt.id}
                  type="button"
                  variant={preference === opt.id ? 'default' : 'outline'}
                  aria-pressed={preference === opt.id}
                  onClick={() => setPreference(opt.id)}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          </SettingRow>
        </div>
      </section>

      {/* Group 2: Background checks & Guided setup */}
      <section
        aria-labelledby="general-system-heading"
        className="rounded-[8px] border p-5"
        style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
      >
        <h2
          id="general-system-heading"
          className="mb-4 text-base font-semibold"
        >
          {t('config.general.groupSystem')}
        </h2>

        <div className="divide-y divide-border">
          <SettingRow
            title={t('config.general.usageTitle')}
            description={t('config.general.usageDesc')}
          >
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label={t('config.general.usageTitle')}
            >
              {USAGE_REFRESH_OPTIONS.map((minutes) => {
                const current = usageMinutes === minutes;
                return (
                  <Button
                    key={minutes}
                    type="button"
                    variant={current ? 'default' : 'outline'}
                    aria-pressed={current}
                    disabled={savingSettings}
                    onClick={() => onUpdateSettings({ usageRefreshMinutes: minutes })}
                  >
                    {t('config.general.usageOption', { minutes })}
                  </Button>
                );
              })}
            </div>
          </SettingRow>

          <div className="space-y-2 py-5">
            <h3 className="text-sm font-semibold">{t('config.general.updatesTitle')}</h3>
            <p className="max-w-2xl text-sm" style={{ color: 'var(--text-secondary)' }}>
              {t('config.general.updatesDesc')}
            </p>
            <label className="flex min-h-11 cursor-pointer items-center gap-3 pt-1 text-sm font-medium">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[var(--primary)]"
                checked={checkForUpdates}
                disabled={savingSettings}
                onChange={(e) => onUpdateSettings({ checkForUpdates: e.target.checked })}
              />
              <span>{t('config.general.updatesToggle')}</span>
            </label>
          </div>

          <SettingRow
            title={t('config.general.wizardTitle')}
            description={t('config.general.wizardDesc')}
          >
            <Button type="button" variant="outline" onClick={onReopenWizard}>
              {t('config.general.reopenWizard')}
            </Button>
          </SettingRow>
        </div>
      </section>

      {/* Group 3: Factory reset */}
      <section
        aria-labelledby="general-reset-heading"
        className="rounded-[8px] border p-5"
        style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
      >
        <h2
          id="general-reset-heading"
          className="mb-4 text-base font-semibold"
        >
          {t('config.general.groupReset')}
        </h2>

        {factoryResetError && (
          <div
            role="alert"
            className="mb-4 rounded-[6px] border px-3.5 py-2.5 text-sm"
            style={{
              backgroundColor: 'var(--error-tint)',
              borderColor: 'var(--error)',
              color: 'var(--error)',
            }}
          >
            {factoryResetError}
          </div>
        )}

        <SettingRow
          title={t('config.general.factoryResetTitle')}
          description={t('config.general.factoryResetDesc')}
        >
          <Button
            type="button"
            variant="destructive"
            disabled={resettingFactory}
            onClick={() => setConfirmFactoryReset(true)}
          >
            {resettingFactory
              ? t('config.general.factoryResetting')
              : t('config.general.factoryResetButton')}
          </Button>
        </SettingRow>
      </section>

      <ModalDialog
        open={confirmFactoryReset}
        title={t('config.general.factoryResetModalTitle')}
        onClose={() => setConfirmFactoryReset(false)}
      >
        <div className="space-y-4">
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {t('config.general.factoryResetModalBody')}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={resettingFactory}
              onClick={() => setConfirmFactoryReset(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={resettingFactory}
              onClick={() => {
                setConfirmFactoryReset(false);
                onFactoryReset();
              }}
            >
              {resettingFactory
                ? t('config.general.factoryResetting')
                : t('config.general.factoryResetConfirm')}
            </Button>
          </div>
        </div>
      </ModalDialog>
    </section>
  );
}
