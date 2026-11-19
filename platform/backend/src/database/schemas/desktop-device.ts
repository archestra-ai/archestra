import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { ConnectionSetupPlatform } from "@/types/connection-setup";
import organizationsTable from "./organization";
import usersTable from "./user";

/**
 * A user's computer that runs the tunnel client for desktop MCP servers.
 * The tunnel client identifies itself with a device key; only sha256(key) is
 * stored in `keyHash`.
 *
 * A user has at most one device. The polls of the tunnel client keep
 * `lastPolledAt` recent. The MCP servers of the device are in
 * `desktop_device_servers`.
 */
const desktopDevicesTable = pgTable(
  "desktop_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    /** Hostname the tunnel client reported at sign-in. */
    name: text("name").notNull(),
    platform: text("platform").$type<ConnectionSetupPlatform>().notNull(),
    /** sha256 hex of the raw device key; the raw key is never stored. */
    keyHash: text("key_hash").notNull(),
    lastPolledAt: timestamp("last_polled_at", { mode: "date" }),
    /**
     * The program the tunnel client reported with its last poll: its version,
     * its target (`<system>-<cpu>`, for example `darwin-arm64`) and the
     * SHA-256 of its file in lower-case hex. Null when it did not report one.
     */
    clientVersion: text("client_version"),
    clientTarget: text("client_target"),
    clientSha256: text("client_sha256"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // One device per user.
    uniqueIndex("desktop_devices_user_id_idx").on(table.userId),
    uniqueIndex("desktop_devices_key_hash_idx").on(table.keyHash),
    index("desktop_devices_org_id_idx").on(table.organizationId),
  ],
);

export default desktopDevicesTable;
