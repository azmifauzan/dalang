import { DALANG_VERSION, type UpdateStatusDTO } from '@dalang/shared';
import type { SettingsService } from './settings.js';

export const NPM_REGISTRY_LATEST_URL = 'https://registry.npmjs.org/dalang-cli/latest';
export const RELEASE_NOTES_URL = 'https://github.com/azmifauzan/dalang/blob/main/CHANGELOG.md';
export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

export type UpdateRegistryFetcher = () => Promise<string | null>;

/**
 * Compares two semver strings (e.g. "0.6.0" vs "0.7.0").
 * Returns > 0 if `a` is newer than `b`, < 0 if older, 0 if equal.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const clean = v.trim().replace(/^v/i, '');
    const [core, prerelease = ''] = clean.split('-', 2);
    const parts = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
    return {
      major: parts[0] ?? 0,
      minor: parts[1] ?? 0,
      patch: parts[2] ?? 0,
      prerelease,
    };
  };

  const pa = parse(a);
  const pb = parse(b);
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (!pa.prerelease && pb.prerelease) return 1;
  if (pa.prerelease && !pb.prerelease) return -1;
  return pa.prerelease.localeCompare(pb.prerelease);
}

export async function fetchLatestNpmVersion(timeoutMs = 4000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(NPM_REGISTRY_LATEST_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: unknown };
    return typeof data.version === 'string' && data.version.trim() ? data.version.trim() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface UpdateCheckOptions {
  currentVersion?: string;
  fetcher?: UpdateRegistryFetcher;
  now?: () => number;
  ttlMs?: number;
}

/**
 * Checks npm registry at most once every 24h for a newer `dalang-cli` release, caching
 * the result in the SQLite `settings` table. Sends no project, account, or usage data,
 * and fails silently when offline or when disabled.
 */
export class UpdateCheckService {
  private readonly currentVersion: string;
  private readonly fetcher: UpdateRegistryFetcher;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private inFlight: Promise<UpdateStatusDTO> | null = null;

  constructor(
    private readonly settings: SettingsService,
    options: UpdateCheckOptions = {},
  ) {
    this.currentVersion = options.currentVersion ?? DALANG_VERSION;
    this.fetcher = options.fetcher ?? fetchLatestNpmVersion;
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? UPDATE_CHECK_TTL_MS;
  }

  async getStatus(opts: { force?: boolean } = {}): Promise<UpdateStatusDTO> {
    if (!this.settings.checkForUpdates()) {
      return {
        currentVersion: this.currentVersion,
        latestVersion: null,
        updateAvailable: false,
        checkedAt: null,
        checkEnabled: false,
        releaseNotesUrl: RELEASE_NOTES_URL,
      };
    }

    const cache = this.settings.getUpdateCache();
    const checkedMs = cache.checkedAt ? Date.parse(cache.checkedAt) : Number.NaN;
    // A failed attempt also counts, so an offline machine asks at most once per TTL.
    const cacheFresh =
      !opts.force && Number.isFinite(checkedMs) && this.now() - checkedMs < this.ttlMs;

    if (cacheFresh) return this.statusFrom(cache.latestVersion, cache.checkedAt);

    if (!this.inFlight) {
      this.inFlight = this.runFetch(cache).finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private statusFrom(latest: string | null, checkedAt: string | null): UpdateStatusDTO {
    return {
      currentVersion: this.currentVersion,
      latestVersion: latest,
      updateAvailable: latest !== null && compareSemver(latest, this.currentVersion) > 0,
      checkedAt,
      checkEnabled: true,
      releaseNotesUrl: RELEASE_NOTES_URL,
    };
  }

  private async runFetch(cache: {
    latestVersion: string | null;
    checkedAt: string | null;
  }): Promise<UpdateStatusDTO> {
    let latest: string | null = null;
    try {
      latest = await this.fetcher();
    } catch {
      // Offline or registry unreachable: fail silently without showing an error.
    }
    const checkedAt = new Date(this.now()).toISOString();
    this.settings.setUpdateCache(latest, checkedAt);
    return this.statusFrom(latest ?? cache.latestVersion, checkedAt);
  }
}
