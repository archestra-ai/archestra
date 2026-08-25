import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import organizationsTable from "./organization";
import usersTable from "./user";

/**
 * A materialized marketplace repository served from the static marketplace
 * URL — one row per (organization, viewer). The URL is the same for everyone;
 * the caller's credential decides which row backs the clone, and therefore
 * which skills the repo contains.
 *
 * `userId` null is the organization's anonymous view, used when the org allows
 * unauthenticated marketplace access. It carries org-scoped skills only.
 *
 * Rows are created lazily on the first clone, and their commit history lives
 * in `skill_share_link_revision` (keyed by `repo_id`), exactly like a share
 * link's — the on-disk repo is a derived cache that replays from there.
 *
 * `marketplaceName` is frozen at row creation for the same reason it is frozen
 * on a share link: clients register marketplaces by name in their local
 * config, so re-deriving it after an org rename would break every install.
 */
const skillMarketplaceReposTable = pgTable(
  "skill_marketplace_repo",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    /** Owner of this view; null = the org's anonymous (unauthenticated) view. */
    userId: text("user_id").references(() => usersTable.id, {
      onDelete: "cascade",
    }),
    marketplaceName: text("marketplace_name").notNull(),
    lastUsedAt: timestamp("last_used_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Two partial indexes rather than one over (org, user): NULLs are distinct
    // in a plain unique index, so the anonymous row would not be deduped.
    uniqueIndex("skill_marketplace_repo_org_user_uidx")
      .on(table.organizationId, table.userId)
      .where(sql`${table.userId} IS NOT NULL`),
    uniqueIndex("skill_marketplace_repo_org_anon_uidx")
      .on(table.organizationId)
      .where(sql`${table.userId} IS NULL`),
  ],
);

export default skillMarketplaceReposTable;
