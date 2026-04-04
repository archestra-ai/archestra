import {
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  AuthField,
  EnterpriseManagedCredentialConfig,
  InternalMcpCatalogServerType,
  LocalConfig,
  OAuthConfig,
  UserConfig,
} from "@/types";
import secretTable from "./secret";
import usersTable from "./user";

export const mcpCatalogScopeEnum = pgEnum("mcp_catalog_scope", [
  "personal",
  "team",
  "org",
]);

const internalMcpCatalogTable = pgTable(
  "internal_mcp_catalog",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    version: text("version"),
    description: text("description"),
    instructions: text("instructions"),
    repository: text("repository"),
    installationCommand: text("installation_command"),
    requiresAuth: boolean("requires_auth").notNull().default(false),
    authDescription: text("auth_description"),
    authFields: jsonb("auth_fields").$type<Array<AuthField>>().default([]),
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
    // Custom Kubernetes deployment spec YAML (if null, generated from localConfig)
    deploymentSpecYaml: text("deployment_spec_yaml"),
    userConfig: jsonb("user_config").$type<UserConfig>().default({}),
    // OAuth configuration for remote servers
    oauthConfig: jsonb("oauth_config").$type<OAuthConfig>(),
    enterpriseManagedConfig: jsonb(
      "enterprise_managed_config",
    ).$type<EnterpriseManagedCredentialConfig>(),
    /** Catalog item icon: emoji character or base64-encoded image data URL */
    icon: text("icon"),
    organizationId: text("organization_id"),
    authorId: text("author_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    scope: mcpCatalogScopeEnum("scope").notNull().default("org"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    organizationIdIdx: index("internal_mcp_catalog_organization_id_idx").on(
      table.organizationId,
    ),
    authorIdIdx: index("internal_mcp_catalog_author_id_idx").on(table.authorId),
    scopeIdx: index("internal_mcp_catalog_scope_idx").on(table.scope),
  }),
);

export default internalMcpCatalogTable;
