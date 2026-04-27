import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  MemoryConfidenceBand,
  MemoryKind,
  MemoryPolicyFlag,
  MemoryRejectionReason,
  MemoryScopeType,
  MemorySourceMetadata,
  MemorySourceType,
  MemoryStatus,
} from "@/types/memory-item";
import conversationsTable from "./conversation";
import organizationsTable from "./organization";
import usersTable from "./user";

const memoryItemsTable = pgTable(
  "memory_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    scopeType: text("scope_type").$type<MemoryScopeType>().notNull(),
    scopeId: text("scope_id").notNull(),
    kind: text("kind").$type<MemoryKind>().notNull(),
    status: text("status").$type<MemoryStatus>().notNull().default("candidate"),
    content: text("content").notNull(),
    createdBy: text("created_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    reviewedBy: text("reviewed_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { mode: "date" }),
    rejectionReason: text("rejection_reason").$type<MemoryRejectionReason>(),
    rejectionComment: text("rejection_comment"),
    extractorVersion: text("extractor_version"),
    policyFlags: text("policy_flags")
      .array()
      .$type<MemoryPolicyFlag[]>()
      .notNull()
      .default(sql`'{}'::text[]`),
    sourceType: text("source_type").$type<MemorySourceType>(),
    sourceId: text("source_id"),
    sourceMetadata: jsonb("source_metadata").$type<MemorySourceMetadata>(),
    sourceConversationId: uuid("source_conversation_id").references(
      () => conversationsTable.id,
      { onDelete: "set null" },
    ),
    sourceMessageIds: uuid("source_message_ids").array(),
    supersedesMemoryId: uuid("supersedes_memory_id").references(
      (): AnyPgColumn => memoryItemsTable.id,
      { onDelete: "set null" },
    ),
    confidenceBand: text("confidence_band").$type<MemoryConfidenceBand>(),
    language: text("language"),
    lastVerifiedAt: timestamp("last_verified_at", { mode: "date" }),
    expiresAt: timestamp("expires_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("memory_items_org_scope_status_idx").on(
      table.organizationId,
      table.scopeType,
      table.scopeId,
      table.status,
    ),
    index("memory_items_org_status_created_idx").on(
      table.organizationId,
      table.status,
      table.createdAt,
    ),
    index("memory_items_source_conversation_idx").on(
      table.sourceConversationId,
    ),
    index("memory_items_source_type_idx").on(table.sourceType),
    index("memory_items_source_type_id_idx").on(
      table.sourceType,
      table.sourceId,
    ),
    index("memory_items_approved_scope_idx")
      .on(table.organizationId, table.scopeType, table.scopeId)
      .where(sql`${table.status} = 'approved'`),
    index("memory_items_supersedes_memory_idx").on(table.supersedesMemoryId),
  ],
);

export default memoryItemsTable;
