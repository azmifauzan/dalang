import crypto from 'node:crypto';
import { asc, eq, or } from 'drizzle-orm';
import type {
  AgentProfileDTO,
  CreateProfileInput,
  CreateRoutingRuleInput,
  EffortLevel,
  PermissionMode,
  PlanTaskRole,
  ProviderId,
  RoutingRuleDTO,
  TaskComplexity,
  TaskRole,
  UpdateProfileInput,
  UpdateRoutingRuleInput,
} from '@dalang/shared';
import { configDirError } from '../adapters/sandbox.js';
import type { ProviderRegistry } from '../adapters/registry.js';
import type { DalangDb } from '../db/client.js';
import { agentProfiles, routingRules, runs, tasks } from '../db/schema.js';

export interface ResolvedTaskRouting {
  primary: AgentProfileDTO;
  fallback: AgentProfileDTO | null;
  source: 'override' | 'routing_rule' | 'default';
}

export interface ResolvedReviewerRouting {
  primary: AgentProfileDTO;
  fallback: AgentProfileDTO | null;
  note: string | null;
  blocked: string | null;
}

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

  getProfile(id: string): AgentProfileDTO {
    const row = this.db.select().from(agentProfiles).where(eq(agentProfiles.id, id)).get();
    if (!row) throw new Error(`Agent profile not found: ${id}`);
    return toDTO(row);
  }

  createProfile(
    input: Omit<CreateProfileInput, 'configDir'> & { configDir?: string | null },
  ): AgentProfileDTO {
    const existing = this.db
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.name, input.name))
      .get();
    if (existing) {
      throw new Error(`An agent profile named "${input.name}" already exists.`);
    }

    const dirError = configDirError(input.configDir);
    if (dirError) throw new Error(dirError);

    const id = `profile-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    this.db
      .insert(agentProfiles)
      .values({
        id,
        name: input.name,
        provider: input.provider,
        model: input.model,
        effort: input.effort,
        rolePrompt: input.rolePrompt,
        permissionMode: input.permissionMode,
        timeoutMs: input.timeoutMs,
        idleTimeoutMs: input.idleTimeoutMs,
        maxParallel: input.maxParallel,
        maxReviewRounds: input.maxReviewRounds,
        fallbackProfileId: this.checkedFallbackId(input.fallbackProfileId, null),
        configDir: input.configDir?.trim() || null,
        isDefault: false,
        createdAt: now,
      })
      .run();

    return this.getProfile(id);
  }

  updateProfile(id: string, input: UpdateProfileInput): AgentProfileDTO {
    const current = this.getProfile(id);
    const dirError = configDirError(input.configDir);
    if (dirError) throw new Error(dirError);
    if (input.name && input.name !== current.name) {
      const conflict = this.db
        .select()
        .from(agentProfiles)
        .where(eq(agentProfiles.name, input.name))
        .get();
      if (conflict && conflict.id !== id) {
        throw new Error(`An agent profile named "${input.name}" already exists.`);
      }
    }

    this.db
      .update(agentProfiles)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
        ...(input.rolePrompt !== undefined ? { rolePrompt: input.rolePrompt } : {}),
        ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.idleTimeoutMs !== undefined ? { idleTimeoutMs: input.idleTimeoutMs } : {}),
        ...(input.maxParallel !== undefined ? { maxParallel: input.maxParallel } : {}),
        ...(input.maxReviewRounds !== undefined ? { maxReviewRounds: input.maxReviewRounds } : {}),
        ...(input.fallbackProfileId !== undefined
          ? { fallbackProfileId: this.checkedFallbackId(input.fallbackProfileId, id) }
          : {}),
        ...(input.configDir !== undefined
          ? { configDir: input.configDir?.trim() || null }
          : {}),
      })
      .where(eq(agentProfiles.id, id))
      .run();

    return this.getProfile(id);
  }

  private checkedFallbackId(fallbackId: string | null | undefined, selfId: string | null): string | null {
    if (!fallbackId) return null;
    if (fallbackId === selfId) throw new Error('A profile cannot be its own fallback.');
    this.getProfile(fallbackId);
    return fallbackId;
  }

  deleteProfile(id: string): void {
    const target = this.getProfile(id);
    const all = this.listProfiles();
    if (all.length <= 1) {
      throw new Error('Cannot delete the last remaining agent profile.');
    }

    const usedByRules = this.db
      .select()
      .from(routingRules)
      .where(or(eq(routingRules.profileId, id), eq(routingRules.fallbackProfileId, id)))
      .all();
    if (usedByRules.length > 0) {
      throw new Error(
        `Cannot delete "${target.name}" while routing rules point to it. Update or remove those rules first.`,
      );
    }

    const usedAsFallback = all.filter((p) => p.fallbackProfileId === id);
    if (usedAsFallback.length > 0) {
      throw new Error(
        `Cannot delete "${target.name}" while it is the fallback of ${usedAsFallback.map((p) => `"${p.name}"`).join(', ')}. Change that fallback first.`,
      );
    }

    const usedByTask = this.db
      .select()
      .from(tasks)
      .where(or(eq(tasks.profileOverride, id), eq(tasks.profileOverride, target.name)))
      .get();
    if (usedByTask) {
      throw new Error(`Cannot delete "${target.name}" while a task is assigned to it.`);
    }

    const usedByRuns = this.db.select().from(runs).where(eq(runs.profileId, id)).get();
    if (usedByRuns) {
      throw new Error(
        `Cannot delete "${target.name}" because existing task runs reference it.`,
      );
    }

    this.db.delete(agentProfiles).where(eq(agentProfiles.id, id)).run();
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

  createRoutingRule(input: CreateRoutingRuleInput): RoutingRuleDTO {
    this.getProfile(input.profileId);
    if (input.fallbackProfileId) {
      if (input.fallbackProfileId === input.profileId) {
        throw new Error('Fallback profile must differ from primary profile.');
      }
      this.getProfile(input.fallbackProfileId);
    }

    const existing = this.db.select().from(routingRules).all();
    const nextOrder = existing.reduce((max, r) => Math.max(max, r.sortOrder), 0) + 1;
    const id = crypto.randomUUID();
    this.db
      .insert(routingRules)
      .values({
        id,
        sortOrder: nextOrder,
        role: input.role,
        complexity: input.complexity ?? null,
        profileId: input.profileId,
        fallbackProfileId: input.fallbackProfileId ?? null,
      })
      .run();

    return this.listRoutingRules().find((r) => r.id === id)!;
  }

  updateRoutingRule(id: string, input: UpdateRoutingRuleInput): RoutingRuleDTO {
    const current = this.db.select().from(routingRules).where(eq(routingRules.id, id)).get();
    if (!current) throw new Error(`Routing rule not found: ${id}`);

    const nextProfileId = input.profileId ?? current.profileId;
    const nextFallback =
      input.fallbackProfileId !== undefined ? input.fallbackProfileId : current.fallbackProfileId;

    this.getProfile(nextProfileId);
    if (nextFallback) {
      if (nextFallback === nextProfileId) {
        throw new Error('Fallback profile must differ from primary profile.');
      }
      this.getProfile(nextFallback);
    }

    this.db
      .update(routingRules)
      .set({
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.complexity !== undefined ? { complexity: input.complexity } : {}),
        profileId: nextProfileId,
        fallbackProfileId: nextFallback ?? null,
      })
      .where(eq(routingRules.id, id))
      .run();

    return this.listRoutingRules().find((r) => r.id === id)!;
  }

  deleteRoutingRule(id: string): void {
    const current = this.db.select().from(routingRules).where(eq(routingRules.id, id)).get();
    if (!current) throw new Error(`Routing rule not found: ${id}`);
    this.db.delete(routingRules).where(eq(routingRules.id, id)).run();
    this.normalizeRoutingOrder();
  }

  reorderRoutingRules(ruleIds: string[]): RoutingRuleDTO[] {
    const all = this.db.select().from(routingRules).orderBy(asc(routingRules.sortOrder)).all();
    const byId = new Map(all.map((r) => [r.id, r]));
    const ordered: string[] = [];
    for (const id of ruleIds) {
      if (byId.has(id) && !ordered.includes(id)) ordered.push(id);
    }
    for (const r of all) {
      if (!ordered.includes(r.id)) ordered.push(r.id);
    }
    ordered.forEach((id, idx) => {
      this.db
        .update(routingRules)
        .set({ sortOrder: idx + 1 })
        .where(eq(routingRules.id, id))
        .run();
    });
    return this.listRoutingRules();
  }

  private normalizeRoutingOrder(): void {
    const all = this.db.select().from(routingRules).orderBy(asc(routingRules.sortOrder)).all();
    all.forEach((r, idx) => {
      if (r.sortOrder !== idx + 1) {
        this.db
          .update(routingRules)
          .set({ sortOrder: idx + 1 })
          .where(eq(routingRules.id, r.id))
          .run();
      }
    });
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

    // The routing rule's fallback wins; otherwise the primary profile's own fallback.
    const ownFallback = (ruleFallbackId: string | null | undefined, primary: AgentProfileDTO) => {
      const f = byId.get(ruleFallbackId || primary.fallbackProfileId || '');
      return f && f.id !== primary.id ? f : null;
    };

    // The first rule that matches in order wins; a null complexity matches every complexity (PRD routing).
    const matchedRule =
      rules.find((r) => r.role === input.role && (r.complexity === null || r.complexity === input.complexity)) ??
      null;

    if (input.profileOverride) {
      const overrideProfile = byId.get(input.profileOverride) ?? byName.get(input.profileOverride);
      if (overrideProfile) {
        const ruleFallback = ownFallback(matchedRule?.fallbackProfileId, overrideProfile);
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
        return {
          primary,
          fallback: ownFallback(matchedRule.fallbackProfileId, primary),
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
      fallback: ownFallback(null, fallbackDefault) ?? (lead && lead.id !== fallbackDefault.id ? lead : null),
      source: 'default',
    };
  }

  /**
   * Select reviewer profile honoring routing rules, keyring policy, and cross-model review preference.
   */
  resolveReviewerProfile(input: {
    coderProvider: ProviderId;
    sandboxReady: boolean;
    registry: ProviderRegistry;
  }): ResolvedReviewerRouting {
    const profiles = this.listProfiles();
    if (profiles.length === 0) {
      throw new Error('No agent profiles configured in database.');
    }
    const byId = new Map(profiles.map((p) => [p.id, p]));
    const rules = this.db.select().from(routingRules).orderBy(asc(routingRules.sortOrder)).all();

    const reviewerRule =
      rules.find((r) => r.role === 'reviewer') ??
      rules.find((r) => r.role === 'qa') ??
      null;

    const configuredPrimary =
      (reviewerRule ? byId.get(reviewerRule.profileId) : undefined) ??
      byId.get('profile-reviewer') ??
      byId.get('profile-lead') ??
      profiles[0];
    const configuredFallback =
      (reviewerRule?.fallbackProfileId ? byId.get(reviewerRule.fallbackProfileId) : undefined) ??
      (configuredPrimary.fallbackProfileId ? byId.get(configuredPrimary.fallbackProfileId) : undefined) ??
      byId.get('profile-lead') ??
      null;

    const isUsable = (p: AgentProfileDTO | null | undefined): p is AgentProfileDTO =>
      Boolean(p && !input.registry.providerBlockedReason(p.provider, input.sandboxReady));

    const blockedReason = input.registry.providerBlockedReason(
      configuredPrimary.provider,
      input.sandboxReady,
    );

    let chosen: AgentProfileDTO | null = isUsable(configuredPrimary) ? configuredPrimary : null;
    let fallback: AgentProfileDTO | null =
      configuredFallback && isUsable(configuredFallback) && configuredFallback.id !== chosen?.id
        ? configuredFallback
        : null;
    let note: string | null = null;

    if (!chosen) {
      if (isUsable(configuredFallback)) {
        chosen = configuredFallback;
        note = `${configuredPrimary.name} routes to ${configuredPrimary.provider}, which is blocked. Reviewing with ${chosen.name} (${chosen.provider}) instead.`;
      } else {
        const anyUsable = profiles.find((p) => isUsable(p)) ?? null;
        if (!anyUsable) {
          return {
            primary: configuredPrimary,
            fallback: null,
            note: null,
            blocked: blockedReason ?? 'No usable reviewer profile is available.',
          };
        }
        chosen = anyUsable;
        note = `${configuredPrimary.name} routes to ${configuredPrimary.provider}, which is blocked. Reviewing with ${chosen.name} (${chosen.provider}) instead.`;
      }
      fallback = null;
    }

    // Cross-model preference (PRD design rule): prefer a different provider than the coder.
    if (chosen.provider === input.coderProvider) {
      const crossCandidate =
        (fallback && fallback.provider !== input.coderProvider ? fallback : null) ??
        profiles.find(
          (p) =>
            isUsable(p) &&
            p.provider !== input.coderProvider &&
            (p.permissionMode === 'read-only' ||
              /review|qa|lead/i.test(p.name)),
        ) ??
        profiles.find((p) => isUsable(p) && p.provider !== input.coderProvider) ??
        null;

      if (crossCandidate) {
        const previous = chosen;
        chosen = crossCandidate;
        fallback = isUsable(previous) && previous.id !== chosen.id ? previous : fallback;
        note = `Cross-model review: switched from ${previous.name} (${previous.provider}) to ${chosen.name} (${chosen.provider}) because coder used ${input.coderProvider}.`;
      } else {
        note = note ?? `Cross-model review unavailable (no other usable provider besides ${input.coderProvider}); reviewing with ${chosen.name}.`;
      }
    }

    // A review never edits the repo: DALANG writes review.json itself from the validated reply.
    const effectiveChosen = { ...chosen, permissionMode: 'read-only' as const };
    const effectiveFallback = fallback ? { ...fallback, permissionMode: 'read-only' as const } : null;

    return {
      primary: effectiveChosen,
      fallback: effectiveFallback && effectiveFallback.id !== effectiveChosen.id ? effectiveFallback : null,
      note,
      blocked: null,
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
    permissionMode: row.permissionMode as PermissionMode,
    timeoutMs: row.timeoutMs,
    idleTimeoutMs: row.idleTimeoutMs,
    maxParallel: row.maxParallel,
    maxReviewRounds: row.maxReviewRounds ?? 2,
    fallbackProfileId: row.fallbackProfileId ?? null,
    configDir: row.configDir ?? null,
    isDefault: Boolean(row.isDefault),
    createdAt: row.createdAt,
  };
}