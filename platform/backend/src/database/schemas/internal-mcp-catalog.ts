import {
  boolean,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { InternalMcpCatalogServerType, LocalConfig } from "@/types";
import secretTable from "./secret";

const internalMcpCatalogTable = pgTable("internal_mcp_catalog", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  version: text("version"),
  description: text("description"),
  instructions: text("instructions"),
  repository: text("repository"),
  installationCommand: text("installation_command"),
  requiresAuth: boolean("requires_auth").notNull().default(false),
  authDescription: text("auth_description"),
  authFields: jsonb("auth_fields")
    .$type<
      Array<{
        name: string;
        label: string;
        type: string;
        required: boolean;
        description?: string;
      }>
    >()
    .default([]),
  // Server type and remote configuration
  serverType: text("server_type")
    .$type<InternalMcpCatalogServerType>()
    .notNull(),
  serverUrl: text("server_url"), // For remote servers
  docsUrl: text("docs_url"), // Documentation URL for remote servers
  clientSecretId: uuid("client_secret_id").references(() => secretTable.id, {
    onDelete: "set null",
  }), // For OAuth client_secret storage
  localConfigSecretId: uuid("local_config_secret_id").references(
    () => secretTable.id,
    {
      onDelete: "set null",
    },
  ), // For local config secret env vars storage
  // Local server configuration - uses LocalConfig type from @/types
  localConfig: jsonb("local_config").$type<LocalConfig>(),
  userConfig: jsonb("user_config")
    .$type<
      Record<
        string,
        {
          type: "string" | "number" | "boolean" | "directory" | "file";
          title: string;
          description: string;
          required?: boolean;
          default?: string | number | boolean | Array<string>;
          multiple?: boolean;
          sensitive?: boolean;
          min?: number;
          max?: number;
        }
      >
    >()
    .default({}),
  // OAuth configuration for remote servers
  oauthConfig: jsonb("oauth_config").$type<{
    name: string;
    server_url: string;
    auth_server_url?: string;
    resource_metadata_url?: string;
    client_id: string;
    redirect_uris: Array<string>;
    scopes: Array<string>;
    description?: string;
    well_known_url?: string;
    default_scopes: Array<string>;
    supports_resource_metadata: boolean;
    generic_oauth?: boolean;
    token_endpoint?: string;
    access_token_env_var?: string;
    requires_proxy?: boolean;
    provider_name?: string;
    browser_auth?: boolean;
    streamable_http_url?: string;
    streamable_http_port?: number;
  }>(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default internalMcpCatalogTable;
