import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { DeviceMcpCommandStatus } from "@/types/device-mcp";
import catalog from "./internal-mcp-catalog";
import organizations from "./organization";
import users from "./user";

export const deviceMcpConnectionsTable = pgTable(
  "device_mcp_connection",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    catalogId: uuid("catalog_id")
      .notNull()
      .references(() => catalog.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    configDigest: text("config_digest").notNull(),
    configVersion: text("config_version").notNull(),
    pairingHash: text("pairing_hash").unique(),
    pairingExpiresAt: timestamp("pairing_expires_at").notNull(),
    tokenHash: text("token_hash").unique(),
    tokenExpiresAt: timestamp("token_expires_at"),
    sessionId: uuid("session_id"),
    lastSeenAt: timestamp("last_seen_at"),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("device_mcp_owner_idx").on(
      table.organizationId,
      table.userId,
      table.catalogId,
    ),
  ],
);

export const deviceMcpCommandsTable = pgTable(
  "device_mcp_command",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => deviceMcpConnectionsTable.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull(),
    status: text("status")
      .$type<DeviceMcpCommandStatus>()
      .notNull()
      .default("queued"),
    toolName: text("tool_name").notNull(),
    arguments: jsonb("arguments").$type<Record<string, unknown>>().notNull(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    resultDigest: text("result_digest"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("device_mcp_command_poll_idx").on(
      table.deviceId,
      table.sessionId,
      table.status,
    ),
  ],
);
