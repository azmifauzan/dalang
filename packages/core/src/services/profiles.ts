import { asc } from 'drizzle-orm';
import type {
  AgentProfileDTO,
  EffortLevel,
  PlanTaskRole,
  ProviderId,
  RoutingRuleDTO,
  TaskComplexity,
  TaskRole,
} from '@dalang/shared';
import type { DalangDb } from '../db/client.js';
import { agentProfiles, routingRules } from '../db/schema.js';

export interface ResolvedTaskRouting {
  primary: AgentProfileDTO;
  fallback: AgentProfileDTO | null;
  source: 'override' | 'routing_rule' | 'default';
}

/** Profiles are seeded defaults in v0.1/v0.2; creating and editing them arrives with the v0.3 settings UI. */
export class ProfileService {
  constructor(private readonly db: DalangDb) {}

  listProfiles(): AgentProfileDTO[] {
    return this.db
      .select()
      .from(agentProfiles)
      .orderBy(asc(agentProfiles.name))
      .all()
      .map(toDTO);
  }

  listRoutingRules(): RoutingRuleDTO[] {
    const profiles = this.listProfiles();
    const byId = new Map(profiles.map((p) => [p.id, p]));
    return this.db
      .select()
      .from(routingRules)
      .orderBy(asc(routingRules.sortOrder))
      .all()
      .map((rule) => ({
        id: rule.id,
        sortOrder: rule.sortOrder,
        role: rule.role as TaskRole,
        complexity: (rule.complexity as TaskComplexity | null) ?? null,
        profileId: rule.profileId,
        profileName: byId.get(rule.profileId)?.name ?? rule.profileId,
        fallbackProfileId: rule.fallbackProfileId ?? null,
        fallbackProfileName: rule.fallbackProfileId
          ? (byId.get(rule.fallbackProfileId)?.name ?? rule.fallbackProfileId)
          : null,
      }));
  }

  resolveProfileForTask(input: {
    role: PlanTaskRole;
    complexity: TaskComplexity;
    profileOverride: string | null;
  }): ResolvedTaskRouting {
    const profiles = this.listProfiles();
    if (profiles.length === 0) {
      throw new Error('No agent profiles configured in database.');
    }
    const byId = new Map(profiles.map((p) => [p.id, p]));
    const byName = new Map(profiles.map((p) => [p.name, p]));
    const rules = this.db.select().from(routingRules).orderBy(asc(routingRules.sortOrder)).all();

    // The first rule that matches in order wins; a null complexity matches every complexity (PRD routing).
    const matchedRule =
      rules.find((r) => r.role === input.role && (r.complexity === null || r.complexity === input.complexity)) ??
      null;

    if (input.profileOverride) {
      const overrideProfile = byId.get(input.profileOverride) ?? byName.get(input.profileOverride);
      if (overrideProfile) {
        const ruleFallback =
          matchedRule?.fallbackProfileId ? (byId.get(matchedRule.fallbackProfileId) ?? null) : null;
        const defaultFallback = byId.get('profile-lead') ?? null;
        const fallback =
          ruleFallback && ruleFallback.id !== overrideProfile.id
            ? ruleFallback
            : defaultFallback && defaultFallback.id !== overrideProfile.id
              ? defaultFallback
              : null;
        return { primary: overrideProfile, fallback, source: 'override' };
      }
    }

    if (matchedRule) {
      const primary = byId.get(matchedRule.profileId);
      if (primary) {
        const fallback = matchedRule.fallbackProfileId
          ? (byId.get(matchedRule.fallbackProfileId) ?? null)
          : null;
        return {
          primary,
          fallback: fallback && fallback.id !== primary.id ? fallback : null,
          source: 'routing_rule',
        };
      }
    }

    const fallbackDefault =
      (input.role === 'qa' ? byId.get('profile-reviewer') : byId.get('profile-coder-heavy')) ??
      byId.get('profile-lead') ??
      profiles[0];
    const lead = byId.get('profile-lead') ?? null;
    return {
      primary: fallbackDefault,
      fallback: lead && lead.id !== fallbackDefault.id ? lead : null,
      source: 'default',
    };
  }
}

function toDTO(row: typeof agentProfiles.$inferSelect): AgentProfileDTO {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider as ProviderId,
    model: row.model,
    effort: row.effort as EffortLevel,
    rolePrompt: row.rolePrompt,
    permissionMode: row.permissionMode as 'workspace-write' | 'read-only' | 'accept-edits',
    timeoutMs: row.timeoutMs,
    idleTimeoutMs: row.idleTimeoutMs,
    maxParallel: row.maxParallel,
    isDefault: Boolean(row.isDefault),
    createdAt: row.createdAt,
  };
}
