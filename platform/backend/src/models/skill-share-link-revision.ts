import { and, asc, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  MarketplaceRepoRef,
  ReplayRevision,
  RevisionHead,
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
  /**
   * The newest revision's head, without its payload: every git request reads
   * this, so it must not drag the full file list along.
   */
  static async getLatestHead(
    ref: MarketplaceRepoRef,
  ): Promise<RevisionHead | null> {
    const [row] = await db
      .select({
        sequence: schema.skillShareLinkRevisionsTable.sequence,
        contentHash: schema.skillShareLinkRevisionsTable.contentHash,
        commitSha: schema.skillShareLinkRevisionsTable.commitSha,
      })
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

  /** `commitSha` of the revisions at the given sequences, no payload. */
  static async listCommitShas(
    ref: MarketplaceRepoRef,
    sequences: number[],
  ): Promise<Array<{ sequence: number; commitSha: string }>> {
    if (sequences.length === 0) return [];
    return db
      .select({
        sequence: schema.skillShareLinkRevisionsTable.sequence,
        commitSha: schema.skillShareLinkRevisionsTable.commitSha,
      })
      .from(schema.skillShareLinkRevisionsTable)
      .where(
        and(
          ownerFilter(ref),
          inArray(schema.skillShareLinkRevisionsTable.sequence, sequences),
        ),
      );
  }

  /** Up to `limit` revisions strictly after `sequence`, oldest first. */
  static async listAfter(
    ref: MarketplaceRepoRef,
    sequence: number,
    limit: number,
  ): Promise<ReplayRevision[]> {
    return db
      .select({
        sequence: schema.skillShareLinkRevisionsTable.sequence,
        contentHash: schema.skillShareLinkRevisionsTable.contentHash,
        commitSha: schema.skillShareLinkRevisionsTable.commitSha,
        createdAt: schema.skillShareLinkRevisionsTable.createdAt,
        payload: schema.skillShareLinkRevisionsTable.payload,
      })
      .from(schema.skillShareLinkRevisionsTable)
      .where(
        and(
          ownerFilter(ref),
          gt(schema.skillShareLinkRevisionsTable.sequence, sequence),
        ),
      )
      .orderBy(asc(schema.skillShareLinkRevisionsTable.sequence))
      .limit(limit);
  }

  /**
   * Appends a new revision. Caller owns deriving `sequence`/`parentSha`
   * from `getLatestHead`; the in-memory per-repo mutex in the materializer
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
