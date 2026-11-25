import type { AgentProfileDTO, RunKind } from '@dalang/shared';

export interface ActiveCoderRunInfo {
  taskId: string;
  externalId: string;
  runId: string;
  profileId: string;
  profileName: string;
  kind: RunKind;
  canSteer: boolean;
}

export interface RoomExecutionRouter {
  startExecution?(projectId: string, input: { sessionId: string }): Promise<unknown>;
  commitWorkspace?(projectId: string, input: { paths: string[]; message: string }): Promise<string>;
  listActiveRunsForSession(projectId: string, sessionId: string): ActiveCoderRunInfo[];
  steerTask(projectId: string, taskId: string, runId: string, message: string): Promise<void>;
}

export interface ParsedMention {
  mention: string;
  body: string;
}

export type ResolvedMentionTarget =
  | { route: 'lead'; body: string }
  | { route: 'steer'; run: ActiveCoderRunInfo; profile: AgentProfileDTO | null; body: string }
  | { route: 'ask'; profile: AgentProfileDTO; body: string };

const LEADING_MENTION_RE = /^@([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:[:,])?(?:\s+([\s\S]*))?$/;

/**
 * Extracts a leading `@<profile>` tag from a room message.
 * Returns null for untagged messages or tokens that cannot be a profile name (such as `@scope/pkg`).
 */
export function parseLeadingMention(rawMessage: string): ParsedMention | null {
  const trimmed = rawMessage.trim();
  const match = trimmed.match(LEADING_MENTION_RE);
  if (!match) return null;
  return {
    mention: match[1],
    body: (match[2] ?? '').trim(),
  };
}

/**
 * Resolves a leading `@<mention>` against currently running tasks in the session and configured
 * agent profiles:
 * - Matching a running coder task routes to live steering (`steer`).
 * - `@lead` routes to the Lead (`lead`).
 * - Matching an idle profile routes to read-only Ask mode (`ask`).
 * - Unrecognized mentions return null so the message falls through to the Lead as untagged.
 */
export function resolveMentionTarget(
  rawMessage: string,
  profiles: AgentProfileDTO[],
  activeRuns: ActiveCoderRunInfo[],
): ResolvedMentionTarget | null {
  const parsed = parseLeadingMention(rawMessage);
  if (!parsed) return null;

  const key = parsed.mention.toLowerCase();
  const body = parsed.body;
  const profileById = new Map(profiles.map((p) => [p.id, p]));
  const profileByName = new Map(profiles.map((p) => [p.name.toLowerCase(), p]));

  const coderRuns = activeRuns.filter((r) => r.kind === 'execute' || r.kind === 'fix');

  // 1. Check active running coder tasks first: exact profile match or `@coder` / `@engineer` alias.
  const exactActiveRun = coderRuns.find((r) => r.profileName.toLowerCase() === key);
  if (exactActiveRun) {
    return {
      route: 'steer',
      run: exactActiveRun,
      profile: profileById.get(exactActiveRun.profileId) ?? null,
      body,
    };
  }
  if ((key === 'coder' || key === 'engineer') && coderRuns.length > 0) {
    const run = coderRuns[0];
    return {
      route: 'steer',
      run,
      profile: profileById.get(run.profileId) ?? null,
      body,
    };
  }

  // 2. `@lead` always goes to the Lead.
  if (key === 'lead') {
    return { route: 'lead', body };
  }

  // 3. Exact profile name match -> idle Ask mode.
  const exactProfile = profileByName.get(key);
  if (exactProfile) {
    if (exactProfile.id === 'profile-lead' || exactProfile.name.toLowerCase() === 'lead') {
      return { route: 'lead', body };
    }
    return { route: 'ask', profile: exactProfile, body };
  }

  // 4. Role aliases for idle Ask mode (`@coder`, `@engineer`, `@reviewer`, `@qa`).
  if (key === 'coder' || key === 'engineer') {
    const coderProfile =
      profileByName.get('coder-small') ??
      profiles.find((p) => p.name.toLowerCase().startsWith('coder'));
    if (coderProfile) {
      return { route: 'ask', profile: coderProfile, body };
    }
  }
  if (key === 'reviewer') {
    const rev =
      profileByName.get('reviewer') ??
      profiles.find((p) => p.name.toLowerCase().includes('review'));
    if (rev) return { route: 'ask', profile: rev, body };
  }
  if (key === 'qa') {
    const qa = profileByName.get('qa');
    if (qa) return { route: 'ask', profile: qa, body };
  }

  return null;
}
