import { and, asc, desc, eq, isNull } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  MarketplaceRepoRef,
  RevisionPayload,
  SkillShareLinkRevision,
} from "@/types/skill-share-link-revision";
import { isUniqueConstraintError } from "@/utils/db";

interface AppendRevisionParams {
  ref: MarketplaceRepoRef;
  contentHash: string;
  commitSha: string;
  parentSha: string | null;
  /** Stored verbatim and used as the commit timestamp on replay. */
  createdAt: Date;
  payload: RevisionPayload;
}

class SkillShareLinkRevisionModel {
  static async getLatest(
    ref: MarketplaceRepoRef,
  ): Promise<SkillShareLinkRevision | null> {
    const [row] = await db
      .select()
      .from(schema.skillShareLinkRevisionsTable)
      .where(ownerFilter(ref))
      .orderBy(desc(schema.skillShareLinkRevisionsTable.sequence))
      .limit(1);
    return row ?? null;
  }

  static async list(
    ref: MarketplaceRepoRef,
  ): Promise<SkillShareLinkRevision[]> {
    return db
      .select()
      .from(schema.skillShareLinkRevisionsTable)
      .where(ownerFilter(ref))
      .orderBy(asc(schema.skillShareLinkRevisionsTable.sequence));
  }

  /**
   * Appends a new revision. Caller owns deriving `sequence`/`parentSha`
   * from `getLatest`; the in-memory per-repo mutex in the materializer
   * keeps concurrent appends serialized within a single process. The unique
   * index on (owner, sequence) is the backstop.
   */
  /**
   * Whether an `append` failure is the (owner, sequence) unique index tripping
   * — another replica claimed this sequence first, and the caller should
   * re-read the head and retry rather than fail the clone.
   */
  static isSequenceConflict(error: unknown, ref: MarketplaceRepoRef): boolean {
    return isUniqueConstraintError(
      error,
      ref.kind === "link"
        ? "skill_share_link_revision_link_seq_idx"
        : "skill_share_link_revision_repo_seq_idx",
    );
  }

  static async append(
    params: AppendRevisionParams,
    sequence: number,
  ): Promise<SkillShareLinkRevision> {
    const [row] = await db
      .insert(schema.skillShareLinkRevisionsTable)
      .values({
        ...ownerColumns(params.ref),
        sequence,
        contentHash: params.contentHash,
        commitSha: params.commitSha,
        parentSha: params.parentSha,
        createdAt: params.createdAt,
        payload: params.payload,
      })
      .returning();
    return row;
  }
}

export default SkillShareLinkRevisionModel;

// ===== Internal helpers =====

/**
 * Both owner columns are nullable, so filtering on one alone would also match
 * the other owner's rows if the id ever collided. Pin the unused column to
 * NULL to keep each chain strictly separate.
 */
function ownerFilter(ref: MarketplaceRepoRef) {
  return ref.kind === "link"
    ? and(
        eq(schema.skillShareLinkRevisionsTable.linkId, ref.id),
        isNull(schema.skillShareLinkRevisionsTable.repoId),
      )
    : and(
        eq(schema.skillShareLinkRevisionsTable.repoId, ref.id),
        isNull(schema.skillShareLinkRevisionsTable.linkId),
      );
}

function ownerColumns(ref: MarketplaceRepoRef): {
  linkId: string | null;
  repoId: string | null;
} {
  return ref.kind === "link"
    ? { linkId: ref.id, repoId: null }
    : { linkId: null, repoId: ref.id };
}
