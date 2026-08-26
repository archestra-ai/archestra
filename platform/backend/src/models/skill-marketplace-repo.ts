import { and, eq, isNull } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import type { SkillMarketplaceRepo } from "@/types";

/**
 * How stale `lastUsedAt` may get before a clone refreshes it. Every git
 * request touches the row, so an unconditional write turns it into a lock hot
 * spot when a client fetches in a loop; the window collapses a burst into at
 * most one write. Mirrors `UserTokenModel`.
 */
const LAST_USED_REFRESH_INTERVAL_MS = 60_000;

/**
 * Per-viewer marketplace repositories behind the static marketplace URL. A row
 * is the durable identity of one materialized git repo: its id names the
 * on-disk cache directory and owns the revision chain in
 * `skill_share_link_revision`, so it must survive for as long as anyone has
 * the marketplace registered locally.
 */
class SkillMarketplaceRepoModel {
  /**
   * The repo backing this viewer, created on first use. `userId` null is the
   * organization's anonymous view. Concurrent first clones race on the partial
   * unique indexes; the loser re-reads the winner's row rather than failing.
   */
  static async ensureForViewer(params: {
    organizationId: string;
    userId: string | null;
    /** Frozen onto the row at creation; ignored once the row exists. */
    marketplaceName: string;
  }): Promise<SkillMarketplaceRepo> {
    const existing = await SkillMarketplaceRepoModel.findForViewer(params);
    if (existing) return existing;

    const [created] = await db
      .insert(schema.skillMarketplaceReposTable)
      .values({
        organizationId: params.organizationId,
        userId: params.userId,
        marketplaceName: params.marketplaceName,
      })
      .onConflictDoNothing()
      .returning();

    if (created) return created;

    const raced = await SkillMarketplaceRepoModel.findForViewer(params);
    if (!raced) {
      throw new Error(
        "skill marketplace repo insert conflicted but no row was found",
      );
    }
    return raced;
  }

  static async findForViewer(params: {
    organizationId: string;
    userId: string | null;
  }): Promise<SkillMarketplaceRepo | null> {
    const [row] = await db
      .select()
      .from(schema.skillMarketplaceReposTable)
      .where(
        and(
          eq(
            schema.skillMarketplaceReposTable.organizationId,
            params.organizationId,
          ),
          params.userId === null
            ? isNull(schema.skillMarketplaceReposTable.userId)
            : eq(schema.skillMarketplaceReposTable.userId, params.userId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Every repo id, for the startup sweep of orphaned cache directories. */
  static async listIds(): Promise<string[]> {
    const rows = await db
      .select({ id: schema.skillMarketplaceReposTable.id })
      .from(schema.skillMarketplaceReposTable);
    return rows.map((row) => row.id);
  }

  /**
   * Fire-and-forget last-used bookkeeping; never awaited on the clone path.
   * Skips the write when the stored value is already fresh.
   */
  static touch(repo: SkillMarketplaceRepo): void {
    const lastUsedAt = repo.lastUsedAt?.getTime() ?? 0;
    if (Date.now() - lastUsedAt < LAST_USED_REFRESH_INTERVAL_MS) return;

    void db
      .update(schema.skillMarketplaceReposTable)
      .set({ lastUsedAt: new Date(), updatedAt: repo.updatedAt })
      .where(eq(schema.skillMarketplaceReposTable.id, repo.id))
      .catch((err: unknown) => {
        logger.warn(
          { err, repoId: repo.id },
          "skillMarketplaceRepo.touch: failed to update lastUsedAt",
        );
      });
  }
}

export default SkillMarketplaceRepoModel;
