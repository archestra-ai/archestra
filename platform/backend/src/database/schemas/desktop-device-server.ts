import {
  boolean,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { DesktopMcpServerState } from "@/types/desktop-mcp";
import desktopDevicesTable from "./desktop-device";
import internalMcpCatalogTable from "./internal-mcp-catalog";

/**
 * One MCP server on one device: whether the user stopped it, and the state
 * the tunnel client reported.
 *
 * The catalog item holds the command or URL for every device. A row here
 * exists once the user stops the MCP server on their device or once the
 * tunnel client reports a state; no row means "started, nothing reported
 * yet".
 */
const desktopDeviceServersTable = pgTable(
  "desktop_device_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => desktopDevicesTable.id, { onDelete: "cascade" }),
    catalogId: uuid("catalog_id")
      .notNull()
      .references(() => internalMcpCatalogTable.id, { onDelete: "cascade" }),
    /** False after the user stopped the MCP server; it stays stopped. */
    enabled: boolean("enabled").notNull().default(true),
    /** From the last state report of the tunnel client. */
    state: text("state").$type<DesktopMcpServerState>(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("desktop_device_servers_device_catalog_idx").on(
      table.deviceId,
      table.catalogId,
    ),
  ],
);

export default desktopDeviceServersTable;
