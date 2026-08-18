import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Cluster-wide operation leases keyed by {scope, key} — the mutual exclusion
 * a multi-web-replica deployment needs for actions that must run once at a
 * time per physical resource (a hard reset destroying and rebuilding one K8s
 * Deployment). A row IS the lease: acquisition inserts it, a concurrent
 * acquisition may take it over only once `expires_at` has passed (the holder
 * renews while it works, so an expired lease means its holder is gone), and
 * release deletes it. All timing uses the database clock, so replicas with
 * skewed clocks still agree on who holds what.
 */
const mcpDeploymentLeasesTable = pgTable(
  "mcp_deployment_leases",
  {
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    /** Random per-acquisition token; renewal and release require a match. */
    holder: text("holder").notNull(),
    acquiredAt: timestamp("acquired_at", { mode: "date" })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.scope, table.key] }),
  }),
);

export default mcpDeploymentLeasesTable;
