import config from "@/config";
import { MarketplaceMaterializer } from "./materialize";

/**
 * Process-wide materializer singleton. State is the in-memory per-link mutex
 * map + the on-disk cache dir; both must be shared across every route plugin
 * and admin handler that touches a share link.
 *
 * Committer identity is intentionally hardcoded: the materializer's
 * deterministic-replay contract folds author+committer name/email into the
 * commit SHA, so a per-deployment override would orphan every revision row
 * the moment a new value rolled out.
 */
const MARKETPLACE_GIT_IDENTITY = {
  name: "Archestra Marketplace",
  email: "marketplace@archestra.local",
} as const;

class MarketplaceMaterializerSingleton {
  private instance: MarketplaceMaterializer | null = null;

  get(): MarketplaceMaterializer {
    if (this.instance) return this.instance;
    this.instance = new MarketplaceMaterializer({
      cacheDir: config.skillMarketplace.cacheDir,
      gitBinaryPath: config.git.binaryPath,
      identity: MARKETPLACE_GIT_IDENTITY,
    });
    return this.instance;
  }

  /** Reset for tests. */
  reset(): void {
    this.instance = null;
  }
}

export const marketplaceMaterializer = new MarketplaceMaterializerSingleton();
