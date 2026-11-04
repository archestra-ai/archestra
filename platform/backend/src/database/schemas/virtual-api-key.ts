import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { ResourceVisibilityScope, VirtualApiKeyType } from "@/types";
import secretsTable from "./secret";
import serviceAccountsTable from "./service-account";
import { team } from "./team";
import usersTable from "./user";

const virtualApiKeysTable = pgTable(
  "virtual_api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    name: varchar("name", { length: 256 }).notNull(),
    /**
     * Kind of key. `standard` maps to provider API keys and is sent in the
     * Authorization header; `passthrough` carries no provider credential and is
     * sent in the X-Archestra-Virtual-Key header for user attribution.
     */
    keyType: text("key_type")
      .$type<VirtualApiKeyType>()
      .notNull()
      .default("standard"),
    includeFutureProviders: boolean("include_future_providers")
      .notNull()
      .default(false),
    /** Reference to secret table where token value is stored */
    secretId: uuid("secret_id")
      .notNull()
      .references(() => secretsTable.id, { onDelete: "cascade" }),
    /** First 14 chars of token (archestra_xxxx) for display */
    tokenStart: varchar("token_start", { length: 16 }).notNull(),
    scope: text("scope")
      .$type<ResourceVisibilityScope>()
      .notNull()
      .default("org"),
    authorId: text("author_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }),
    /** Service account creator; separate from human ownership. */
    createdByServiceAccountId: uuid("created_by_service_account_id").references(
      () => serviceAccountsTable.id,
      { onDelete: "set null" },
    ),
    /**
     * Team this key's LLM spend is charged to. When set, the team's cost
     * limits and statistics count the key's usage in place of the LLM
     * proxy's teams, and the owner's personal limit does not apply.
     */
    billingTeamId: text("billing_team_id").references(() => team.id, {
      onDelete: "set null",
    }),
    /**
     * Automatic rotation interval. Null leaves the key's value in place until
     * someone rotates it.
     */
    rotationIntervalSeconds: integer("rotation_interval_seconds"),
    /** How long the old value keeps working after an automatic rotation. */
    rotationGracePeriodSeconds: integer("rotation_grace_period_seconds"),
    /** When automatic rotation next replaces the value; null when it is off. */
    nextRotationAt: timestamp("next_rotation_at", {
      mode: "date",
      withTimezone: true,
    }),
    lastRotatedAt: timestamp("last_rotated_at", {
      mode: "date",
      withTimezone: true,
    }),
    rotationCount: integer("rotation_count").notNull().default(0),
    /**
     * The value a rotation replaced, kept while its grace period runs so
     * clients can move to the new value. Accepted only until
     * `previousTokenExpiresAt`.
     */
    previousSecretId: uuid("previous_secret_id").references(
      () => secretsTable.id,
      { onDelete: "set null" },
    ),
    previousTokenStart: varchar("previous_token_start", { length: 16 }),
    previousTokenExpiresAt: timestamp("previous_token_expires_at", {
      mode: "date",
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { mode: "date" }),
  },
  (table) => [
    index("idx_virtual_api_key_organization_id").on(table.organizationId),
    index("idx_virtual_api_key_token_start").on(table.tokenStart),
    index("idx_virtual_api_key_scope").on(table.scope),
    index("idx_virtual_api_key_author_id").on(table.authorId),
    index("idx_virtual_api_key_previous_token_start")
      .on(table.previousTokenStart)
      .where(sql`${table.previousTokenStart} IS NOT NULL`),
    index("idx_virtual_api_key_next_rotation_at")
      .on(table.nextRotationAt)
      .where(sql`${table.nextRotationAt} IS NOT NULL`),
  ],
);

export default virtualApiKeysTable;
