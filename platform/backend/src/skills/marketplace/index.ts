import config from "@/config";
import { MarketplaceMaterializer } from "./materialize";

/**
 * Process-wide materializer singleton. State is the in-memory per-link mutex
 * map + the on-disk cache dir; both must be shared across every route plugin
 * and admin handler that touches a share link.
 */
class MarketplaceMaterializerSingleton {
  private instance: MarketplaceMaterializer | null = null;

  get(): MarketplaceMaterializer {
    if (this.instance) return this.instance;
    this.instance = new MarketplaceMaterializer({
      cacheDir: config.skillMarketplace.cacheDir,
      gitBinaryPath: config.git.binaryPath,
      identity: parseGitAuthor(config.git.author),
    });
    return this.instance;
  }

  /** Reset for tests. */
  reset(): void {
    this.instance = null;
  }
}

export const marketplaceMaterializer = new MarketplaceMaterializerSingleton();

// ===== Internal helpers =====

/** Parses `Name <email>` (RFC 5322-lite) into the materializer's identity shape. */
function parseGitAuthor(raw: string): { name: string; email: string } {
  const match = raw.match(/^\s*(.+?)\s*<([^>]+)>\s*$/);
  if (match) {
    return { name: match[1], email: match[2] };
  }
  return { name: raw.trim() || "Archestra Marketplace", email: "" };
}
