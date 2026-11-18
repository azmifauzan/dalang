import { eq } from 'drizzle-orm';
import type { SettingsDTO } from '@dalang/shared';
import type { DalangDb } from '../db/client.js';
import { settings } from '../db/schema.js';

const AGY_KEYRING_KEY = 'antigravity_keyring_access';

/**
 * Global switches. Every one defaults to off, and the v0.3 agent profile editor is where they get
 * a proper home; until then they are changed from the Providers page.
 */
export class SettingsService {
  constructor(private readonly db: DalangDb) {}

  private getBool(key: string): boolean {
    return this.db.select().from(settings).where(eq(settings.key, key)).get()?.value === 'true';
  }

  private setBool(key: string, value: boolean): void {
    this.db
      .insert(settings)
      .values({ key, value: String(value) })
      .onConflictDoUpdate({ target: settings.key, set: { value: String(value) } })
      .run();
  }

  antigravityKeyringAccess(): boolean {
    return this.getBool(AGY_KEYRING_KEY);
  }

  getAll(): SettingsDTO {
    return { antigravityKeyringAccess: this.antigravityKeyringAccess() };
  }

  update(input: Partial<SettingsDTO>): SettingsDTO {
    if (input.antigravityKeyringAccess !== undefined) {
      this.setBool(AGY_KEYRING_KEY, input.antigravityKeyringAccess);
    }
    return this.getAll();
  }
}
