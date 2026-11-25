import React, { useState } from 'react';
import { Box, Text } from 'ink';
import type { EffortLevel, ProviderId, ProviderStatus } from '@dalang/shared';
import { describeModel, modelOptions, type ActiveLeadModel, type ModelChoice, type ModelOption } from './models.js';
import { ACTIVE_SOURCE_LABEL } from './models.js';
import { Menu, Screen, type MenuItem } from './ui.js';

/**
 * `/model`: pick the Lead's model from every connected provider. The model that answers now is
 * marked. A model that takes effort levels asks for one next.
 */
export function ModelPicker({
  providers,
  usable,
  active,
  width,
  height,
  onChoose,
  onCancel,
}: {
  providers: ProviderStatus[];
  usable: ReadonlySet<ProviderId>;
  active: ActiveLeadModel | null;
  width: number;
  height: number;
  /** null means "use the Lead's own setting again". */
  onChoose: (choice: ModelChoice | null) => void;
  onCancel: () => void;
}) {
  const options = modelOptions(providers, usable);
  const [picked, setPicked] = useState<ModelOption | null>(null);
  const activeKey = active ? `${active.provider}:${active.model}` : undefined;

  const subtitle = active
    ? `Active now: ${describeModel(active, providers)} (${ACTIVE_SOURCE_LABEL[active.source]})`
    : 'No model is set yet.';

  if (picked) {
    const items: MenuItem[] = [
      { key: '', label: "Lead's usual effort" },
      ...picked.efforts.map((lvl) => ({
        key: lvl,
        label: lvl,
        detail: lvl === picked.defaultEffort ? 'model default' : undefined,
      })),
    ];
    return (
      <Screen
        title={`Reasoning effort for ${describeModel({ provider: picked.provider, model: picked.model }, providers)}`}
        subtitle={subtitle}
        hint="Up/Down move · Enter choose · Esc back"
        width={width}
        height={height}
      >
        <Menu
          key="effort"
          items={items}
          initialKey={picked.defaultEffort ?? ''}
          maxRows={Math.max(4, height - 8)}
          onCancel={() => setPicked(null)}
          onSelect={(item) =>
            onChoose({ provider: picked.provider, model: picked.model, effort: (item.key || null) as EffortLevel | null })
          }
        />
      </Screen>
    );
  }

  const items: MenuItem[] = [
    { key: 'default', label: "Use the Lead's own setting", detail: 'forget the choice made here' },
    ...options.map((o) => ({
      key: o.key,
      label: o.label,
      detail: `${o.detail}${o.key === activeKey ? '   (active)' : ''}`,
    })),
  ];

  return (
    <Screen
      title="Choose the Lead's model"
      subtitle={subtitle}
      hint="Up/Down move · Enter choose · Esc close"
      width={width}
      height={height}
    >
      {options.length === 0 ? (
        <Text color="yellow">No connected provider. Sign in to a CLI first (run /wizard or /config).</Text>
      ) : null}
      <Box marginTop={1}>
        <Menu
          key="models"
          items={items}
          initialKey={activeKey && items.some((i) => i.key === activeKey) ? activeKey : 'default'}
          maxRows={Math.max(4, height - 8)}
          onCancel={onCancel}
          onSelect={(item) => {
            if (item.key === 'default') return onChoose(null);
            const option = options.find((o) => o.key === item.key);
            if (!option) return;
            // A model with no effort levels to choose from needs no second step.
            if (option.efforts.length <= 1) onChoose({ provider: option.provider, model: option.model, effort: null });
            else setPicked(option);
          }}
        />
      </Box>
    </Screen>
  );
}
