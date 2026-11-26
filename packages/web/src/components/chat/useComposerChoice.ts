import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { EffortLevel, ProjectSummary, ProviderId, SessionSummaryDTO } from '@dalang/shared';
import { api } from '../../lib/api.js';
import type { ComposerModelPicker } from '../ModeComposer.js';

/**
 * The CLI, model, and reasoning effort for the next message, the same in every mode.
 * It starts from the chat's own CLI, or the project's Lead setting for a new chat, and the user can change it.
 */
export function useComposerChoice(
  project: ProjectSummary,
  session: SessionSummaryDTO | null,
  onProviderChange?: (provider: ProviderId) => void,
) {
  const [provider, setProvider] = useState<ProviderId>(session?.provider ?? project.leadProvider);
  const [model, setModel] = useState(session?.model ?? project.leadModel ?? '');
  const [effort, setEffort] = useState<EffortLevel | ''>('');
  const [chosen, setChosen] = useState(false);

  // A new chat follows the Lead saved in Config until the user picks a model here.
  useEffect(() => {
    if (session || chosen) return;
    setProvider(project.leadProvider);
    setModel(project.leadModel ?? '');
  }, [session, chosen, project.leadProvider, project.leadModel]);

  const providersQuery = useQuery({
    queryKey: ['providers-status'],
    queryFn: () => api.getProvidersStatus(),
  });

  useEffect(() => {
    onProviderChange?.(provider);
  }, [provider, onProviderChange]);

  const picker: ComposerModelPicker = {
    provider,
    model,
    effort,
    providers: providersQuery.data?.providers ?? [],
    onChange: (nextProvider, nextModel, nextEffort) => {
      setChosen(true);
      setProvider(nextProvider);
      setModel(nextModel);
      setEffort(nextEffort);
    },
  };

  /** Fields to add to the chat request. */
  const payload = {
    provider,
    model: model.trim() || null,
    effort: effort || undefined,
  };

  return { provider, picker, payload };
}
