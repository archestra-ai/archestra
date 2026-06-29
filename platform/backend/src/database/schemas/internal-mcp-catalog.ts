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
import environmentsTable from "./environment";
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
    /**
     * Agent connections policy for call-time ("dynamic") credential
     * resolution. NULL (default) = resolve at call time: each caller uses its
     * own connection (user token → that user's install, team token → that
     * team's install) and gets an actionable connect prompt when none exists.
     * Set to an mcp_servers.id to pin a service account: every
     * runtime-resolved agent call connects through that installation,
     * regardless of the caller. Intentionally NOT a DB-level FK — mcp_servers
     * already references this table, so the FK would create a schema import
     * cycle; the resolver re-validates the id against the catalog's installs
     * on every call, so a revoked connection degrades to resolve-at-call-time
     * instead of dangling.
     */
    dynamicConnectionMcpServerId: uuid("dynamic_connection_mcp_server_id"),
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
     * Legacy preset column — the "preset" (child catalog item) feature was
     * removed; retained inert (non-destructive, no migration). Self-FK:
     * NULL = root catalog item, non-NULL = a legacy child row ("preset").
     * Application code no longer creates children; the only live uses are an
     * `IS NULL` filter that hides any pre-existing legacy child rows and the
     * parent-delete cascade that tears down their servers/secrets.
     */
    parentCatalogItemId: uuid("parent_catalog_item_id").references(
      (): AnyPgColumn => internalMcpCatalogTable.id,
      { onDelete: "cascade" },
    ),
    /**
     * Legacy preset column (feature removed) — retained inert. Held a child
     * row's bare name; the composed `name` was `${parent.name}-${childName}`.
     * NULL for root rows; no longer read or written.
     */
    childName: text("child_name"),
    /**
     * Self-FK lineage pointer: the catalog item this one was cloned from.
     * NULL for non-clones. ON DELETE SET NULL so deleting the source leaves
     * the clone intact (just untracked), unlike the legacy parent-catalog cascade.
     */
    clonedFrom: uuid("cloned_from").references(
      (): AnyPgColumn => internalMcpCatalogTable.id,
      { onDelete: "set null" },
    ),
    /**
     * Legacy preset column (feature removed) — retained inert. FK to the
     * org-level preset-entry table a child row configured. NULL for root
     * rows; no longer read or written.
     */
    presetEntryId: uuid("preset_entry_id").references(
      () => mcpPresetEntriesTable.id,
      { onDelete: "cascade" },
    ),
    /**
     * Legacy preset column (feature removed) — retained inert. Held the
     * non-secret preset field values for a row (secret-typed ones lived in
     * the bundle referenced by presetSecretId). No longer read or written.
     */
    presetFieldValues: jsonb("preset_field_values")
      .$type<Record<string, UserConfigFieldDefault>>()
      .notNull()
      .default({}),
    /**
     * Legacy preset column (feature removed) — retained inert. Referenced a
     * secret bundle of secret-typed preset values for the row. No longer read
     * or written.
     */
    presetSecretId: uuid("preset_secret_id").references(() => secretTable.id, {
      onDelete: "set null",
    }),
    /**
     * Optional deployment environment this catalog item is assigned to.
     * NULL = the virtual "Default" environment. Set-null on environment delete
     * so items survive environment removal. Assignment is ungated in this
     * iteration (see spec §9).
     */
    environmentId: uuid("environment_id").references(
      () => environmentsTable.id,
      { onDelete: "set null" },
    ),
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
    clonedFromIdx: index("internal_mcp_catalog_cloned_from_idx").on(
      table.clonedFrom,
    ),
    parentNameUnique: unique("internal_mcp_catalog_parent_name_unique").on(
      table.parentCatalogItemId,
      table.name,
    ),
    environmentIdIdx: index("internal_mcp_catalog_environment_id_idx").on(
      table.environmentId,
    ),
  }),
);

export default internalMcpCatalogTable;
