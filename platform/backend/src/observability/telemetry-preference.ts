import config from "@/config";
import logger from "@/logging";
import { registerProcessLocalCache } from "@/process-local-cache-registry";

/**
 * Whether telemetry (product analytics, instance heartbeats, and error
 * reports to Archestra's project) may leave this installation.
 *
 * Two switches, and both must be on: the deployment's ARCHESTRA_ANALYTICS
 * setting, and the choice an admin made in the first-run setup dialog
 * (`organization.telemetry_enabled`). The admin's choice is cached per
 * process for a minute, so another replica follows a change within that
 * time. When the choice cannot be read, nothing is sent.
 *
 * This module sits below the models (error reporting uses it), so the
 * organization model registers how the choice is read.
 */
class TelemetryPreference {
  private cached: { optedIn: boolean; expiresAt: number } | null = null;
  private readChoice: (() => Promise<boolean>) | null = null;

  /** Called once by the organization model when it loads. */
  setReader(readChoice: () => Promise<boolean>): void {
    this.readChoice = readChoice;
  }

  /** Both switches: the deployment setting and the admin's choice. */
  async isEnabled(): Promise<boolean> {
    if (!config.analytics.enabled) return false;
    return this.isOptedIn();
  }

  /** The admin's choice alone, for callers that check the deployment setting themselves. */
  async isOptedIn(): Promise<boolean> {
    if (this.cached && this.cached.expiresAt > Date.now()) {
      return this.cached.optedIn;
    }
    // The models have not loaded yet (early startup).
    if (!this.readChoice) return false;
    try {
      return this.remember(await this.readChoice());
    } catch (error) {
      logger.warn(
        { err: error },
        "Failed to read the telemetry preference; telemetry stays off",
      );
      return false;
    }
  }

  /** The choice was just saved by this process: apply it without waiting for the cache to expire. */
  remember(optedIn: boolean): boolean {
    this.cached = { optedIn, expiresAt: Date.now() + CACHE_TTL_MS };
    return optedIn;
  }

  clear(): void {
    this.cached = null;
  }
}

const CACHE_TTL_MS = 60_000;

export const telemetryPreference = registerProcessLocalCache(
  new TelemetryPreference(),
);
