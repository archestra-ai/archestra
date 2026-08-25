import { and, asc, count, eq, sql } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import { ApiError } from "@/types";
import type { EvalCase, InsertEvalCase, UpdateEvalCase } from "@/types/eval";

/**
 * Hard cap on cases per suite so a single run stays tractable (each case is
 * one agent execution plus assertions).
 * @public — referenced by routes/eval.ts route description and tests
 */
export const MAX_CASES_PER_SUITE = 500;

class EvalCaseModel {
  /**
   * Append a case to a suite. The suite row is locked (`FOR UPDATE`) so the
   * count-then-insert cap check holds under concurrent creates, and a
   * soft-deleted or foreign suite surfaces as a clean 404 rather than an FK
   * fault.
   */
  static async create(params: {
    organizationId: string;
    insert: InsertEvalCase;
  }): Promise<EvalCase> {
    return await withDbTransaction(async (tx) => {
      const [suite] = await tx
        .select({ id: schema.evalSuitesTable.id })
        .from(schema.evalSuitesTable)
        .where(
          and(
            eq(schema.evalSuitesTable.id, params.insert.suiteId),
            eq(schema.evalSuitesTable.organizationId, params.organizationId),
            notDeleted(schema.evalSuitesTable),
          ),
        )
        .for("update");
      if (!suite) {
        throw new ApiError(404, "Eval suite not found");
      }

      const [existing] = await tx
        .select({
          count: count(),
          maxPosition: sql<
            number | null
          >`max(${schema.evalCasesTable.position})`,
        })
        .from(schema.evalCasesTable)
        .where(eq(schema.evalCasesTable.suiteId, params.insert.suiteId));

      if ((existing?.count ?? 0) >= MAX_CASES_PER_SUITE) {
        throw new ApiError(
          422,
          `Eval suites are limited to ${MAX_CASES_PER_SUITE} cases`,
        );
      }

      const [evalCase] = await tx
        .insert(schema.evalCasesTable)
        .values({
          ...params.insert,
          position: (existing?.maxPosition ?? 0) + 1,
        })
        .returning();
      return evalCase;
    });
  }

  static async listBySuite(suiteId: string): Promise<EvalCase[]> {
    return await db
      .select()
      .from(schema.evalCasesTable)
      .where(eq(schema.evalCasesTable.suiteId, suiteId))
      .orderBy(asc(schema.evalCasesTable.position));
  }

  /**
   * Org-scoped lookup through the owning suite; cases of soft-deleted suites
   * are not found.
   */
  static async findById(
    id: string,
    organizationId: string,
  ): Promise<EvalCase | null> {
    const [row] = await db
      .select({ evalCase: schema.evalCasesTable })
      .from(schema.evalCasesTable)
      .innerJoin(
        schema.evalSuitesTable,
        and(
          eq(schema.evalCasesTable.suiteId, schema.evalSuitesTable.id),
          eq(schema.evalSuitesTable.organizationId, organizationId),
          notDeleted(schema.evalSuitesTable),
        ),
      )
      .where(eq(schema.evalCasesTable.id, id));
    return row?.evalCase ?? null;
  }

  static async update(params: {
    id: string;
    organizationId: string;
    updates: UpdateEvalCase;
  }): Promise<EvalCase | null> {
    const existing = await EvalCaseModel.findById(
      params.id,
      params.organizationId,
    );
    if (!existing) return null;

    const [evalCase] = await db
      .update(schema.evalCasesTable)
      .set(params.updates)
      .where(eq(schema.evalCasesTable.id, params.id))
      .returning();
    return evalCase ?? null;
  }

  static async delete(params: {
    id: string;
    organizationId: string;
  }): Promise<boolean> {
    const existing = await EvalCaseModel.findById(
      params.id,
      params.organizationId,
    );
    if (!existing) return false;

    await db
      .delete(schema.evalCasesTable)
      .where(eq(schema.evalCasesTable.id, params.id));
    return true;
  }
}

export default EvalCaseModel;
