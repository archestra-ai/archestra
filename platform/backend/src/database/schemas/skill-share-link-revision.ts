import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { RevisionPayload } from "@/types/skill-share-link-revision";
import skillMarketplaceReposTable from "./skill-marketplace-repo";
import skillShareLinksTable from "./skill-share-link";

/**
 * One row per materialized git commit served from a marketplace repository.
 * Together the rows form a deterministic, append-only commit chain — the
 * on-disk cache is a derived view that can be rebuilt at any time by replaying
 * these revisions in `sequence` order.
 *
 * A revision belongs to exactly one owner: a share link (`link_id`, the
 * token-addressed marketplace) or a static marketplace repo (`repo_id`, the
 * per-viewer marketplace behind the shared static URL). The table predates the
 * second owner and keeps its original name; the CHECK constraint is what makes
 * the "exactly one" contract explicit.
 *
 * Determinism: the same (parent_sha, payload, identity, created_at, message)
 * inputs always produce the same `commit_sha`. Storing `commit_sha` lets us
 * verify replay correctness rather than recompute from raw bytes.
 */
const skillShareLinkRevisionsTable = pgTable(
  "skill_share_link_revision",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    linkId: uuid("link_id").references(() => skillShareLinksTable.id, {
      onDelete: "cascade",
    }),
    repoId: uuid("repo_id").references(() => skillMarketplaceReposTable.id, {
      onDelete: "cascade",
    }),
    /** Monotonic per owner (`linkId` or `repoId`), starting at 1. */
    sequence: integer("sequence").notNull(),
    /** sha256 of the canonical payload bytes; used to dedupe consecutive revisions. */
    contentHash: text("content_hash").notNull(),
    /** Deterministic git commit SHA-1 of the resulting commit object. */
    commitSha: text("commit_sha").notNull(),
    /** `commit_sha` of the previous revision (NULL only when `sequence = 1`). */
    parentSha: text("parent_sha"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .default(sql`now()`),
    /** Full byte-for-byte file list at this revision, sufficient to rebuild the tree. */
    payload: jsonb("payload").$type<RevisionPayload>().notNull(),
  },
  (table) => [
    uniqueIndex("skill_share_link_revision_link_seq_idx").on(
      table.linkId,
      table.sequence,
    ),
    index("skill_share_link_revision_link_id_idx").on(table.linkId),
    uniqueIndex("skill_share_link_revision_repo_seq_idx").on(
      table.repoId,
      table.sequence,
    ),
    index("skill_share_link_revision_repo_id_idx").on(table.repoId),
    check(
      "skill_share_link_revision_owner_check",
      sql`(${table.linkId} IS NULL) != (${table.repoId} IS NULL)`,
    ),
  ],
);

export default skillShareLinkRevisionsTable;
