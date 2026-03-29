import {
  boolean,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  InternalMcpCatalogServerType,
  LocalMcpServerInstallationStatus,
} from "@/types";
import mcpCatalogTable from "./internal-mcp-catalog";
import secretTable from "./secret";
import { team } from "./team";
import usersTable from "./user";

// OAuth refresh error codes:
// - refresh_failed: refresh was attempted but failed
// - no_refresh_token: can't attempt recovery, no refresh token available
export const oauthRefreshErrorEnum = pgEnum("oauth_refresh_error_enum", [
  "refresh_failed",
  "no_refresh_token",
]);

const mcpServerTable = pgTable("mcp_server", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  catalogId: uuid("catalog_id")
    .references(() => mcpCatalogTable.id, {
      onDelete: "set null",
    })
    .notNull(),
  serverType: text("server_type")
    .$type<InternalMcpCatalogServerType>()
    .notNull(),
  secretId: uuid("secret_id").references(() => secretTable.id, {
    onDelete: "set null",
  }),
  ownerId: text("owner_id").references(() => usersTable.id, {
    onDelete: "set null",
  }),
  teamId: text("team_id").references(() => team.id, {
    onDelete: "set null",
  }),
  reinstallRequired: boolean("reinstall_required").notNull().default(false),
  localInstallationStatus: text("local_installation_status")
    .notNull()
    .default("idle")
    .$type<LocalMcpServerInstallationStatus>(),
  localInstallationError: text("local_installation_error"),
  oauthRefreshError: oauthRefreshErrorEnum("oauth_refresh_error"),
  oauthRefreshFailedAt: timestamp("oauth_refresh_failed_at", { mode: "date" }),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default mcpServerTable;
