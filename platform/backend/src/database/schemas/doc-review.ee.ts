// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import kbDocumentsTable from "./kb-document";
import knowledgeBasesTable from "./knowledge-base";

export type DocReviewOutputFormat =
  | "text"
  | "yes_no"
  | "date"
  | "number"
  | "list"
  | "json";

export type DocReviewColumn = {
  id: string;
  title: string;
  prompt: string;
  outputFormat: DocReviewOutputFormat;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
};

export type DocReviewStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type DocReviewRowStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed";

export type DocReviewCellStatus =
  | "pending"
  | "generating"
  | "completed"
  | "error";

export type DocReviewCitation = {
  quote: string;
  ref?: string;
  documentId?: string;
  title?: string;
  sourceUrl?: string | null;
  startOffset?: number;
  endOffset?: number;
};

export const docReviewsTable = pgTable(
  "doc_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    createdById: text("created_by_id").notNull(),
    knowledgeBaseId: uuid("knowledge_base_id").references(
      () => knowledgeBasesTable.id,
      { onDelete: "set null" },
    ),
    name: text("name").notNull(),
    description: text("description"),
    columns: jsonb("columns").$type<DocReviewColumn[]>().notNull().default([]),
    status: text("status").$type<DocReviewStatus>().notNull().default("pending"),
    totalRows: integer("total_rows").notNull().default(0),
    completedRows: integer("completed_rows").notNull().default(0),
    totalCells: integer("total_cells").notNull().default(0),
    completedCells: integer("completed_cells").notNull().default(0),
    failedCells: integer("failed_cells").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { mode: "date" }),
    leaseEpoch: bigint("lease_epoch", { mode: "number" }).notNull().default(0),
    error: text("error"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    completedAt: timestamp("completed_at", { mode: "date" }),
  },
  (table) => [
    index("doc_reviews_org_id_idx").on(table.organizationId),
    index("doc_reviews_kb_id_idx").on(table.knowledgeBaseId),
    index("doc_reviews_lease_expires_at_idx")
      .on(table.leaseExpiresAt)
      .where(sql`status = 'running'`),
  ],
);

export const docReviewRowsTable = pgTable(
  "doc_review_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => docReviewsTable.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => kbDocumentsTable.id, { onDelete: "cascade" }),
    status: text("status")
      .$type<DocReviewRowStatus>()
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("doc_review_rows_review_doc_idx").on(
      table.reviewId,
      table.documentId,
    ),
    index("doc_review_rows_review_status_idx").on(
      table.reviewId,
      table.status,
    ),
  ],
);

export const docReviewCellsTable = pgTable(
  "doc_review_cells",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => docReviewsTable.id, { onDelete: "cascade" }),
    rowId: uuid("row_id")
      .notNull()
      .references(() => docReviewRowsTable.id, { onDelete: "cascade" }),
    columnId: text("column_id").notNull(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => kbDocumentsTable.id, { onDelete: "cascade" }),
    status: text("status")
      .$type<DocReviewCellStatus>()
      .notNull()
      .default("pending"),
    value: jsonb("value").$type<unknown>(),
    citations: jsonb("citations").$type<DocReviewCitation[]>().default([]),
    error: text("error"),
    tokensUsed: integer("tokens_used"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("doc_review_cells_row_col_idx").on(
      table.rowId,
      table.columnId,
    ),
    index("doc_review_cells_review_status_idx").on(
      table.reviewId,
      table.status,
    ),
  ],
);
