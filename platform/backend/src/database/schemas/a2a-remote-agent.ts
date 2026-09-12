import type { ResourceVisibilityScope } from "@archestra/shared";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { A2aDiscoveryMode } from "@/types/a2a-outbound";
import organizationsTable from "./organization";
import serviceAccountsTable from "./service-account";
import usersTable from "./user";

/**
 * An external agent identity and its last accepted public Agent Card.
 * Credentials live on the connection so discovery metadata stays non-secret.
 */
const a2aRemoteAgentsTable = pgTable(
  "a2a_remote_agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    authorId: text("author_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    scope: text("scope")
      .$type<ResourceVisibilityScope>()
      .notNull()
      .default("org"),
    name: text("name").notNull(),
    description: text("description"),
    discoveryMode: text("discovery_mode").$type<A2aDiscoveryMode>().notNull(),
    discoveryUrl: text("discovery_url"),
    /**
     * Validated, normalized A2A Agent Card. Never contains Archestra-managed
     * connection credentials; remote card metadata remains untrusted.
     */
    agentCard: jsonb("agent_card").$type<Record<string, unknown>>().notNull(),
    cardHash: text("card_hash").notNull(),
    lastDiscoveredAt: timestamp("last_discovered_at", { mode: "date" })
      .notNull()
      .defaultNow(),
    /** Service account creator; separate from human ownership. */
    createdByServiceAccountId: uuid("created_by_service_account_id").references(
      () => serviceAccountsTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check(
      "a2a_remote_agents_discovery_mode_check",
      sql`${table.discoveryMode} in ('well_known', 'card_url', 'inline_card')`,
    ),
    check(
      "a2a_remote_agents_discovery_url_check",
      sql`(${table.discoveryMode} = 'inline_card' and ${table.discoveryUrl} is null) or (${table.discoveryMode} <> 'inline_card' and ${table.discoveryUrl} is not null)`,
    ),
    index("a2a_remote_agents_organization_id_idx").on(table.organizationId),
    index("a2a_remote_agents_author_id_idx").on(table.authorId),
  ],
);

export default a2aRemoteAgentsTable;
