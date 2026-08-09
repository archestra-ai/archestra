// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Single-row progress state for the enterprise content-encryption backfill
 * sweep (see content-encryption/backfill.ee.ts). The sweep encrypts
 * pre-existing plaintext rows and re-encrypts previous-key rows after a
 * rotation; this row lets a periodic, at-least-once task resume from a keyset
 * cursor instead of rescanning, and lets completed runs no-op in O(1).
 *
 * `keyFingerprint` identifies the CURRENT content key (a hash, never key
 * material). When the fingerprint on the row differs from the boot key's, a
 * rotation happened and the sweep restarts from the beginning.
 */
const contentEncryptionStateTable = pgTable("content_encryption_state", {
  /** Fixed singleton id — a single-row table keyed by a constant. */
  id: text("id").primaryKey(),
  keyFingerprint: text("key_fingerprint").notNull(),
  /**
   * Keyset cursor over interactions (created_at, id), ascending. The
   * created_at half is stored as the driver's raw text so it round-trips
   * exactly: `created_at` is timestamp-without-time-zone, and a JS Date
   * round-trip can shift by the host's UTC offset.
   */
  interactionsCursorCreatedAt: text("interactions_cursor_created_at"),
  interactionsCursorId: uuid("interactions_cursor_id"),
  /** Keyset cursor over messages (id — uuidv7, time-ordered), ascending. */
  messagesCursorId: uuid("messages_cursor_id"),
  /**
   * Keyset cursor over mcp_tool_calls (id — uuidv4, so the order is stable
   * but NOT time-correlated; a full sweep visits every row regardless).
   */
  mcpToolCallsCursorId: uuid("mcp_tool_calls_cursor_id"),
  completedAt: timestamp("completed_at", { mode: "date" }),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default contentEncryptionStateTable;
