import { sql } from "drizzle-orm";
import {
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
import skillShareLinksTable from "./skill-share-link";

/**
 * One row per materialized git commit served from a share link. Together
 * the rows form a deterministic, append-only commit chain — the on-disk
 * cache is a derived view that can be rebuilt at any time by replaying
 * these revisions in `sequence` order.
 *
 * Determinism: the same (parent_sha, payload, identity, created_at, message)
 * inputs always produce the same `commit_sha`. Storing `commit_sha` lets us
 * verify replay correctness rather than recompute from raw bytes.
 */
const skillShareLinkRevisionsTable = pgTable(
  "skill_share_link_revision",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    linkId: uuid("link_id")
      .notNull()
      .references(() => skillShareLinksTable.id, { onDelete: "cascade" }),
    /** Monotonic per `linkId`, starting at 1. */
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
  ],
);

export default skillShareLinkRevisionsTable;
