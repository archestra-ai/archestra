import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  DesktopMcpJsonRpcMessage,
  DesktopMcpRequestStatus,
} from "@/types/desktop-mcp";
import desktopDevicesTable from "./desktop-device";

/**
 * The queue of MCP messages that wait for a device.
 *
 * A tool call on a desktop MCP server writes a row. The tunnel client on the
 * device takes the row with a poll and posts the MCP response, which is stored
 * on the same row. The backend copy that holds the tool call reads the row
 * again until the response is there, then deletes the row. The table is the
 * only state the backend copies share for the tunnel.
 */
const desktopMcpRequestsTable = pgTable(
  "desktop_mcp_requests",
  {
    /** Also the `request_id` of the tunnel protocol. */
    id: uuid("id").primaryKey().defaultRandom(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => desktopDevicesTable.id, { onDelete: "cascade" }),
    /** Id of the catalog item whose MCP server gets the message. */
    channel: text("channel").notNull(),
    payload: jsonb("payload").$type<DesktopMcpJsonRpcMessage>().notNull(),
    status: text("status")
      .$type<DesktopMcpRequestStatus>()
      .notNull()
      .default("pending"),
    response: jsonb("response").$type<DesktopMcpJsonRpcMessage>(),
    expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    // A poll takes the oldest pending rows of one device.
    index("desktop_mcp_requests_device_status_created_idx").on(
      table.deviceId,
      table.status,
      table.createdAt,
    ),
  ],
);

export default desktopMcpRequestsTable;
