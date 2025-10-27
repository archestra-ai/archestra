import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import internalMcpCatalogTable from "./internal-mcp-catalog";
import usersTable from "./user";

const mcpServerInstallationRequestTable = pgTable(
  "mcp_server_installation_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    catalogId: uuid("catalog_id")
      .notNull()
      .references(() => internalMcpCatalogTable.id, {
        onDelete: "cascade",
      }),
    requestedBy: text("requested_by")
      .notNull()
      .references(() => usersTable.id, {
        onDelete: "cascade",
      }),
    status: text("status")
      .$type<"pending" | "approved" | "declined">()
      .notNull()
      .default("pending"),
    requestNotes: text("request_notes"),
    reviewNotes: text("review_notes"),
    reviewedBy: text("reviewed_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
);

export default mcpServerInstallationRequestTable;
