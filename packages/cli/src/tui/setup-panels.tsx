import React, { useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import type { EffortLevel, ProviderId, ProviderStatus } from '@dalang/shared';
import type { SetupData } from './setup.js';
import {
  effortsFor,
  fixCommandForProvider,
  isCrossProvider,
  modelLabel,
  modelsOf,
  planTeamChanges,
  PROVIDER_ORDER,
  providerLabel,
  roleProfiles,
  roleValue,
  ROLE_KEYS,
  ROLE_LABEL,
  usableProviderIds,
  type RoleEdit,
  type RoleKey,
} from './team.js';
import { Menu, type MenuItem } from './ui.js';

/** What the Antigravity keyring consent means, from the web wizard. */
const KEYRING_RISK =
  'Antigravity signs in via the desktop keyring (needs xdg-dbus-proxy). Allowing this lets a sandboxed agy run read every secret stored in your desktop keyring. Off by default.';

export function providerStatusText(p: ProviderStatus, keyringAccess: boolean): { text: string; ready: boolean } {
  if (!p.installed) return { text: 'MISSING', ready: false };
  if (!p.loggedIn) return { text: 'LOGIN NEEDED', ready: false };
  if (p.id === 'antigravity' && !keyringAccess) return { text: 'KEYRING OFF', ready: false };
  return { text: 'READY', ready: true };
}

export function usableCount(data: SetupData): number {
  return usableProviderIds(data.providers, data.settings?.antigravityKeyringAccess ?? false).size;
}

/** One block per provider: status, version, models, and the command that fixes it when it is not ready. */
export function ProvidersBody({ data, compact = false }: { data: SetupData; compact?: boolean }) {
  const keyring = data.settings?.antigravityKeyringAccess ?? false;
  const first = data.providers[0];
  return (
    <Box flexDirection="column">
      {first ? (
        <Text color={first.sandboxReady ? 'green' : 'red'}>
          {first.sandboxReady ? `Sandbox ready: ${first.sandboxEngine}` : 'Sandbox unavailable on this host'}
        </Text>
      ) : null}
      {data.providers.map((p) => {
        const status = providerStatusText(p, keyring);
        return (
          <Box key={p.id} flexDirection="column" marginTop={compact ? 0 : 1}>
            <Box gap={2}>
              <Text bold>{providerLabel(p.id).padEnd(12)}</Text>
              <Text bold color={status.ready ? 'green' : 'red'}>
                {status.text}
              </Text>
              <Text dimColor wrap="truncate-end">
                {[p.version || p.binary, `${p.models.length} models`].join(' · ')}
              </Text>
            </Box>
            {compact ? null : (
              <Text dimColor wrap="truncate-end">
                {'  '}
                {p.authSummary}
              </Text>
            )}
            {!status.ready && p.id !== 'antigravity' ? (
              <Text color="yellow">
                {'  '}Fix: {fixCommandForProvider(p)}
              </Text>
            ) : null}
            {!status.ready && p.id === 'antigravity' && (!p.installed || !p.loggedIn) ? (
              <Text color="yellow">
                {'  '}Fix: {fixCommandForProvider(p)}
              </Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * The agent CLI check: the provider list, a re-check, and the Antigravity keyring consent.
 * `extraItems` are the screen's own actions (Next, Back); the parent handles them in `onExtra`.
 */
export function ProvidersPanel({
  data,
  extraItems,
  onExtra,
  onBack,
  compact = false,
}: {
  data: SetupData;
  /** A short terminal: one row per provider. */
  compact?: boolean;
  extraItems: MenuItem[];
  onExtra: (item: MenuItem) => void;
  onBack?: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const keyring = data.settings?.antigravityKeyringAccess ?? false;
  const agyInstalled = data.providers.some((p) => p.id === 'antigravity' && p.installed);

  if (confirm) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">{KEYRING_RISK}</Text>
        <Box marginTop={1}>
          <Menu
            items={[
              { key: 'allow', label: 'Allow Antigravity to read the desktop keyring' },
              { key: 'cancel', label: 'Cancel' },
            ]}
            initialKey="cancel"
            onCancel={() => setConfirm(false)}
            onSelect={(item) => {
              setConfirm(false);
              if (item.key === 'allow') void data.updateSettings({ antigravityKeyringAccess: true }).then(() => data.recheck());
            }}
          />
        </Box>
      </Box>
    );
  }

  const items: MenuItem[] = [
    { key: 'recheck', label: 'Re-check CLIs', detail: data.busy ?? undefined },
    ...(agyInstalled
      ? [{ key: 'keyring', label: 'Antigravity keyring access', detail: keyring ? 'on (Enter turns it off)' : 'off (Enter to allow)' }]
      : []),
    ...extraItems,
  ];

  return (
    <Box flexDirection="column">
      <ProvidersBody data={data} compact={compact} />
      <Box marginTop={compact ? 0 : 1}>
        <Menu
          items={items}
          onCancel={onBack}
          onSelect={(item) => {
            if (item.key === 'recheck') void data.recheck();
            else if (item.key === 'keyring') {
              if (keyring) void data.updateSettings({ antigravityKeyringAccess: false }).then(() => data.recheck());
              else setConfirm(true);
            } else onExtra(item);
          }}
        />
      </Box>
    </Box>
  );
}

function describeRole(value: { provider: ProviderId; model: string; effort: EffortLevel }): string {
  return [providerLabel(value.provider), value.model || 'CLI default', value.effort].join(' · ');
}

/**
 * The team step: one row per role with its provider, model, and effort. Choosing a row edits it;
 * the accept row writes the changes to the role profiles and routing rules.
 */
export function TeamEditor({
  data,
  acceptLabel,
  onAccepted,
  onBack,
  extraItems = [],
  onExtra,
}: {
  data: SetupData;
  acceptLabel: string;
  onAccepted: () => void;
  onBack: () => void;
  extraItems?: MenuItem[];
  onExtra?: (item: MenuItem) => void;
}) {
  const keyring = data.settings?.antigravityKeyringAccess ?? false;
  const usable = useMemo(() => usableProviderIds(data.providers, keyring), [data.providers, keyring]);
  const [edits, setEdits] = useState<Record<string, RoleEdit>>({});
  const [role, setRole] = useState<RoleKey | null>(null);
  const [field, setField] = useState<'provider' | 'model' | 'effort' | null>(null);
  const roles = useMemo(() => roleProfiles(data.profiles), [data.profiles]);
  const patch = (id: string, next: RoleEdit) =>
    setEdits((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), ...next } }));

  const prof = role ? roles[role] : null;
  const cur = prof ? roleValue(prof, edits[prof.id], usable, data.providers) : null;

  if (role && prof && cur) {
    const back = () => (field ? setField(null) : setRole(null));
    const heading = (
      <Text bold>
        {ROLE_LABEL[role]}
        <Text dimColor>{`   ${describeRole(cur)}`}</Text>
      </Text>
    );
    if (field === 'provider') {
      return (
        <Box flexDirection="column">
          {heading}
          <Menu
            key="provider"
            initialKey={cur.provider}
            onCancel={back}
            items={PROVIDER_ORDER.map((id) => ({
              key: id,
              label: providerLabel(id),
              detail: usable.has(id) ? undefined : 'not ready: sign in first',
              disabled: !usable.has(id),
            }))}
            onSelect={(item) => {
              const provider = item.key as ProviderId;
              patch(prof.id, { provider, model: '', effort: effortsFor(data.providers, provider, '')[0] });
              setField(null);
            }}
          />
        </Box>
      );
    }
    if (field === 'model') {
      const models = modelsOf(data.providers, cur.provider);
      const items: MenuItem[] = [{ key: '', label: 'CLI default' }];
      if (cur.model && !models.some((m) => m.value === cur.model)) items.push({ key: cur.model, label: cur.model });
      for (const m of models) items.push({ key: m.value, label: modelLabel(m), detail: m.value });
      return (
        <Box flexDirection="column">
          {heading}
          <Menu
            key="model"
            items={items}
            initialKey={cur.model}
            onCancel={back}
            onSelect={(item) => {
              const info = models.find((m) => m.value === item.key);
              const allowed = effortsFor(data.providers, cur.provider, item.key);
              patch(prof.id, {
                model: item.key,
                effort: allowed.includes(cur.effort)
                  ? cur.effort
                  : (info?.defaultEffort ?? (allowed[0] as EffortLevel)),
              });
              setField(null);
            }}
          />
        </Box>
      );
    }
    if (field === 'effort') {
      return (
        <Box flexDirection="column">
          {heading}
          <Menu
            key="effort"
            items={effortsFor(data.providers, cur.provider, cur.model).map((lvl) => ({ key: lvl, label: lvl }))}
            initialKey={cur.effort}
            onCancel={back}
            onSelect={(item) => {
              patch(prof.id, { effort: item.key as EffortLevel });
              setField(null);
            }}
          />
        </Box>
      );
    }
    return (
      <Box flexDirection="column">
        {heading}
        <Menu
          key="role"
          onCancel={back}
          items={[
            { key: 'provider', label: 'Provider', detail: providerLabel(cur.provider) },
            { key: 'model', label: 'Model', detail: cur.model || 'CLI default' },
            { key: 'effort', label: 'Reasoning effort', detail: cur.effort },
            { key: 'done', label: 'Done' },
          ]}
          onSelect={(item) => (item.key === 'done' ? setRole(null) : setField(item.key as 'provider' | 'model' | 'effort'))}
        />
      </Box>
    );
  }

  const items: MenuItem[] = [
    ...ROLE_KEYS.map((key): MenuItem => {
      const p = roles[key];
      if (!p) return { key, label: ROLE_LABEL[key], detail: 'profile missing: restore it in the web Config', disabled: true };
      return { key, label: ROLE_LABEL[key], detail: describeRole(roleValue(p, edits[p.id], usable, data.providers)) };
    }),
    { key: 'accept', label: acceptLabel, detail: data.busy ?? undefined },
    ...extraItems,
  ];
  const cross = isCrossProvider(data.profiles, data.providers, usable, edits);

  return (
    <Box flexDirection="column">
      <Text color={cross ? 'green' : 'yellow'}>
        {cross
          ? 'Cross-provider review active: coder and reviewer use separate subscriptions.'
          : 'Coder and reviewer use the same provider. Pick different providers for independent cross-model review.'}
      </Text>
      <Box marginTop={1}>
        <Menu
          key="roles"
          items={items}
          onCancel={onBack}
          onSelect={(item) => {
            if (ROLE_KEYS.includes(item.key as RoleKey)) {
              setRole(item.key as RoleKey);
              setField(null);
            } else if (item.key === 'accept') {
              const plan = planTeamChanges({
                profiles: data.profiles,
                rules: data.rules,
                providers: data.providers,
                usable,
                edits,
              });
              void data.applyTeam(plan).then((ok) => {
                if (ok) onAccepted();
              });
            } else onExtra?.(item);
          }}
        />
      </Box>
    </Box>
  );
}
