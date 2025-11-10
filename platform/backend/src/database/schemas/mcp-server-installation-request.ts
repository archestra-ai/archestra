import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type {
  McpServerInstallationRequestCustomServerConfig,
  McpServerInstallationRequestNote,
  McpServerInstallationRequestStatus,
} from "@/types";
import usersTable from "./user";

const mcpServerInstallationRequestTable = pgTable(
  "mcp_server_installation_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    externalCatalogId: text("external_catalog_id"),
    requestedBy: text("requested_by")
      .notNull()
      .references(() => usersTable.id, {
        onDelete: "cascade",
      }),
    status: text("status")
      .$type<McpServerInstallationRequestStatus>()
      .notNull()
      .default("pending"),
    requestReason: text("request_reason"),
    customServerConfig: jsonb("custom_server_config")
      .$type<McpServerInstallationRequestCustomServerConfig>()
      .default(null),
    adminResponse: text("admin_response"),
    reviewedBy: text("reviewed_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { mode: "date" }),
    notes: jsonb("notes")
      .$type<Array<McpServerInstallationRequestNote>>()
      .default([]),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
);

export default mcpServerInstallationRequestTable;
