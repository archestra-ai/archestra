// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { sql } from "drizzle-orm";
import {
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import agentsTable from "./agent";
import identityProvidersTable from "./identity-provider";

/**
 * The identity an agent acts as at one identity provider: its Microsoft Entra
 * agent identity app ID, its Okta AI agent client ID, or its own OAuth client
 * ID at a provider that takes RFC 8693 actor tokens. Tool calls whose token
 * exchange runs at that identity provider name this identity, so the provider
 * can tell the agents apart.
 */
const agentIdentityBindingsTable = pgTable(
  "agent_identity_bindings",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    identityProviderId: text("identity_provider_id")
      .notNull()
      .references(() => identityProvidersTable.id, { onDelete: "cascade" }),
    /** The agent's ID at the identity provider, as the provider shows it. */
    externalId: text("external_id").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.agentId, table.identityProviderId] }),
    // One identity at a provider acts for one agent, or the provider's audit
    // could not tell the agents apart. Provider IDs compare case-insensitively.
    externalIdUnique: uniqueIndex(
      "agent_identity_bindings_identity_provider_external_id_idx",
    ).on(table.identityProviderId, sql`lower(${table.externalId})`),
  }),
);

export default agentIdentityBindingsTable;
