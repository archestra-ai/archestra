import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { NetworkPolicy, TrustedImageRegistries } from "@/types";
import organizationsTable from "./organization";
import secretsTable from "./secret";

/**
 * Org-level list of deployment environments (e.g. "sandbox", "staging",
 * "production"). A catalog item may be assigned to exactly one environment via
 * internal_mcp_catalog.environment_id (nullable). Each environment carries a
 * Kubernetes namespace its MCP server pods are deployed into. Who may deploy
 * into it is its `use` grants.
 */
const environmentsTable = pgTable(
  "environments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Optional human-readable description, shown in the environment selector. */
    description: text("description"),
    /**
     * Kubernetes namespace MCP server pods in this environment are deployed
     * into. NULL falls back to the orchestrator's own namespace.
     */
    namespace: text("namespace"),
    networkPolicy: jsonb("network_policy").$type<NetworkPolicy>(),
    /**
     * ALLOWLIST regex (JS source, no delimiters/flags) applied to user-supplied
     * config field values when a catalog item bound to this environment is
     * installed. A value is allowed only if it MATCHES. NULL disables. Block a
     * substring (e.g. "prod" in staging) with a negative lookahead.
     */
    validationRegex: text("validation_regex"),
    /**
     * ALLOWLIST of trusted container image registries (normalized
     * `host/repository` prefixes) for PERSONAL local catalog items assigned to
     * this environment. A personal local catalog item's custom image must match
     * an entry, otherwise its install is held for admin approval. NULL/empty
     * disables the check. Mirrors `validation_regex` for the image-registry
     * policy.
     */
    trustedImageRegistries: jsonb(
      "trusted_image_registries",
    ).$type<TrustedImageRegistries>(),
    /**
     * Kubeconfig of the cluster this environment's workloads are deployed
     * into, as a `secret` row. NULL means the platform's own cluster. Set only
     * when the environment is created: the cluster of an environment never
     * changes, so the environment id identifies one cluster for as long as the
     * environment exists. Later writes only rotate the credential.
     */
    kubeconfigSecretId: uuid("kubeconfig_secret_id").references(
      () => secretsTable.id,
      // Deleting the secret must never turn the environment into one of the
      // platform's own cluster; the environment is deleted first.
      { onDelete: "restrict" },
    ),
    /** API server URL of that cluster, shown to administrators. Not a secret. */
    kubeconfigServer: text("kubeconfig_server"),
    /**
     * Incremented on every kubeconfig write, so a platform replica that did
     * not handle a credential rotation notices it and reloads the secret.
     */
    kubeconfigVersion: integer("kubeconfig_version").notNull().default(0),
    /**
     * URL at which Agent Runtime pods in this environment's cluster reach the
     * platform. NULL uses ARCHESTRA_AGENT_RUNTIME_PLATFORM_BASE_URL, which is
     * usually a name only the platform's own cluster resolves.
     */
    agentRuntimePlatformBaseUrl: text("agent_runtime_platform_base_url"),
    /**
     * Set when the deletion of an environment with its own cluster begins,
     * before its workloads are removed from that cluster. From then on no
     * replica deploys anything there, so nothing can appear after the cleanup
     * and outlive the credential. Never cleared: the environment is deleted,
     * or the deletion is retried.
     */
    deletingAt: timestamp("deleting_at", { mode: "date" }),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("environments_org_name_unique").on(table.organizationId, table.name),
    index("environments_org_idx").on(table.organizationId),
    // One environment per namespace of a cluster the platform deploys into
    // through a kubeconfig: what is in that namespace is that environment's,
    // and is removed with it.
    uniqueIndex("environments_cluster_namespace_uidx")
      .on(table.kubeconfigServer, table.namespace)
      .where(sql`${table.kubeconfigServer} IS NOT NULL`),
  ],
);

export default environmentsTable;
