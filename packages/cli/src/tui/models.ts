import type { AgentProfileDTO, EffortLevel, ProviderId, ProviderStatus, TaskRunDTO } from '@dalang/shared';
import { effortsFor, modelLabel, modelValueLabel, PROVIDER_ORDER, providerLabel } from './team.js';

/** The model the user picked with `/model` for the Lead, sent with each chat message. */
export interface ModelChoice {
  provider: ProviderId;
  /** The CLI's own value for the model; empty means the CLI default. */
  model: string;
  effort: EffortLevel | null;
}

export interface ModelOption {
  key: string;
  provider: ProviderId;
  model: string;
  /** "Claude · Claude Opus 5.5" */
  label: string;
  /** The CLI value and any description, for the second column. */
  detail: string;
  efforts: readonly EffortLevel[];
  defaultEffort: EffortLevel | null;
}

/**
 * Every model of every connected provider, in the order the web lists them. A provider that is not
 * installed, not signed in, or (Antigravity) without keyring consent is left out.
 */
export function modelOptions(providers: ProviderStatus[], usable: ReadonlySet<ProviderId>): ModelOption[] {
  const out: ModelOption[] = [];
  for (const id of PROVIDER_ORDER) {
    if (!usable.has(id)) continue;
    const status = providers.find((p) => p.id === id);
    if (!status) continue;
    out.push({
      key: `${id}:`,
      provider: id,
      model: '',
      label: `${providerLabel(id)} · CLI default`,
      detail: 'the CLI picks its own model',
      efforts: effortsFor(providers, id, ''),
      defaultEffort: null,
    });
    for (const m of status.models) {
      out.push({
        key: `${id}:${m.value}`,
        provider: id,
        model: m.value,
        label: `${providerLabel(id)} · ${modelLabel(m)}`,
        detail: m.value,
        efforts: effortsFor(providers, id, m.value),
        defaultEffort: m.defaultEffort,
      });
    }
  }
  return out;
}

/** "Claude · Claude Sonnet 5.5 · high" for the header and notices. */
export function describeModel(
  choice: Pick<ModelChoice, 'provider' | 'model'> & { effort?: string | null },
  providers: ProviderStatus[] = [],
): string {
  return [providerLabel(choice.provider), modelValueLabel(providers, choice.provider, choice.model), choice.effort || null]
    .filter(Boolean)
    .join(' · ');
}

export interface ActiveLeadModel {
  provider: ProviderId;
  model: string;
  effort: EffortLevel | null;
  /** Where the value comes from, shown next to it. */
  source: 'chosen' | 'session' | 'profile';
}

/**
 * The model the Lead answers the next message with: what `/model` chose, else what the open session
 * already uses, else the Lead profile. The session keeps no effort of its own, so that comes from the profile.
 */
export function activeLeadModel(input: {
  choice: ModelChoice | null;
  session: { provider: ProviderId; model: string | null } | null;
  leadProfile: { provider: ProviderId; model: string; effort: EffortLevel | null } | null;
}): ActiveLeadModel | null {
  const { choice, session, leadProfile } = input;
  if (choice) {
    const effort = choice.effort ?? (leadProfile?.provider === choice.provider ? leadProfile.effort : null);
    return { provider: choice.provider, model: choice.model, effort, source: 'chosen' };
  }
  if (session) {
    // The server sends the Lead's effort only when the session runs on the Lead's CLI.
    const effort = leadProfile?.provider === session.provider ? leadProfile.effort : null;
    return { provider: session.provider, model: session.model ?? '', effort, source: 'session' };
  }
  if (leadProfile) {
    return { provider: leadProfile.provider, model: leadProfile.model, effort: leadProfile.effort, source: 'profile' };
  }
  return null;
}

export const ACTIVE_SOURCE_LABEL: Record<ActiveLeadModel['source'], string> = {
  chosen: 'chosen with /model',
  session: 'this session',
  profile: 'Lead profile',
};

/** One entry per agent that is running now: "@executor-light Antigravity · gemini-4-hydrogen". */
export function describeRunningAgents(
  runs: Pick<TaskRunDTO, 'status' | 'profileName' | 'provider' | 'model' | 'kind'>[],
  providers: ProviderStatus[] = [],
): string[] {
  return runs
    .filter((r) => r.status === 'running')
    .map((r) => `@${r.profileName} ${providerLabel(r.provider)} · ${modelValueLabel(providers, r.provider, r.model)}`);
}
