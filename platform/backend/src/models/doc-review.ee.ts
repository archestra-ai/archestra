// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  DocReviewCellStatus,
  DocReviewCitation,
  DocReviewColumn,
  DocReviewRowStatus,
  DocReviewStatus,
} from "@/database/schemas/doc-review.ee";

export type DocReview = typeof schema.docReviewsTable.$inferSelect;
export type DocReviewRow = typeof schema.docReviewRowsTable.$inferSelect;
export type DocReviewCell = typeof schema.docReviewCellsTable.$inferSelect;

export type CreateDocReviewParams = {
  organizationId: string;
  createdById: string;
  knowledgeBaseId?: string;
  name: string;
  description?: string;
  columns: DocReviewColumn[];
  documentIds: string[];
};

export type DocReviewGridCell = {
  id: string;
  rowId: string;
  columnId: string;
  documentId: string;
  status: DocReviewCellStatus;
  value: unknown;
  citations: DocReviewCitation[];
  error?: string | null;
  tokensUsed?: number | null;
};

export type DocReviewGridRow = {
  id: string;
  documentId: string;
  documentTitle: string;
  documentSourceUrl?: string | null;
  status: DocReviewRowStatus;
  cells: Record<string, DocReviewGridCell>; // columnId -> cell
};

export type DocReviewGrid = {
  review: DocReview;
  columns: DocReviewColumn[];
  rows: DocReviewGridRow[];
};

export class DocReviewModel {
  static async create(params: CreateDocReviewParams): Promise<DocReview> {
    return await db.transaction(async (tx) => {
      const totalRows = params.documentIds.length;
      const totalCells = totalRows * params.columns.length;

      const [review] = await tx
        .insert(schema.docReviewsTable)
        .values({
          organizationId: params.organizationId,
          createdById: params.createdById,
          knowledgeBaseId: params.knowledgeBaseId ?? null,
          name: params.name,
          description: params.description ?? null,
          columns: params.columns,
          status: "pending",
          totalRows,
          completedRows: 0,
          totalCells,
          completedCells: 0,
          failedCells: 0,
        })
        .returning();

      if (params.documentIds.length > 0) {
        // Insert rows
        const rowValues = params.documentIds.map((docId) => ({
          reviewId: review.id,
          documentId: docId,
          status: "pending" as DocReviewRowStatus,
        }));

        const insertedRows = await tx
          .insert(schema.docReviewRowsTable)
          .values(rowValues)
          .returning();

        // Insert cells for each row and column
        const cellValues: (typeof schema.docReviewCellsTable.$inferInsert)[] = [];
        for (const row of insertedRows) {
          for (const col of params.columns) {
            cellValues.push({
              reviewId: review.id,
              rowId: row.id,
              columnId: col.id,
              documentId: row.documentId,
              status: "pending",
              citations: [],
            });
          }
        }

        if (cellValues.length > 0) {
          await tx.insert(schema.docReviewCellsTable).values(cellValues);
        }
      }

      return review;
    });
  }

  static async findById(
    id: string,
    organizationId: string,
  ): Promise<DocReview | null> {
    const [review] = await db
      .select()
      .from(schema.docReviewsTable)
      .where(
        and(
          eq(schema.docReviewsTable.id, id),
          eq(schema.docReviewsTable.organizationId, organizationId),
        ),
      );

    return review ?? null;
  }

  static async findByOrganization(
    organizationId: string,
    limit = 50,
    offset = 0,
  ): Promise<DocReview[]> {
    return await db
      .select()
      .from(schema.docReviewsTable)
      .where(eq(schema.docReviewsTable.organizationId, organizationId))
      .orderBy(desc(schema.docReviewsTable.createdAt))
      .limit(limit)
      .offset(offset);
  }

  static async findGrid(
    reviewId: string,
    organizationId: string,
  ): Promise<DocReviewGrid | null> {
    const review = await this.findById(reviewId, organizationId);
    if (!review) return null;

    const rowsWithDocs = await db
      .select({
        row: schema.docReviewRowsTable,
        docTitle: schema.kbDocumentsTable.title,
        docSourceUrl: schema.kbDocumentsTable.sourceUrl,
      })
      .from(schema.docReviewRowsTable)
      .innerJoin(
        schema.kbDocumentsTable,
        eq(schema.docReviewRowsTable.documentId, schema.kbDocumentsTable.id),
      )
      .where(eq(schema.docReviewRowsTable.reviewId, reviewId))
      .orderBy(schema.docReviewRowsTable.createdAt);

    const cells = await db
      .select()
      .from(schema.docReviewCellsTable)
      .where(eq(schema.docReviewCellsTable.reviewId, reviewId));

    const cellsByRowId = new Map<string, Record<string, DocReviewGridCell>>();
    for (const cell of cells) {
      if (!cellsByRowId.has(cell.rowId)) {
        cellsByRowId.set(cell.rowId, {});
      }
      cellsByRowId.get(cell.rowId)![cell.columnId] = {
        id: cell.id,
        rowId: cell.rowId,
        columnId: cell.columnId,
        documentId: cell.documentId,
        status: cell.status,
        value: cell.value,
        citations: (cell.citations as DocReviewCitation[]) ?? [],
        error: cell.error,
        tokensUsed: cell.tokensUsed,
      };
    }

    const gridRows: DocReviewGridRow[] = rowsWithDocs.map(
      ({ row, docTitle, docSourceUrl }) => ({
        id: row.id,
        documentId: row.documentId,
        documentTitle: docTitle,
        documentSourceUrl: docSourceUrl,
        status: row.status,
        cells: cellsByRowId.get(row.id) ?? {},
      }),
    );

    return {
      review,
      columns: (review.columns as DocReviewColumn[]) ?? [],
      rows: gridRows,
    };
  }

  static async findPendingCellRows(reviewId: string): Promise<string[]> {
    const pendingCells = await db
      .selectDistinct({ rowId: schema.docReviewCellsTable.rowId })
      .from(schema.docReviewCellsTable)
      .where(
        and(
          eq(schema.docReviewCellsTable.reviewId, reviewId),
          inArray(schema.docReviewCellsTable.status, ["pending", "error"]),
        ),
      );

    return pendingCells.map((c) => c.rowId);
  }

  static async findCellsByRow(rowId: string): Promise<DocReviewCell[]> {
    return await db
      .select()
      .from(schema.docReviewCellsTable)
      .where(eq(schema.docReviewCellsTable.rowId, rowId));
  }

  static async findCellById(cellId: string): Promise<DocReviewCell | null> {
    const [cell] = await db
      .select()
      .from(schema.docReviewCellsTable)
      .where(eq(schema.docReviewCellsTable.id, cellId));

    return cell ?? null;
  }

  static async completeCell(
    cellId: string,
    params: {
      value: unknown;
      citations: DocReviewCitation[];
      tokensUsed?: number;
    },
  ): Promise<void> {
    await db.transaction(async (tx) => {
      const [cell] = await tx
        .select()
        .from(schema.docReviewCellsTable)
        .where(eq(schema.docReviewCellsTable.id, cellId));

      if (!cell) return;

      const wasAlreadyCompleted = cell.status === "completed";

      await tx
        .update(schema.docReviewCellsTable)
        .set({
          status: "completed",
          value: params.value as any,
          citations: params.citations,
          tokensUsed: params.tokensUsed ?? null,
          error: null,
        })
        .where(eq(schema.docReviewCellsTable.id, cellId));

      if (!wasAlreadyCompleted) {
        await tx
          .update(schema.docReviewsTable)
          .set({
            completedCells: sql`${schema.docReviewsTable.completedCells} + 1`,
            ...(cell.status === "error"
              ? { failedCells: sql`${schema.docReviewsTable.failedCells} - 1` }
              : {}),
          })
          .where(eq(schema.docReviewsTable.id, cell.reviewId));
      }

      await this.checkAndUpdateRowCompletion(tx, cell.rowId, cell.reviewId);
    });
  }

  static async failCell(cellId: string, errorMessage: string): Promise<void> {
    await db.transaction(async (tx) => {
      const [cell] = await tx
        .select()
        .from(schema.docReviewCellsTable)
        .where(eq(schema.docReviewCellsTable.id, cellId));

      if (!cell) return;

      const wasError = cell.status === "error";

      await tx
        .update(schema.docReviewCellsTable)
        .set({
          status: "error",
          error: errorMessage,
        })
        .where(eq(schema.docReviewCellsTable.id, cellId));

      if (!wasError) {
        await tx
          .update(schema.docReviewsTable)
          .set({
            failedCells: sql`${schema.docReviewsTable.failedCells} + 1`,
          })
          .where(eq(schema.docReviewsTable.id, cell.reviewId));
      }

      await this.checkAndUpdateRowCompletion(tx, cell.rowId, cell.reviewId);
    });
  }

  private static async checkAndUpdateRowCompletion(
    tx: any,
    rowId: string,
    reviewId: string,
  ): Promise<void> {
    const rowCells = await tx
      .select()
      .from(schema.docReviewCellsTable)
      .where(eq(schema.docReviewCellsTable.rowId, rowId));

    const allFinished = rowCells.every(
      (c: DocReviewCell) => c.status === "completed" || c.status === "error",
    );

    if (allFinished) {
      const hasErrors = rowCells.some((c: DocReviewCell) => c.status === "error");
      const rowStatus: DocReviewRowStatus = hasErrors ? "failed" : "completed";

      const [prevRow] = await tx
        .select()
        .from(schema.docReviewRowsTable)
        .where(eq(schema.docReviewRowsTable.id, rowId));

      await tx
        .update(schema.docReviewRowsTable)
        .set({ status: rowStatus })
        .where(eq(schema.docReviewRowsTable.id, rowId));

      if (prevRow?.status !== "completed" && rowStatus === "completed") {
        await tx
          .update(schema.docReviewsTable)
          .set({
            completedRows: sql`${schema.docReviewsTable.completedRows} + 1`,
          })
          .where(eq(schema.docReviewsTable.id, reviewId));
      }
    }

    // Check overall review run completion
    const allReviewCells = await tx
      .select()
      .from(schema.docReviewCellsTable)
      .where(eq(schema.docReviewCellsTable.reviewId, reviewId));

    const reviewFinished = allReviewCells.every(
      (c: DocReviewCell) => c.status === "completed" || c.status === "error",
    );

    if (reviewFinished) {
      const hasAnyFailures = allReviewCells.some(
        (c: DocReviewCell) => c.status === "error",
      );
      const finalStatus: DocReviewStatus = hasAnyFailures
        ? "completed" // completed with some cell errors, or completed
        : "completed";

      await tx
        .update(schema.docReviewsTable)
        .set({
          status: finalStatus,
          completedAt: new Date(),
        })
        .where(eq(schema.docReviewsTable.id, reviewId));
    }
  }

  static async updateStatus(
    id: string,
    status: DocReviewStatus,
    error?: string,
  ): Promise<void> {
    await db
      .update(schema.docReviewsTable)
      .set({
        status,
        ...(error !== undefined ? { error } : {}),
        ...(status === "completed" || status === "failed" || status === "cancelled"
          ? { completedAt: new Date() }
          : {}),
      })
      .where(eq(schema.docReviewsTable.id, id));
  }

  static async retryCell(
    cellId: string,
    organizationId: string,
  ): Promise<{ cell: DocReviewCell; review: DocReview } | null> {
    const cell = await this.findCellById(cellId);
    if (!cell) return null;

    const review = await this.findById(cell.reviewId, organizationId);
    if (!review) return null;

    await db.transaction(async (tx) => {
      await tx
        .update(schema.docReviewCellsTable)
        .set({
          status: "pending",
          error: null,
          value: null,
          citations: [],
        })
        .where(eq(schema.docReviewCellsTable.id, cellId));

      await tx
        .update(schema.docReviewRowsTable)
        .set({ status: "pending" })
        .where(eq(schema.docReviewRowsTable.id, cell.rowId));

      await tx
        .update(schema.docReviewsTable)
        .set({ status: "running" })
        .where(eq(schema.docReviewsTable.id, review.id));
    });

    return { cell, review };
  }

  static async delete(id: string, organizationId: string): Promise<boolean> {
    const result = await db
      .delete(schema.docReviewsTable)
      .where(
        and(
          eq(schema.docReviewsTable.id, id),
          eq(schema.docReviewsTable.organizationId, organizationId),
        ),
      )
      .returning();

    return result.length > 0;
  }
}
