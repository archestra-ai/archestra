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

/**
 * An external agent identity and its last accepted public Agent Card.
 * Credentials intentionally live on a2a_connections so one remote identity can
 * be reached through more than one security context without leaking secrets
 * into discovery data.
 */
const a2aRemoteAgentsTable = pgTable(
  "a2a_remote_agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    discoveryMode: text("discovery_mode").$type<A2aDiscoveryMode>().notNull(),
    discoveryUrl: text("discovery_url"),
    /** Validated, normalized A2A Agent Card. Never contains credentials. */
    agentCard: jsonb("agent_card").$type<Record<string, unknown>>().notNull(),
    cardHash: text("card_hash").notNull(),
    etag: text("etag"),
    lastModified: text("last_modified"),
    lastDiscoveredAt: timestamp("last_discovered_at", { mode: "date" })
      .notNull()
      .defaultNow(),
    discoveryError: text("discovery_error"),
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
  ],
);

export default a2aRemoteAgentsTable;
