import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { USAGE_REFRESH_OPTIONS, type AutomationDTO, type McpTokenDTO, type UiLanguage } from '@dalang/shared';
import type { RoomApiClient } from './client.js';
import { ProvidersPanel, TeamEditor } from './setup-panels.js';
import { useSetupData } from './setup.js';
import { Menu, Screen, type MenuItem } from './ui.js';

const LANGUAGES: Array<{ key: UiLanguage; label: string }> = [
  { key: 'en', label: 'English' },
  { key: 'id', label: 'Indonesian' },
];

type View = 'main' | 'language' | 'refresh' | 'providers' | 'team' | 'routing' | 'automation';

/**
 * `/config`: the settings that make sense in a terminal. Theme, the app password, and factory reset
 * stay in the web Config.
 */
export function ConfigScreen({
  client,
  width,
  height,
  onClose,
  onWizard,
}: {
  client: RoomApiClient;
  width: number;
  height: number;
  onClose: () => void;
  onWizard: () => void;
}) {
  const data = useSetupData(client);
  const [view, setView] = useState<View>('main');
  const [automations, setAutomations] = useState<AutomationDTO[] | null>(null);
  const [tokens, setTokens] = useState<McpTokenDTO[] | null>(null);
  const settings = data.settings;
  const toMain = () => setView('main');

  useEffect(() => {
    if (view !== 'automation') return;
    let cancelled = false;
    void Promise.all([
      client.listAutomations().catch(() => [] as AutomationDTO[]),
      client.listMcpTokens().then((r) => r.tokens).catch(() => [] as McpTokenDTO[]),
    ]).then(([autos, toks]) => {
      if (cancelled) return;
      setAutomations(autos);
      setTokens(toks);
    });
    return () => {
      cancelled = true;
    };
  }, [view, client]);

  let title = 'Config';
  let body: React.ReactNode;

  if (data.loading) {
    body = <Text color="yellow">{data.busy ?? 'Reading settings...'}</Text>;
  } else if (!settings) {
    body = (
      <Box flexDirection="column">
        <Text color="red">{data.error ?? 'Could not read the settings.'}</Text>
        <Menu items={[{ key: 'close', label: 'Close' }]} onSelect={onClose} onCancel={onClose} />
      </Box>
    );
  } else if (view === 'language') {
    title = 'Config · Language';
    body = (
      <Box flexDirection="column">
        <Text dimColor>
          Language for the UI and for what the Lead and Reviewer write: questions, briefs, plans, and review notes.
        </Text>
        <Menu
          key="language"
          items={LANGUAGES.map((l) => ({ key: l.key, label: l.label, detail: settings.language === l.key ? '(current)' : undefined }))}
          initialKey={settings.language ?? 'en'}
          onCancel={toMain}
          onSelect={(item) => {
            void data.updateSettings({ language: item.key as UiLanguage }).then(toMain);
          }}
        />
      </Box>
    );
  } else if (view === 'refresh') {
    title = 'Config · Provider limits refresh';
    body = (
      <Box flexDirection="column">
        <Text dimColor>How often the limits in the header ask each CLI for fresh numbers.</Text>
        <Menu
          key="refresh"
          items={USAGE_REFRESH_OPTIONS.map((m) => ({
            key: String(m),
            label: `${m} min`,
            detail: settings.usageRefreshMinutes === m ? '(current)' : undefined,
          }))}
          initialKey={String(settings.usageRefreshMinutes)}
          onCancel={toMain}
          onSelect={(item) => {
            const minutes = Number(item.key) as (typeof USAGE_REFRESH_OPTIONS)[number];
            void data.updateSettings({ usageRefreshMinutes: minutes }).then(toMain);
          }}
        />
      </Box>
    );
  } else if (view === 'providers') {
    title = 'Config · Agent CLIs';
    body = (
      <ProvidersPanel
        data={data}
        compact={height < 30}
        onBack={toMain}
        extraItems={[{ key: 'back', label: 'Back' }]}
        onExtra={toMain}
      />
    );
  } else if (view === 'team') {
    title = 'Config · Agent team';
    body = (
      <TeamEditor
        data={data}
        suggestFallbacks={false}
        acceptLabel="Save team"
        onAccepted={toMain}
        onBack={toMain}
        extraItems={[{ key: 'back', label: 'Back without saving' }]}
        onExtra={toMain}
      />
    );
  } else if (view === 'routing') {
    title = 'Config · Task routing';
    const profileName = (id: string) => data.profiles.find((p) => p.id === id)?.name ?? id;
    body = (
      <Box flexDirection="column">
        <Text dimColor>Task routing rules (evaluated top to bottom). Use /routing for add, edit, move, or delete.</Text>
        <Box flexDirection="column" marginTop={1}>
          {data.rules.length === 0 ? (
            <Text dimColor>No routing rules configured.</Text>
          ) : (
            data.rules.map((r, idx) => (
              <Text key={r.id}>
                {`${idx + 1}. ${r.role} / ${r.complexity ?? 'any'} -> ${profileName(r.profileId)}${r.fallback ? ` (fallback ${r.fallback.provider})` : ''}`}
              </Text>
            ))
          )}
        </Box>
        <Box marginTop={1}>
          <Menu items={[{ key: 'back', label: 'Back' }]} onSelect={toMain} onCancel={toMain} />
        </Box>
      </Box>
    );
  } else if (view === 'automation') {
    title = 'Config · Automation & MCP';
    body = (
      <Box flexDirection="column">
        <Text bold>Automations ({automations?.length ?? 0})</Text>
        <Text dimColor>Manage schedules & webhooks with /automation [list|add|enable|disable|trigger|rotate|runs|delete].</Text>
        {(automations ?? []).slice(0, 6).map((a) => (
          <Text key={a.id}>
            {`  - ${a.name} [${a.kind}] ${a.enabled ? 'enabled' : 'paused'} (${a.projectName})`}
          </Text>
        ))}
        <Box marginTop={1} flexDirection="column">
          <Text bold>Outside-agent MCP tokens ({tokens?.length ?? 0})</Text>
          <Text dimColor>Manage MCP tokens with /tokens [list|create|revoke|delete].</Text>
          {(tokens ?? []).slice(0, 6).map((tok) => (
            <Text key={tok.id}>
              {`  - ${tok.name} [${tok.accessLevel}] ${tok.revokedAt ? 'revoked' : 'active'}`}
            </Text>
          ))}
        </Box>
        <Box marginTop={1}>
          <Menu items={[{ key: 'back', label: 'Back' }]} onSelect={toMain} onCancel={toMain} />
        </Box>
      </Box>
    );
  } else {
    const items: MenuItem[] = [
      { key: 'language', label: 'Language', detail: settings.language === 'id' ? 'Indonesian' : settings.language === 'en' ? 'English' : 'not set' },
      { key: 'refresh', label: 'Provider limits refresh', detail: `${settings.usageRefreshMinutes} min` },
      { key: 'updates', label: 'Check for new versions', detail: settings.checkForUpdates ? 'on (Enter turns it off)' : 'off (Enter turns it on)' },
      { key: 'providers', label: 'Agent CLIs', detail: 'status, re-check, Antigravity keyring' },
      { key: 'team', label: 'Agent team', detail: 'provider, model, effort, fallback, advanced slots/timeouts' },
      { key: 'routing', label: 'Task routing', detail: `${data.rules.length} rule(s) · /routing` },
      { key: 'automation', label: 'Automation & MCP', detail: 'schedules, webhooks, MCP tokens · /automation, /tokens' },
      { key: 'wizard', label: 'Setup wizard', detail: 'walk through the first-run steps again' },
      { key: 'close', label: 'Close' },
    ];
    body = (
      <Box flexDirection="column">
        {data.error ? <Text color="red">{data.error}</Text> : null}
        {data.busy ? <Text color="yellow">{data.busy}</Text> : null}
        <Menu
          key="main"
          items={items}
          onCancel={onClose}
          onSelect={(item) => {
            if (item.key === 'updates') void data.updateSettings({ checkForUpdates: !settings.checkForUpdates });
            else if (item.key === 'close') onClose();
            else if (item.key === 'wizard') onWizard();
            else setView(item.key as View);
          }}
        />
        <Box marginTop={1}>
          <Text dimColor>Theme, the app password, and factory reset are in the web Config (dalang web).</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Screen title={title} hint="Up/Down move · Enter choose · Esc back · Ctrl+C quit" width={width} height={height}>
      <Box flexDirection="column" marginTop={1}>
        {body}
      </Box>
    </Screen>
  );
}
