import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProviderRuntimeStateDTO, UpdateStatusDTO } from '@dalang/shared';
import { api } from '../lib/api.js';
import type { ConfigTabId } from './Sidebar.js';
import { AboutTab } from './config/AboutTab.js';
import { AgentsTab } from './config/AgentsTab.js';
import { AutomationTab } from './config/AutomationTab.js';
import { GeneralTab } from './config/GeneralTab.js';
import { SecurityTab } from './config/SecurityTab.js';

export function ConfigView({
  tab,
  updateStatus,
  onSelectTab,
  onReopenWizard,
  onFactoryReset,
  resettingFactory,
  factoryResetError,
  onSignOut,
  signingOut,
  activeProjectId,
  onTriageSessionStarted,
}: {
  tab: ConfigTabId;
  updateStatus: UpdateStatusDTO | null;
  onSelectTab: (tab: ConfigTabId) => void;
  onReopenWizard: () => void;
  onFactoryReset: () => void;
  resettingFactory: boolean;
  factoryResetError: string | null;
  onSignOut: () => void;
  signingOut: boolean;
  activeProjectId?: string | null;
  onTriageSessionStarted?: (sessionId: string) => void;
}) {
  const qc = useQueryClient();

  const providersQuery = useQuery({
    queryKey: ['providers-status'],
    queryFn: () => api.getProvidersStatus(),
  });
  const profilesQuery = useQuery({
    queryKey: ['profiles'],
    queryFn: () => api.listProfiles(),
  });
  const routingQuery = useQuery({
    queryKey: ['routing'],
    queryFn: () => api.listRoutingRules(),
  });
  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.getSettings(),
  });
  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.listProjects(),
  });

  const updateSettingsMutation = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: (data) => {
      qc.setQueryData(['settings'], data);
      qc.invalidateQueries({ queryKey: ['update-status'] });
      qc.invalidateQueries({ queryKey: ['execution'] });
    },
  });

  const forceUpdateCheckMutation = useMutation({
    mutationFn: () => api.getUpdateStatus(true),
    onSuccess: (data) => {
      qc.setQueryData(['update-status'], data);
    },
  });

  const settings = settingsQuery.data?.settings;
  const keyringAccess = settings?.antigravityKeyringAccess ?? false;
  const checkForUpdates = settings?.checkForUpdates ?? true;
  const providers = providersQuery.data?.providers ?? [];
  const providerStates: ProviderRuntimeStateDTO[] = providersQuery.data?.providerStates ?? [];
  const profiles = profilesQuery.data?.profiles ?? [];
  const rules = routingQuery.data?.rules ?? [];
  const settingsError = updateSettingsMutation.isError
    ? updateSettingsMutation.error.message
    : null;

  return (
    <div className="space-y-6">
      {tab === 'general' && (
        <GeneralTab
          settings={settings}
          savingSettings={updateSettingsMutation.isPending}
          settingsError={settingsError}
          onUpdateSettings={(patch) => updateSettingsMutation.mutate(patch)}
          onReopenWizard={onReopenWizard}
          resettingFactory={resettingFactory}
          factoryResetError={factoryResetError}
          onFactoryReset={onFactoryReset}
        />
      )}

      {tab === 'agents' && (
        <AgentsTab
          providers={providers}
          providerStates={providerStates}
          profiles={profiles}
          rules={rules}
          keyringAccess={keyringAccess}
          providersLoading={providersQuery.isLoading}
          providersError={providersQuery.isError ? (providersQuery.error as Error) : null}
          onRetryProviders={() => providersQuery.refetch()}
          profilesLoading={profilesQuery.isLoading}
          profilesError={profilesQuery.isError ? (profilesQuery.error as Error) : null}
          onRetryProfiles={() => profilesQuery.refetch()}
          routingLoading={routingQuery.isLoading}
          routingError={routingQuery.isError ? (routingQuery.error as Error) : null}
          onRetryRouting={() => routingQuery.refetch()}
          onOpenSecurity={() => onSelectTab('security')}
        />
      )}

      {tab === 'automation' && (
        <AutomationTab
          projects={projectsQuery.data?.projects ?? []}
          profiles={profiles}
        />
      )}

      {tab === 'security' && (
        <SecurityTab
          sandboxProvider={providers[0]}
          keyringAccess={keyringAccess}
          savingSettings={updateSettingsMutation.isPending}
          settingsError={settingsError}
          onUpdateSettings={(patch) => updateSettingsMutation.mutate(patch)}
          onSignOut={onSignOut}
          signingOut={signingOut}
        />
      )}

      {tab === 'about' && (
        <AboutTab
          updateStatus={updateStatus}
          checkForUpdates={checkForUpdates}
          checkingUpdates={forceUpdateCheckMutation.isPending}
          onForceUpdateCheck={() => forceUpdateCheckMutation.mutate()}
          onOpenGeneral={() => onSelectTab('general')}
          activeProjectId={activeProjectId ?? null}
          onTriageSessionStarted={onTriageSessionStarted}
        />
      )}
    </div>
  );
}
