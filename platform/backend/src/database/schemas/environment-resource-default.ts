import type { EnvironmentDefaultableResource } from "@archestra/shared";
import {
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import environmentsTable from "./environment";
import organizationsTable from "./organization";

/**
 * Per-resource-kind landing environment for newly created resources: which
 * environment a new MCP server, MCP App, agent, gateway, proxy, or knowledge
 * connector is bound to when its creator does not choose one.
 *
 * A resource kind with NO row here keeps the historical behavior — new items
 * land in the org's implicit Default environment (`environment_id = null` on
 * the resource). Clearing a configured default therefore deletes the row rather
 * than storing a null, which is why `environment_id` is NOT NULL.
 *
 * ON DELETE CASCADE on both FKs: deleting the environment drops the rows that
 * pointed new resources at it, so the kind falls back to Default instead of
 * naming an environment that no longer exists.
 */
const environmentResourceDefaultsTable = pgTable(
  "environment_resource_defaults",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    /**
     * RBAC resource kind the default applies to — one of
     * `ENVIRONMENT_DEFAULTABLE_RESOURCES`. Stored as text (not a PG enum) so
     * adding a kind needs no enum migration; the API schema is the gate.
     */
    resource: text("resource")
      .$type<EnvironmentDefaultableResource>()
      .notNull(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environmentsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // At most one default environment per resource kind per organization.
    unique("environment_resource_defaults_org_resource_unique").on(
      table.organizationId,
      table.resource,
    ),
    index("environment_resource_defaults_environment_id_idx").on(
      table.environmentId,
    ),
  ],
);

export default environmentResourceDefaultsTable;
