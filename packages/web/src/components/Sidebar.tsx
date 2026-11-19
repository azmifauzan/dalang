import { useEffect } from 'react';
import { DALANG_VERSION, type ProjectSummary, type UpdateStatusDTO } from '@dalang/shared';
import { GununganMark } from '../assets/wayang/Gunungan.js';
import { useI18n } from '../i18n/index.js';
import { useTheme } from '../lib/theme.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export type ConfigTabId = 'general' | 'agents' | 'team' | 'routing' | 'security' | 'about';

export interface SidebarProps {
  mode: 'workspace' | 'config';
  projects: ProjectSummary[];
  activeProjectId: string | null;
  activeSection: 'project' | 'new-project' | 'statistics' | 'config' | 'wizard';
  configTab: ConfigTabId;
  updateStatus: UpdateStatusDTO | null;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onNewProject: () => void;
  onSelectProject: (project: ProjectSummary) => void;
  onOpenStatistics: () => void;
  onOpenConfig: (tab?: ConfigTabId) => void;
  onBackFromConfig: () => void;
  onSelectConfigTab: (tab: ConfigTabId) => void;
}

const CONFIG_TABS: Array<{ id: ConfigTabId; key: `config.tab.${ConfigTabId}` }> = [
  { id: 'general', key: 'config.tab.general' },
  { id: 'agents', key: 'config.tab.agents' },
  { id: 'team', key: 'config.tab.team' },
  { id: 'routing', key: 'config.tab.routing' },
  { id: 'security', key: 'config.tab.security' },
  { id: 'about', key: 'config.tab.about' },
];

function SidebarContent({
  mode,
  projects,
  activeProjectId,
  activeSection,
  configTab,
  updateStatus,
  onCloseMobile,
  onNewProject,
  onSelectProject,
  onOpenStatistics,
  onOpenConfig,
  onBackFromConfig,
  onSelectConfigTab,
  isMobileDrawer,
}: SidebarProps & { isMobileDrawer: boolean }) {
  const { lang, setLang, t } = useI18n();
  const { resolved, toggleLightDark } = useTheme();

  const closeIfMobile = () => {
    if (isMobileDrawer) onCloseMobile();
  };

  return (
    <div
      className="flex h-full flex-col justify-between border-r"
      style={{
        backgroundColor: 'var(--bg-surface)',
        borderColor: 'var(--border-subtle)',
      }}
    >
      {/* Top brand + main nav */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div
          className="flex items-center justify-between gap-2 border-b px-4 py-3"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <div className="flex items-center gap-2.5">
            <GununganMark size={24} />
            <span className="text-base font-bold tracking-tight">DALANG</span>
            <Badge>v{DALANG_VERSION.split('.').slice(0, 2).join('.')}</Badge>
          </div>
          {isMobileDrawer && (
            <Button
              type="button"
              variant="outline"
              onClick={onCloseMobile}
              aria-label={t('common.closeMenu')}
            >
              {t('common.close')}
            </Button>
          )}
        </div>

        {mode === 'config' ? (
          <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onBackFromConfig();
                closeIfMobile();
              }}
              className="w-full justify-start"
            >
              ← {t('nav.backToWorkspace')}
            </Button>

            <div
              className="mt-2 px-2 text-xs font-semibold uppercase tracking-wide"
              style={{ color: 'var(--text-secondary)' }}
            >
              {t('config.title')}
            </div>

            <nav aria-label={t('nav.configTabsAria')} className="space-y-1">
              {CONFIG_TABS.map((tab) => {
                const isActive = configTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    aria-current={isActive ? 'page' : undefined}
                    onClick={() => {
                      onSelectConfigTab(tab.id);
                      closeIfMobile();
                    }}
                    className="flex min-h-[44px] w-full cursor-pointer items-center justify-between rounded-[6px] border px-3 text-left text-sm font-medium transition-colors duration-150"
                    style={{
                      backgroundColor: isActive ? 'var(--accent-tint)' : 'transparent',
                      borderColor: isActive ? 'var(--accent)' : 'transparent',
                      color: isActive ? 'var(--accent)' : 'var(--text-primary)',
                    }}
                  >
                    <span>{t(tab.key)}</span>
                  </button>
                );
              })}
            </nav>
          </div>
        ) : (
          <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
            <Button
              type="button"
              onClick={() => {
                onNewProject();
                closeIfMobile();
              }}
              className="w-full justify-start"
            >
              + {t('nav.newProject')}
            </Button>

            <div className="space-y-1">
              <div
                className="px-2 text-xs font-semibold uppercase tracking-wide"
                style={{ color: 'var(--text-secondary)' }}
              >
                {t('nav.projects')}
              </div>

              {projects.length === 0 ? (
                <p className="px-2 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {t('nav.noProjectsYet')}
                </p>
              ) : (
                <nav aria-label={t('nav.projects')} className="space-y-1">
                  {projects.map((proj) => {
                    const isActive =
                      activeSection === 'project' && proj.id === activeProjectId;
                    const progressTag =
                      proj.planStatus === 'approved'
                        ? `${proj.taskCount}t`
                        : proj.latestBriefStatus === 'approved'
                          ? 'brief'
                          : 'discuss';
                    return (
                      <button
                        key={proj.id}
                        type="button"
                        aria-current={isActive ? 'page' : undefined}
                        onClick={() => {
                          onSelectProject(proj);
                          closeIfMobile();
                        }}
                        className="flex min-h-[44px] w-full cursor-pointer items-center justify-between gap-2 rounded-[6px] border px-3 py-2 text-left text-sm transition-colors duration-150"
                        style={{
                          backgroundColor: isActive ? 'var(--accent-tint)' : 'transparent',
                          borderColor: isActive ? 'var(--accent)' : 'transparent',
                          color: isActive ? 'var(--accent)' : 'var(--text-primary)',
                        }}
                      >
                        <span className="truncate font-medium">{proj.name}</span>
                        <span
                          className="shrink-0 font-mono-token text-[11px]"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          {progressTag}
                        </span>
                      </button>
                    );
                  })}
                </nav>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Footer: Update notice + ID|EN language switch + Sun/Moon theme switch */}
      <div
        className="space-y-2.5 border-t p-3"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        {updateStatus?.updateAvailable && updateStatus.latestVersion && (
          <button
            type="button"
            onClick={() => {
              onOpenConfig('about');
              closeIfMobile();
            }}
            className="flex min-h-[44px] w-full cursor-pointer items-center justify-between gap-2 rounded-[6px] border px-3 py-2 text-left text-xs font-medium transition-colors duration-150"
            style={{
              backgroundColor: 'var(--accent-tint)',
              borderColor: 'var(--accent)',
              color: 'var(--accent)',
            }}
          >
            <span>{t('nav.updateAvailable', { version: updateStatus.latestVersion })}</span>
            <span aria-hidden="true">→</span>
          </button>
        )}

        <div className="flex items-center justify-between gap-1.5">
          {/* Statistics and Config as icon buttons */}
          {([
            {
              key: 'statistics',
              label: t('nav.statistics'),
              active: activeSection === 'statistics',
              onClick: () => onOpenStatistics(),
              icon: (
                <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" strokeLinecap="round" strokeLinejoin="round" />
              ),
            },
            {
              key: 'config',
              label: t('nav.config'),
              active: activeSection === 'config',
              onClick: () => onOpenConfig('general'),
              icon: (
                <>
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" strokeLinecap="round" strokeLinejoin="round" />
                </>
              ),
            },
          ] as const).map((item) => (
            <button
              key={item.key}
              type="button"
              aria-label={item.label}
              title={item.label}
              aria-current={item.active ? 'page' : undefined}
              onClick={() => {
                item.onClick();
                closeIfMobile();
              }}
              className="inline-flex min-h-[40px] min-w-[40px] cursor-pointer items-center justify-center rounded-[6px] border transition-colors duration-150"
              style={{
                backgroundColor: item.active ? 'var(--accent-tint)' : 'var(--bg-well)',
                borderColor: item.active ? 'var(--accent)' : 'var(--border-control)',
                color: item.active ? 'var(--accent)' : 'var(--text-primary)',
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
                {item.icon}
              </svg>
            </button>
          ))}

          {/* ID | EN compact language toggle */}
          <div
            role="group"
            aria-label={t('nav.language')}
            className="inline-flex rounded-[6px] border p-0.5"
            style={{ borderColor: 'var(--border-control)', backgroundColor: 'var(--bg-well)' }}
          >
            {(['id', 'en'] as const).map((code) => {
              const active = lang === code;
              return (
                <button
                  key={code}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setLang(code)}
                  className="min-h-[34px] min-w-[34px] cursor-pointer rounded-[4px] px-2 font-mono-token text-xs font-semibold uppercase transition-colors duration-150"
                  style={{
                    backgroundColor: active ? 'var(--accent)' : 'transparent',
                    color: active ? 'var(--accent-ink)' : 'var(--text-primary)',
                  }}
                >
                  {code}
                </button>
              );
            })}
          </div>

          {/* Theme toggle: one icon showing the mode a click switches to */}
          <button
            type="button"
            role="switch"
            aria-checked={resolved === 'dark'}
            aria-label={t('nav.themeSwitchLabel')}
            title={resolved === 'dark' ? t('nav.themeDark') : t('nav.themeLight')}
            onClick={toggleLightDark}
            className="inline-flex min-h-[40px] min-w-[40px] cursor-pointer items-center justify-center rounded-[6px] border transition-colors duration-150"
            style={{
              borderColor: 'var(--border-control)',
              backgroundColor: 'var(--bg-well)',
              color: 'var(--text-primary)',
            }}
          >
            {resolved === 'dark' ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
                <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" strokeLinecap="round" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Sidebar(props: SidebarProps) {
  const { mobileOpen, onCloseMobile } = props;
  const { t } = useI18n();

  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseMobile();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileOpen, onCloseMobile]);

  return (
    <>
      {/* Desktop persistent sidebar */}
      <aside
        aria-label={t('nav.sidebarAria')}
        className="hidden lg:sticky lg:top-0 lg:block lg:h-dvh lg:w-[264px] lg:shrink-0"
      >
        <SidebarContent {...props} isMobileDrawer={false} />
      </aside>

      {/* Mobile / tablet modal drawer */}
      {mobileOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('nav.sidebarAria')}
          className="fixed inset-0 z-50 flex lg:hidden"
        >
          <div className="relative z-10 h-dvh w-[min(290px,84vw)] shrink-0 shadow-lg">
            <SidebarContent {...props} isMobileDrawer={true} />
          </div>
          <button
            type="button"
            aria-label={t('common.closeMenu')}
            onClick={onCloseMobile}
            className="flex-1 cursor-pointer bg-black/45"
          />
        </div>
      )}
    </>
  );
}
