import { asc } from 'drizzle-orm';
import type { AgentProfileDTO, EffortLevel, ProviderId } from '@dalang/shared';
import type { DalangDb } from '../db/client.js';
import { agentProfiles } from '../db/schema.js';

/** Profiles are seeded defaults in v0.1; creating and editing them arrives with the v0.3 settings UI. */
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
