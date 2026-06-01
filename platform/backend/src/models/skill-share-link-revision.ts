import { asc, desc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  RevisionPayload,
  SkillShareLinkRevision,
} from "@/types/skill-share-link-revision";

interface AppendRevisionParams {
  linkId: string;
  contentHash: string;
  commitSha: string;
  parentSha: string | null;
  /** Stored verbatim and used as the commit timestamp on replay. */
  createdAt: Date;
  payload: RevisionPayload;
}

class SkillShareLinkRevisionModel {
  static async getLatestByLink(
    linkId: string,
  ): Promise<SkillShareLinkRevision | null> {
    const [row] = await db
      .select()
      .from(schema.skillShareLinkRevisionsTable)
      .where(eq(schema.skillShareLinkRevisionsTable.linkId, linkId))
      .orderBy(desc(schema.skillShareLinkRevisionsTable.sequence))
      .limit(1);
    return row ?? null;
  }

  static async listByLink(linkId: string): Promise<SkillShareLinkRevision[]> {
    return db
      .select()
      .from(schema.skillShareLinkRevisionsTable)
      .where(eq(schema.skillShareLinkRevisionsTable.linkId, linkId))
      .orderBy(asc(schema.skillShareLinkRevisionsTable.sequence));
  }

  /**
   * Appends a new revision. Caller owns deriving `sequence`/`parentSha`
   * from `getLatestByLink`; the in-memory per-link mutex in the materializer
   * keeps concurrent appends serialized within a single process. The unique
   * index on (link_id, sequence) is the backstop.
   */
  static async append(
    params: AppendRevisionParams,
    sequence: number,
  ): Promise<SkillShareLinkRevision> {
    const [row] = await db
      .insert(schema.skillShareLinkRevisionsTable)
      .values({
        linkId: params.linkId,
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
