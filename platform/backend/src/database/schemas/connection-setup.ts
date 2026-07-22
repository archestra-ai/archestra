import type { SupportedProvider } from "@archestra/shared";
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  ConnectionSetupClientId,
  ConnectionSetupPlatform,
  ConnectionSetupProxyAuth,
} from "@/types/connection-setup";
import agentsTable from "./agent";
import organizationsTable from "./organization";
import skillsTable from "./skill";
import skillShareLinksTable from "./skill-share-link";
import usersTable from "./user";
import virtualApiKeysTable from "./virtual-api-key";

/**
 * Short-lived "render tickets" for the /connection one-command setup flow.
 * A row stores wizard selections only — never rendered script text or raw
 * secrets. The raw setup token never lands on disk: we persist sha256(token)
 * in `tokenHash` and the first 22 characters in `tokenStart` for display.
 *
 * The script endpoint consumes a row exactly once (`consumedAt` is an atomic
 * claim); rows also expire via `expiresAt`. Expired/consumed rows are inert.
 */
const connectionSetupsTable = pgTable(
  "connection_setups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    clientId: text("client_id").$type<ConnectionSetupClientId>().notNull(),
    /** Target OS: "macos"/"linux" render bash, "windows" renders PowerShell. */
    platform: text("platform")
      .$type<ConnectionSetupPlatform>()
      .notNull()
      .default("macos"),
    baseUrl: text("base_url").notNull(),
    mcpGatewayId: uuid("mcp_gateway_id").references(() => agentsTable.id, {
      onDelete: "cascade",
    }),
    llmProxyId: uuid("llm_proxy_id").references(() => agentsTable.id, {
      onDelete: "cascade",
    }),
    provider: text("provider").$type<SupportedProvider>(),
    /** "provider-key" = passthrough (base URL only); "virtual-key" = injected key. */
    proxyAuth: text("proxy_auth")
      .$type<ConnectionSetupProxyAuth>()
      .notNull()
      .default("provider-key"),
    /** Personal virtual key provisioned at create time; value injected at render. */
    virtualApiKeyId: uuid("virtual_api_key_id").references(
      () => virtualApiKeysTable.id,
      { onDelete: "set null" },
    ),
    includeSkills: boolean("include_skills").notNull().default(false),
    /** TTL in days for the lazily-created skill share link; null = never expires. */
    skillLinkTtlDays: integer("skill_link_ttl_days"),
    /** Set after the script fetch lazily creates the share link (audit/revocation). */
    skillShareLinkId: uuid("skill_share_link_id").references(
      () => skillShareLinksTable.id,
      { onDelete: "set null" },
    ),
    /** sha256 hex of the raw setup token; raw token is never stored. */
    tokenHash: text("token_hash").notNull(),
    /** First 22 characters of the raw token, for UI display. */
    tokenStart: varchar("token_start", { length: 22 }).notNull(),
    expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
    consumedAt: timestamp("consumed_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("connection_setups_token_hash_idx").on(table.tokenHash),
    index("connection_setups_org_id_idx").on(table.organizationId),
    index("connection_setups_token_start_idx").on(table.tokenStart),
  ],
);

/** Skills the lazily-created share link should expose (when `includeSkills`). */
export const connectionSetupSkillsTable = pgTable(
  "connection_setup_skills",
  {
    connectionSetupId: uuid("connection_setup_id")
      .notNull()
      .references(() => connectionSetupsTable.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skillsTable.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.connectionSetupId, table.skillId] }),
    index("connection_setup_skills_skill_id_idx").on(table.skillId),
  ],
);

export default connectionSetupsTable;
