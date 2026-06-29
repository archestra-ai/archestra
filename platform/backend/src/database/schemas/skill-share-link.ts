import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import organizationsTable from "./organization";
import skillsTable from "./skill";
import usersTable from "./user";

/**
 * Tokens for sharing skills via the public marketplace endpoint. The raw
 * token never lands on disk: we persist sha256(token) in `tokenHash` and
 * surface the first 22 characters in `tokenStart` for UI display. A link
 * may carry one or many skills (see `skillShareLinkSkillsTable`).
 *
 * `marketplaceName` is frozen at create time. Clients register marketplaces
 * by this name in their local config, so it must remain stable for the life
 * of the link.
 */
const skillShareLinksTable = pgTable(
  "skill_share_link",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    /** sha256 hex of the raw token; raw token is never stored. */
    tokenHash: text("token_hash").notNull(),
    /** First 22 characters of the raw token (prefix + random chars, for UI display). */
    tokenStart: varchar("token_start", { length: 22 }).notNull(),
    name: text("name"),
    marketplaceName: text("marketplace_name").notNull(),
    expiresAt: timestamp("expires_at", { mode: "date" }),
    revokedAt: timestamp("revoked_at", { mode: "date" }),
    lastUsedAt: timestamp("last_used_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("skill_share_link_token_hash_idx").on(table.tokenHash),
    index("skill_share_link_org_id_idx").on(table.organizationId),
    index("skill_share_link_token_start_idx").on(table.tokenStart),
  ],
);

/**
 * Junction table binding share links to the skills they expose. Plural from
 * day one so a single link can serve a skill set without a follow-up
 * migration.
 */
export const skillShareLinkSkillsTable = pgTable(
  "skill_share_link_skill",
  {
    shareLinkId: uuid("share_link_id")
      .notNull()
      .references(() => skillShareLinksTable.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skillsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.shareLinkId, table.skillId] }),
    index("skill_share_link_skill_skill_id_idx").on(table.skillId),
  ],
);

export default skillShareLinksTable;
