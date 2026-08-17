import config from "@/config";
import logger from "@/logging";
import KbChunkModel, { KB_CHUNKS_BM25_INDEX } from "@/models/kb-chunk";

/**
 * Runtime gate for BM25 keyword ranking (issue #7158).
 *
 * The ParadeDB pg_search extension cannot be assumed anywhere: managed
 * services (Cloud SQL, RDS) do not offer it, the bundled Bitnami/Alpine
 * Postgres images do not ship it, and the PGlite test database cannot load
 * it. So the flag in config only expresses intent; whether BM25 actually
 * runs is decided here by probing the database once for the extension and
 * its kb_chunks index. Every negative or failed probe leaves the keyword
 * leg on ts_rank — enabling the flag is inert until an operator provides a
 * Postgres with pg_search installed and migrations have built the index.
 */
class Bm25Capability {
  private probe: Promise<boolean> | null = null;

  /**
   * Whether the keyword leg should rank with BM25: config flag on AND the
   * pg_search extension AND its kb_chunks index present. The verdict is
   * probed once and cached for the process lifetime; a probe that *errors*
   * (as opposed to one that answers "not installed") is not cached, so a
   * transiently unreachable database does not pin the process to ts_rank.
   */
  async isReady(): Promise<boolean> {
    if (!config.kb.bm25RankingEnabled) return false;
    if (!this.probe) this.probe = this.runProbe();
    return this.probe;
  }

  /** Forget the cached verdict so the next query re-probes database support. */
  invalidate(): void {
    this.probe = null;
  }

  private async runProbe(): Promise<boolean> {
    try {
      const { extensionInstalled, indexPresent } =
        await KbChunkModel.probeBm25Support();
      if (extensionInstalled && indexPresent) {
        logger.info(
          "pg_search BM25 index detected; knowledge-base keyword search ranks with BM25",
        );
        return true;
      }
      if (extensionInstalled && !indexPresent) {
        logger.warn(
          `pg_search is installed but a ready ${KB_CHUNKS_BM25_INDEX} index is missing; keyword search stays on ts_rank (create the index, then restart Archestra)`,
        );
      }
      return false;
    } catch (error) {
      this.probe = null;
      logger.warn(
        { err: error },
        "Failed to probe pg_search BM25 support; keyword search stays on ts_rank",
      );
      return false;
    }
  }
}

export const bm25Capability = new Bm25Capability();
