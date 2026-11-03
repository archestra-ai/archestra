import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import organizations from "./organization";
import users from "./user";

/** A person's enrolled computer. Enrollment grants presence only, not tool execution. */
export const localDevicesTable = pgTable(
  "local_device",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    platform: text("platform").$type<"darwin" | "win32" | "linux">(),
    arch: text("arch").$type<"arm64" | "x64">(),
    appVersion: text("app_version"),
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
    index("local_device_owner_idx").on(table.organizationId, table.userId),
  ],
);
