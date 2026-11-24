import os from 'node:os';
import path from 'node:path';
import React, { useState } from 'react';
import { Box, Text } from 'ink';
import type { ProjectSummary } from '@dalang/shared';
import type { RoomApiClient } from './client.js';
import { ProvidersPanel, TeamEditor, usableCount } from './setup-panels.js';
import { useSetupData } from './setup.js';
import { roleProfiles, roleValue, usableProviderIds } from './team.js';
import { clipMiddle, Field, Menu, Screen, type MenuItem } from './ui.js';

/** `~` and relative paths become absolute, so a typed folder means the same thing to the server. */
export function resolveUserPath(input: string, cwd: string): string {
  const trimmed = input.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return path.resolve(cwd, trimmed);
}

const CAST: Array<[string, string]> = [
  ['Semar', 'Lead'],
  ['Bima', 'Coder (simple tasks)'],
  ['Gatotkaca', 'Coder (medium tasks)'],
  ['Kresna', 'Coder (complex tasks)'],
  ['Srikandi', 'QA'],
  ['Arjuna', 'Reviewer'],
];

const FLOWS: Array<[string, string]> = [
  ['1. Discuss & Agree (Gate 1)', 'Describe your goal. Semar (Lead) clarifies scope and drafts a brief you approve.'],
  [
    '2. Plan & Work',
    "Semar splits work into small tasks. Bima, Gatotkaca, and Kresna build in isolated worktrees, switching automatically to each role's fallback provider on quota limits.",
  ],
  ['3. Review & Merge (Gate 2)', 'Arjuna (Reviewer) runs verify commands and reviews diffs before you approve the merge.'],
];

type Field = 'path' | 'name' | 'stack' | 'goal';

function ProjectStep({
  client,
  cwd,
  width,
  leadProvider,
  onBack,
  onSkip,
  onComplete,
}: {
  client: RoomApiClient;
  cwd: string;
  width: number;
  leadProvider: 'claude-code' | 'codex' | 'antigravity';
  onBack: () => void;
  onSkip: () => void;
  onComplete: (project: ProjectSummary, goal: string) => void;
}) {
  const [mode, setMode] = useState<'create' | 'open'>('open');
  const [values, setValues] = useState<Record<Field, string>>({ path: cwd, name: '', stack: '', goal: '' });
  const [initGit, setInitGit] = useState(true);
  const [editing, setEditing] = useState<Field | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const labels: Record<Field, { label: string; placeholder: string }> = {
    path: { label: 'Folder path', placeholder: '/path/to/repository' },
    name: { label: 'Project name (optional)', placeholder: 'defaults to the folder name' },
    stack: { label: 'Stack hint (optional)', placeholder: 'e.g. Node, TypeScript, SQLite' },
    goal: { label: 'What do you want to build or change? (optional)', placeholder: 'one sentence' },
  };

  if (editing) {
    return (
      <Field
        label={labels[editing].label}
        initialValue={values[editing]}
        placeholder={labels[editing].placeholder}
        onCancel={() => setEditing(null)}
        onSubmit={(v) => {
          setValues((prev) => ({ ...prev, [editing]: v.trim() }));
          setEditing(null);
        }}
      />
    );
  }

  const submit = async () => {
    if (!values.path.trim()) {
      setError('Enter the folder path first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const project = await client.createOrOpenProject({
        mode,
        name: values.name.trim() || undefined,
        path: resolveUserPath(values.path, cwd),
        stackHint: mode === 'create' ? values.stack.trim() || undefined : undefined,
        initGitIfMissing: mode === 'open' ? initGit : false,
        leadProvider,
      });
      onComplete(project, values.goal.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  // The label column and the menu marker take about 36 columns; the value gets the rest of the row.
  const detailMax = Math.max(20, width - 40);
  const items: MenuItem[] = [
    {
      key: 'mode',
      label: 'Mode',
      detail: mode === 'open' ? 'open an existing repository (Enter switches)' : 'create a new project folder (Enter switches)',
    },
    { key: 'path', label: 'Folder path', detail: clipMiddle(values.path, detailMax) || '(required)' },
    { key: 'name', label: 'Project name', detail: values.name || '(optional)' },
    mode === 'create'
      ? { key: 'stack', label: 'Stack hint', detail: values.stack || '(optional)' }
      : { key: 'git', label: 'Initialize Git if missing', detail: initGit ? 'yes' : 'no' },
    { key: 'goal', label: 'Goal', detail: clipMiddle(values.goal, detailMax) || '(optional)' },
    {
      key: 'submit',
      label: mode === 'create' ? 'Create project & continue' : 'Open repo & continue',
      detail: busy ? 'Setting up project...' : undefined,
      disabled: busy,
    },
    { key: 'back', label: 'Back' },
    { key: 'skip', label: 'Skip wizard' },
  ];

  return (
    <Box flexDirection="column">
      <Text dimColor>Pick a folder and state your goal in one sentence. You will land in a new session with the goal in the composer.</Text>
      {error ? <Text color="red">{error}</Text> : null}
      <Box marginTop={1}>
        <Menu
          key="project"
          items={items}
          onCancel={onBack}
          onSelect={(item) => {
            if (item.key === 'mode') setMode((m) => (m === 'open' ? 'create' : 'open'));
            else if (item.key === 'git') setInitGit((g) => !g);
            else if (item.key === 'submit') void submit();
            else if (item.key === 'back') onBack();
            else if (item.key === 'skip') onSkip();
            else setEditing(item.key as Field);
          }}
        />
      </Box>
    </Box>
  );
}

/**
 * The first-run wizard, the same four steps as the web: how Dalang works, the agent CLI check,
 * the team, and the first project. It opens when no project exists yet, and again with `/wizard`.
 */
export function Wizard({
  client,
  cwd,
  width,
  height,
  onSkip,
  onComplete,
}: {
  client: RoomApiClient;
  cwd: string;
  width: number;
  height: number;
  onSkip: () => void;
  onComplete: (project: ProjectSummary, goal: string) => void;
}) {
  const data = useSetupData(client);
  // A short terminal (the usual 24 rows) gets a tighter layout so the menu stays on screen.
  const compact = height < 30;
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const next = () => setStep((s) => Math.min(4, s + 1) as 1 | 2 | 3 | 4);
  const back = () => setStep((s) => Math.max(1, s - 1) as 1 | 2 | 3 | 4);

  const keyring = data.settings?.antigravityKeyringAccess ?? false;
  const usable = usableProviderIds(data.providers, keyring);
  const lead = roleProfiles(data.profiles).lead;
  const leadProvider = lead ? roleValue(lead, undefined, usable, data.providers).provider : 'claude-code';

  const titles: Record<number, string> = {
    1: 'How DALANG works',
    2: 'Check your agent CLIs',
    3: 'Recommended agent team',
    4: 'Create your first project',
  };
  const bar = [1, 2, 3, 4].map((i) => (i <= step ? '▰' : '▱')).join('');

  let body: React.ReactNode;
  if (step === 1) {
    body = (
      <Box flexDirection="column">
        <Text dimColor>
          Turn one goal into reviewed, merged code using the official coding CLIs already on your machine.
        </Text>
        {compact ? (
          <Box flexDirection="column" marginTop={1}>
            <Text wrap="truncate-end">
              <Text bold color="yellow">
                Semar
              </Text>
              <Text dimColor> Lead · </Text>
              <Text bold color="yellow">
                Bima/Gatotkaca/Kresna
              </Text>
              <Text dimColor> Coders · </Text>
              <Text bold color="yellow">
                Srikandi
              </Text>
              <Text dimColor> QA · </Text>
              <Text bold color="yellow">
                Arjuna
              </Text>
              <Text dimColor> Review</Text>
            </Text>
            {FLOWS.map(([title]) => (
              <Text key={title} bold>
                {title}
              </Text>
            ))}
          </Box>
        ) : (
          <>
            <Box flexDirection="column" marginTop={1}>
              {CAST.map(([name, role]) => (
                <Text key={name}>
                  <Text bold color="yellow">
                    {name.padEnd(10)}
                  </Text>
                  <Text dimColor>{role}</Text>
                </Text>
              ))}
            </Box>
            <Box flexDirection="column" marginTop={1}>
              {FLOWS.map(([title, desc]) => (
                <Box key={title} flexDirection="column" marginBottom={1}>
                  <Text bold>{title}</Text>
                  <Text dimColor>{desc}</Text>
                </Box>
              ))}
            </Box>
          </>
        )}
        <Menu
          key="s1"
          items={[
            { key: 'next', label: 'Next' },
            { key: 'skip', label: 'Skip wizard' },
          ]}
          onSelect={(item) => (item.key === 'skip' ? onSkip() : next())}
        />
      </Box>
    );
  } else if (data.loading) {
    body = <Text color="yellow">{data.busy ?? 'Reading setup...'}</Text>;
  } else if (step === 2) {
    const ready = usableCount(data);
    body = (
      <Box flexDirection="column">
        <Text dimColor>
          DALANG runs your existing CLI logins locally without storing API keys. At least one ready agent is required.
        </Text>
        {data.error ? <Text color="red">{data.error}</Text> : null}
        <ProvidersPanel
          data={data}
          compact={compact}
          onBack={back}
          extraItems={[
            {
              key: 'next',
              label: 'Next',
              detail: ready === 0 ? 'needs one ready CLI: install and sign in first' : undefined,
              disabled: ready === 0,
            },
            { key: 'back', label: 'Back' },
            { key: 'skip', label: 'Skip wizard' },
          ]}
          onExtra={(item) => (item.key === 'next' ? next() : item.key === 'back' ? back() : onSkip())}
        />
      </Box>
    );
  } else if (step === 3) {
    body = (
      <Box flexDirection="column">
        <Text dimColor>
          For each role pick the CLI, model, and reasoning effort. A backup CLI is kept or suggested for you; change
          limits and extra profiles later in the web Config.
        </Text>
        {data.error ? <Text color="red">{data.error}</Text> : null}
        <Box marginTop={1}>
          <TeamEditor
            data={data}
            acceptLabel="Accept team & continue"
            onAccepted={next}
            onBack={back}
            extraItems={[
              { key: 'back', label: 'Back' },
              { key: 'skip', label: 'Skip wizard' },
            ]}
            onExtra={(item) => (item.key === 'back' ? back() : onSkip())}
          />
        </Box>
      </Box>
    );
  } else {
    body = (
      <ProjectStep
        client={client}
        cwd={cwd}
        width={width}
        leadProvider={leadProvider}
        onBack={back}
        onSkip={onSkip}
        onComplete={onComplete}
      />
    );
  }

  return (
    <Screen
      title={`Welcome to DALANG   ${titles[step]}`}
      subtitle={`Step ${step} of 4  ${bar}`}
      hint="Up/Down move · Enter choose · Esc back · Ctrl+C quit"
      width={width}
      height={height}
    >
      <Box flexDirection="column" marginTop={1}>
        {body}
      </Box>
    </Screen>
  );
}
