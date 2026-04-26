import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import organizationsTable from "./organization";
import usersTable from "./user";

export const team = pgTable("team", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  createdBy: text("created_by")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at")
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
  convertToolResultsToToon: boolean("convert_tool_results_to_toon")
    .notNull()
    .default(false),
  /**
   * Optional Kubernetes namespace override for MCP servers deployed by this team.
   * When set, MCP servers belonging to this team are deployed to this namespace
   * instead of the global default namespace.
   */
  k8sNamespace: text("k8s_namespace"),
  /**
   * Optional base64-encoded KUBECONFIG for a separate Kubernetes cluster.
   * When set, MCP servers belonging to this team are deployed using this
   * kubeconfig (i.e. a different cluster) instead of the global cluster.
   */
  k8sKubeconfigBase64: text("k8s_kubeconfig_base64"),
});

export const teamMember = pgTable("team_member", {
  id: text("id").primaryKey(),
  teamId: text("team_id")
    .notNull()
    .references(() => team.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  role: text("role").default("member").notNull(),
  /**
   * Indicates this membership was created via SSO team sync.
   * Synced members are automatically managed during SSO login.
   * Members without this flag were added manually and won't be removed by sync.
   */
  syncedFromSso: boolean("synced_from_sso").notNull().default(false),
  createdAt: timestamp("created_at").notNull(),
});
