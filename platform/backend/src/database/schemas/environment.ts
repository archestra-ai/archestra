import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { NetworkPolicy } from "@/types";
import organizationsTable from "./organization";

/**
 * Org-level list of deployment environments (e.g. "sandbox", "staging",
 * "production"). A catalog item may be assigned to exactly one environment via
 * internal_mcp_catalog.environment_id (nullable). Each environment carries a
 * Kubernetes namespace (stored only; runtime use deferred). Assignment to a
 * `restricted` environment is gated by the `environment:admin` permission.
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
     * Target Kubernetes namespace for servers in this environment. Stored only;
     * not yet applied at deployment time. NULL means "unset".
     */
    namespace: text("namespace"),
    networkPolicy: jsonb("network_policy").$type<NetworkPolicy>(),
    /**
     * When true, assigning a catalog item to this environment requires the
     * `environment:admin` permission. Unrestricted environments (and the
     * org-default/null environment) are open to anyone who can create catalog
     * items. Flipped via PATCH /api/environments/:id.
     */
    restricted: boolean("restricted").notNull().default(false),
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
  ],
);

export default environmentsTable;
