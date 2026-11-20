import { eq } from 'drizzle-orm';
import {
  DEFAULT_USAGE_REFRESH_MINUTES,
  UiLanguageSchema,
  UsageRefreshMinutesSchema,
  type SettingsDTO,
  type UiLanguage,
  type UsageRefreshMinutes,
  type UpdateSettingsInput,
} from '@dalang/shared';
import type { DalangDb } from '../db/client.js';
import { settings } from '../db/schema.js';

const AGY_KEYRING_KEY = 'antigravity_keyring_access';
const LANGUAGE_KEY = 'ui_language';
const CHECK_UPDATES_KEY = 'check_for_updates';
const USAGE_REFRESH_KEY = 'usage_refresh_minutes';
const UPDATE_LATEST_KEY = 'update_check_latest';
const UPDATE_CHECKED_AT_KEY = 'update_check_at';

/**
 * Global DALANG settings persisted in the SQLite `settings` table.
 */
export class SettingsService {
  constructor(private readonly db: DalangDb) {}

  private getValue(key: string): string | null {
    return this.db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? null;
  }

  private setValue(key: string, value: string): void {
    this.db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } })
      .run();
  }

  private getBool(key: string, defaultValue = false): boolean {
    const raw = this.getValue(key);
    if (raw === null) return defaultValue;
    return raw === 'true';
  }

  private setBool(key: string, value: boolean): void {
    this.setValue(key, String(value));
  }

  antigravityKeyringAccess(): boolean {
    return this.getBool(AGY_KEYRING_KEY, false);
  }

  language(): UiLanguage | null {
    const raw = this.getValue(LANGUAGE_KEY);
    if (!raw) return null;
    const parsed = UiLanguageSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  resolvedLanguage(): UiLanguage {
    return this.language() ?? 'en';
  }

  checkForUpdates(): boolean {
    return this.getBool(CHECK_UPDATES_KEY, true);
  }

  usageRefreshMinutes(): UsageRefreshMinutes {
    const parsed = UsageRefreshMinutesSchema.safeParse(Number(this.getValue(USAGE_REFRESH_KEY)));
    return parsed.success ? parsed.data : DEFAULT_USAGE_REFRESH_MINUTES;
  }

  getUpdateCache(): { latestVersion: string | null; checkedAt: string | null } {
    return {
      latestVersion: this.getValue(UPDATE_LATEST_KEY),
      checkedAt: this.getValue(UPDATE_CHECKED_AT_KEY),
    };
  }

  /** Records an attempt; a failed check passes `null` and keeps the last known version. */
  setUpdateCache(latestVersion: string | null, checkedAt: string): void {
    if (latestVersion) this.setValue(UPDATE_LATEST_KEY, latestVersion);
    this.setValue(UPDATE_CHECKED_AT_KEY, checkedAt);
  }

  getAll(): SettingsDTO {
    return {
      antigravityKeyringAccess: this.antigravityKeyringAccess(),
      language: this.language(),
      checkForUpdates: this.checkForUpdates(),
      usageRefreshMinutes: this.usageRefreshMinutes(),
    };
  }

  update(input: UpdateSettingsInput): SettingsDTO {
    if (input.antigravityKeyringAccess !== undefined) {
      this.setBool(AGY_KEYRING_KEY, input.antigravityKeyringAccess);
    }
    if (input.language !== undefined) {
      this.setValue(LANGUAGE_KEY, input.language);
    }
    if (input.checkForUpdates !== undefined) {
      this.setBool(CHECK_UPDATES_KEY, input.checkForUpdates);
    }
    if (input.usageRefreshMinutes !== undefined) {
      this.setValue(USAGE_REFRESH_KEY, String(input.usageRefreshMinutes));
    }
    return this.getAll();
  }
}
