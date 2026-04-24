import { sql } from "drizzle-orm";
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { MemoryTombstoneReason } from "@/types/memory-tombstone";
import organizationsTable from "./organization";

const memoryTombstonesTable = pgTable(
  "memory_tombstone",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    scopeType: text("scope_type").notNull(),
    scopeId: text("scope_id").notNull(),
    contentHash: text("content_hash").notNull(),
    reason: text("reason").$type<MemoryTombstoneReason>().notNull(),
    expiresAt: timestamp("expires_at", { mode: "date" }).default(
      sql`now() + interval '30 days'`,
    ),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("memory_tombstones_scope_hash_uk").on(
      table.organizationId,
      table.scopeType,
      table.scopeId,
      table.contentHash,
    ),
    index("memory_tombstones_expires_at_idx").on(table.expiresAt),
  ],
);

export default memoryTombstonesTable;
