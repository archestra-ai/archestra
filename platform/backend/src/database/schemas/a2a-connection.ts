import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  A2aConnectionAuthConfig,
  A2aConnectionAuthType,
  A2aSecurityRequirement,
  A2aSelectedInterface,
} from "@/types/a2a-outbound";
import a2aRemoteAgentsTable from "./a2a-remote-agent";
import secretsTable from "./secret";

/** A credential-bearing, callable route to one external Agent Card identity. */
const a2aConnectionsTable = pgTable(
  "a2a_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    remoteAgentId: uuid("remote_agent_id")
      .notNull()
      .references(() => a2aRemoteAgentsTable.id, { onDelete: "cascade" }),
    selectedInterface: jsonb("selected_interface")
      .$type<A2aSelectedInterface>()
      .notNull(),
    /** The exact Agent Card requirement alternative this connection satisfies. */
    securityRequirement: jsonb(
      "security_requirement",
    ).$type<A2aSecurityRequirement>(),
    authType: text("auth_type")
      .$type<A2aConnectionAuthType>()
      .notNull()
      .default("none"),
    /** Non-secret auth metadata only, such as an API-key header name. */
    authConfig: jsonb("auth_config")
      .$type<A2aConnectionAuthConfig>()
      .notNull()
      .default({}),
    secretId: uuid("secret_id").references(() => secretsTable.id, {
      // Authenticated connections require a secret. Callers must remove or
      // reconfigure the connection before deleting that secret.
      onDelete: "restrict",
    }),
    enabled: boolean("enabled").notNull().default(true),
    lastVerifiedAt: timestamp("last_verified_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check(
      "a2a_connections_auth_type_check",
      sql`${table.authType} in ('none', 'bearer', 'api_key')`,
    ),
    check(
      "a2a_connections_secret_check",
      sql`(${table.authType} = 'none' and ${table.secretId} is null) or (${table.authType} <> 'none' and ${table.secretId} is not null)`,
    ),
    uniqueIndex("a2a_connections_remote_agent_id_uidx").on(table.remoteAgentId),
  ],
);

export default a2aConnectionsTable;
