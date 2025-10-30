import {
  boolean,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { InternalMcpCatalogServerType } from "@/types/mcp-catalog";

const internalMcpCatalogTable = pgTable("internal_mcp_catalog", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Human-friendly display label for UI cards
  label: text("label"),
  name: text("name").notNull(),
  version: text("version"),
  description: text("description"),
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
  // Local server configuration
  localConfig: jsonb("local_config").$type<{
    command: string;
    arguments: Array<string>;
    environment?: Record<string, string>;
  }>(),
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
    client_secret?: string;
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
