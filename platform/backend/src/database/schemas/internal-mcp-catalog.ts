import {
  type AnyPgColumn,
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  AuthField,
  EnterpriseManagedCredentialConfig,
  InternalMcpCatalogServerType,
  LocalConfig,
  OAuthConfig,
  UserConfig,
  UserConfigFieldDefault,
} from "@/types";
import mcpPresetEntriesTable from "./mcp-preset-entry";
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
    /**
     * When true (self-hosted only): one shared K8s deployment per catalog,
     * caller-level credentials sent as request-time headers. When false:
     * one deployment per caller (default).
     */
    multitenant: boolean("multitenant").notNull().default(false),
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
    /**
     * Self-FK. NULL = root catalog item (parent / default preset).
     * Non-NULL = child catalog item (UI-named "preset"); inherits all template
     * columns from parent, overlays its own preset_field_values at runtime.
     */
    parentCatalogItemId: uuid("parent_catalog_item_id").references(
      (): AnyPgColumn => internalMcpCatalogTable.id,
      { onDelete: "cascade" },
    ),
    /**
     * For child catalog items (presets): the bare submitted name before
     * composition. The `name` column on a child stores `${parent.name}-${childName}`.
     * NULL for root catalog items.
     */
    childName: text("child_name"),
    /**
     * For child catalog items only: FK to the org-level preset entry this
     * child configures (e.g. "Production", "Staging"). Cascade-deleted when
     * the entry is removed at /mcp/registry/org-structure. NULL for root rows.
     * Canonical link — `child_name` is just a denormalized display copy.
     */
    presetEntryId: uuid("preset_entry_id").references(
      () => mcpPresetEntriesTable.id,
      { onDelete: "cascade" },
    ),
    /**
     * Values for fields the parent declared with promptOnPreset: true.
     * Meaningful on parent (= default preset values) AND child (= preset overlay).
     * Stores only non-secret values; secret-typed preset values live in the
     * secret bundle referenced by presetSecretId.
     */
    presetFieldValues: jsonb("preset_field_values")
      .$type<Record<string, UserConfigFieldDefault>>()
      .notNull()
      .default({}),
    /**
     * Bundle of secret-typed preset values (userConfig.sensitive=true or env
     * type=secret) for this catalog row. Same `{ <field_key>: <value> }`
     * shape as clientSecretId / localConfigSecretId — one row per catalog
     * row (parent or child).
     */
    presetSecretId: uuid("preset_secret_id").references(() => secretTable.id, {
      onDelete: "set null",
    }),
    /**
     * To re-install multi-tenant self-hosted MCPs.
     *
     * Set to `true` when an admin/owner edits a catalog-scope execution
     * field (image, command, args, transport) on a `multitenant: true` +
     * `serverType: "local"` catalog. Cleared by the catalog-reinstall
     * endpoint after the shared K8s Deployment is updated and tools are
     * re-synced for every install attached to this catalog.
     *
     * Not used for single-tenant or remote catalogs — those keep using
     * the per-install `mcp_server.reinstall_required` flag.
     */
    catalogReinstallRequired: boolean("catalog_reinstall_required")
      .notNull()
      .default(false),
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
    parentIdIdx: index("internal_mcp_catalog_parent_id_idx").on(
      table.parentCatalogItemId,
    ),
    parentNameUnique: unique("internal_mcp_catalog_parent_name_unique").on(
      table.parentCatalogItemId,
      table.name,
    ),
  }),
);

export default internalMcpCatalogTable;
