import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { OpenAppaRewriteStatus } from "@/types/openappa-rewrite";

const bytea = customType<{ data: Buffer; driverParam: Buffer }>({
  dataType: () => "bytea",
});

const at = (name: string) =>
  timestamp(name, { withTimezone: true, precision: 3 });

export const openappaRewriteGroupsTable = pgTable(
  "openappa_rewrite_groups",
  {
    organizationId: text("organization_id").notNull(),
    groupId: text("group_id").notNull(),
    epoch: integer("epoch").notNull(),
    protocolVersion: integer("protocol_version").notNull(),
    status: text("status").$type<OpenAppaRewriteStatus>().notNull(),
    idleTtlMs: integer("idle_ttl_ms").notNull(),
    expiresAt: at("expires_at").notNull(),
    touchedAt: at("touched_at").notNull(),
    expiredAt: at("expired_at"),
    payloadSweptAt: at("payload_swept_at"),
    entryCount: integer("entry_count").notNull().default(0),
    byteCount: integer("byte_count").notNull().default(0),
    maxEntries: integer("max_entries").notNull(),
    maxBytes: integer("max_bytes").notNull(),
    createdAt: at("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.groupId],
    }),
    index("openappa_rewrite_groups_expiry_idx")
      .on(table.expiresAt)
      .where(sql`${table.status} = 'live'`),
    index("openappa_rewrite_groups_unswept_idx")
      .on(table.expiredAt)
      .where(
        sql`${table.status} = 'expired' AND ${table.payloadSweptAt} IS NULL`,
      ),
    check(
      "openappa_rewrite_groups_status_chk",
      sql`${table.status} in ('live', 'expired')`,
    ),
    check("openappa_rewrite_groups_epoch_chk", sql`${table.epoch} >= 1`),
    check(
      "openappa_rewrite_groups_ttl_chk",
      sql`${table.idleTtlMs} >= 1 AND ${table.protocolVersion} >= 1`,
    ),
    check(
      "openappa_rewrite_groups_counts_chk",
      sql`${table.entryCount} >= 0 AND ${table.byteCount} >= 0 AND ${table.maxEntries} >= 1 AND ${table.maxBytes} >= 1`,
    ),
  ],
);

export const openappaRewritePairsTable = pgTable(
  "openappa_rewrite_pairs",
  {
    organizationId: text("organization_id").notNull(),
    groupId: text("group_id").notNull(),
    sessionId: text("session_id").notNull(),
    fragmentKey: text("fragment_key").notNull(),
    original: bytea("original").notNull(),
    originalDigest: text("original_digest").notNull(),
    rewritten: bytea("rewritten").notNull(),
    rewrittenDigest: text("rewritten_digest").notNull(),
    byteLen: integer("byte_len").notNull(),
    reservationId: text("reservation_id"),
    reservedBytes: integer("reserved_bytes").notNull().default(0),
    reservationExpiresAt: at("reservation_expires_at"),
    createdAt: at("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.organizationId,
        table.groupId,
        table.sessionId,
        table.fragmentKey,
      ],
    }),
    check("openappa_rewrite_pairs_len_chk", sql`${table.byteLen} >= 0`),
    check(
      "openappa_rewrite_pairs_reservation_chk",
      sql`${table.reservedBytes} >= 0 AND (
        (${table.reservationExpiresAt} IS NULL AND ${table.reservedBytes} = 0)
        OR (${table.reservationExpiresAt} IS NOT NULL AND ${table.reservationId} IS NOT NULL)
      )`,
    ),
    index("openappa_rewrite_pairs_reservation_idx")
      .on(table.organizationId, table.groupId, table.reservationExpiresAt)
      .where(sql`${table.reservationExpiresAt} IS NOT NULL`),
  ],
);

export const openappaRewriteHeadsTable = pgTable(
  "openappa_rewrite_heads",
  {
    organizationId: text("organization_id").notNull(),
    groupId: text("group_id").notNull(),
    sessionId: text("session_id").notNull(),
    wire: text("wire").notNull(),
    revision: integer("revision").notNull(),
    state: bytea("state").notNull(),
    stateDigest: text("state_digest").notNull(),
    updatedAt: at("updated_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.organizationId,
        table.groupId,
        table.sessionId,
        table.wire,
      ],
    }),
    check("openappa_rewrite_heads_revision_chk", sql`${table.revision} >= 1`),
  ],
);

export const openappaRewriteRootsTable = pgTable(
  "openappa_rewrite_roots",
  {
    organizationId: text("organization_id").notNull(),
    nativeRoot: text("native_root").notNull(),
    groupId: text("group_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.nativeRoot] }),
    index("openappa_rewrite_roots_group_idx").on(
      table.organizationId,
      table.groupId,
    ),
  ],
);
