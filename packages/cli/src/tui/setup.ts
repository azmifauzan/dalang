import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentProfileDTO,
  ProviderStatus,
  RoutingRuleDTO,
  SettingsDTO,
  UpdateSettingsInput,
} from '@dalang/shared';
import type { RoomApiClient } from './client.js';
import { applyTeamPlan, type TeamPlan } from './team.js';

export interface SetupData {
  providers: ProviderStatus[];
  settings: SettingsDTO | null;
  profiles: AgentProfileDTO[];
  rules: RoutingRuleDTO[];
  /** True until the first read finishes. */
  loading: boolean;
  /** A short label while a slow action runs ("Checking CLIs..."), else null. */
  busy: string | null;
  error: string | null;
  reload: () => Promise<void>;
  /** Ask every CLI again (slower than `reload`). */
  recheck: () => Promise<boolean>;
  updateSettings: (patch: UpdateSettingsInput) => Promise<boolean>;
  /** Resolves true when every write went through. */
  applyTeam: (plan: TeamPlan) => Promise<boolean>;
}

/** Providers, settings, profiles, and routing rules for the wizard and `/config`. */
export function useSetupData(client: RoomApiClient): SetupData {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [settings, setSettings] = useState<SettingsDTO | null>(null);
  const [profiles, setProfiles] = useState<AgentProfileDTO[]>([]);
  const [rules, setRules] = useState<RoutingRuleDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(async (label: string | null, fn: () => Promise<void>): Promise<boolean> => {
    if (label) setBusy(label);
    try {
      await fn();
      if (alive.current) setError(null);
      return true;
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      if (alive.current) {
        setBusy(null);
        setLoading(false);
      }
    }
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    await run('Reading setup...', async () => {
      const [prov, sett, profs, rls] = await Promise.all([
        client.getProvidersStatus(),
        client.getSettings(),
        client.listProfiles(),
        client.listRoutingRules(),
      ]);
      if (!alive.current) return;
      setProviders(prov);
      setSettings(sett);
      setProfiles(profs);
      setRules(rls);
    });
  }, [client, run]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const recheck = useCallback(
    () =>
      run('Checking CLIs...', async () => {
        const prov = await client.refreshProvidersStatus();
        if (alive.current) setProviders(prov);
      }),
    [client, run],
  );

  const updateSettings = useCallback(
    (patch: UpdateSettingsInput) =>
      run('Saving...', async () => {
        const next = await client.updateSettings(patch);
        if (alive.current) setSettings(next);
      }),
    [client, run],
  );

  const applyTeam = useCallback(
    (plan: TeamPlan) =>
      run('Applying team...', async () => {
        await applyTeamPlan(client, plan);
        const [profs, rls] = await Promise.all([client.listProfiles(), client.listRoutingRules()]);
        if (!alive.current) return;
        setProfiles(profs);
        setRules(rls);
      }),
    [client, run],
  );

  return { providers, settings, profiles, rules, loading, busy, error, reload, recheck, updateSettings, applyTeam };
}
