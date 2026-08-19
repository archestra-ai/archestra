import { pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import organizationsTable from "./organization";

/**
 * Per-role allow-lists for the built-in catalogs (model providers, knowledge
 * connectors, messaging channels, connection-page clients).
 *
 * Keyed by the role *identifier* rather than a foreign key: a predefined role
 * ("member", "admin", …) has no row in `organization_role` — it is generated
 * from code — yet it is the role most organizations actually restrict. Rows
 * for a deleted custom role are removed alongside the role.
 *
 * A NULL column means unrestricted (every entry allowed, including ones a
 * later release adds). An empty array means nothing of that kind is allowed.
 * See `@archestra/shared`'s `role-resource-access` for the shared contract.
 */
const roleResourceAccessTable = pgTable(
  "role_resource_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    /** Predefined role name or custom role identifier (`organization_role.role`). */
    role: text("role").notNull(),
    modelProviders: text("model_providers").array(),
    knowledgeConnectors: text("knowledge_connectors").array(),
    messagingChannels: text("messaging_channels").array(),
    connectClients: text("connect_clients").array(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").$onUpdate(
      () => /* @__PURE__ */ new Date(),
    ),
  },
  (table) => [unique().on(table.organizationId, table.role)],
);

export default roleResourceAccessTable;
