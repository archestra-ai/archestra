import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import organizationsTable from "./organization";
import usersTable from "./user";

/**
 * A read-only credential for the static marketplace URL, scoped to one user.
 *
 * The setup script writes one of these into the client's marketplace URL so a
 * member installs shared skills with the same one command an admin gets. It is
 * deliberately NOT the user's personal token: that is a full platform
 * credential, and `plugin marketplace add` persists whatever it is given into
 * the user's local git config. This grants exactly one thing — cloning the
 * marketplace as its owner — and the clone still resolves through the owner's
 * live role, so losing `skill:read` stops it working without any revocation
 * step here.
 *
 * Several live rows per user is intentional: setting up a second client mints a
 * second credential rather than rotating the first, so configuring Cursor does
 * not silently break the marketplace already installed in Claude Code.
 */
const skillMarketplaceCredentialsTable = pgTable(
  "skill_marketplace_credential",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    /** SHA-256 of the raw token; the raw value is returned once, at mint. */
    tokenHash: text("token_hash").notNull().unique(),
    /** Leading characters, for identifying a credential without revealing it. */
    tokenStart: text("token_start").notNull(),
    lastUsedAt: timestamp("last_used_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("skill_marketplace_credential_org_user_idx").on(
      table.organizationId,
      table.userId,
    ),
  ],
);

export default skillMarketplaceCredentialsTable;
