import { and, count, desc, eq, ilike, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import { ApiError } from "@/types";
import type { EvalSuite, InsertEvalSuite, UpdateEvalSuite } from "@/types/eval";
import { escapeLikePattern } from "@/utils/sql-search";
import EvalCaseModel from "./eval-case";

/** A suite row plus the number of live cases it contains. */
type EvalSuiteWithCaseCount = EvalSuite & { caseCount: number };

class EvalSuiteModel {
  static async create(params: InsertEvalSuite): Promise<EvalSuite> {
    try {
      const [suite] = await db
        .insert(schema.evalSuitesTable)
        .values(params)
        .returning();
      return suite;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(
          409,
          `An eval suite named "${params.name}" already exists`,
        );
      }
      throw error;
    }
  }

  static async countByOrganization(params: {
    organizationId: string;
    name?: string;
  }): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(schema.evalSuitesTable)
      .where(and(...listFilters(params)));
    return result?.count ?? 0;
  }

  static async listByOrganization(params: {
    organizationId: string;
    limit: number;
    offset: number;
    name?: string;
  }): Promise<EvalSuiteWithCaseCount[]> {
    const rows = await db
      .select({
        suite: schema.evalSuitesTable,
        caseCount: count(schema.evalCasesTable.id),
      })
      .from(schema.evalSuitesTable)
      .leftJoin(
        schema.evalCasesTable,
        eq(schema.evalCasesTable.suiteId, schema.evalSuitesTable.id),
      )
      .where(and(...listFilters(params)))
      .groupBy(schema.evalSuitesTable.id)
      .orderBy(desc(schema.evalSuitesTable.createdAt))
      .limit(params.limit)
      .offset(params.offset);

    return rows.map(({ suite, caseCount }) => ({ ...suite, caseCount }));
  }

  /** Org-scoped lookup; soft-deleted suites are not found. */
  static async findById(
    id: string,
    organizationId: string,
  ): Promise<EvalSuite | null> {
    const [suite] = await db
      .select()
      .from(schema.evalSuitesTable)
      .where(
        and(
          eq(schema.evalSuitesTable.id, id),
          eq(schema.evalSuitesTable.organizationId, organizationId),
          notDeleted(schema.evalSuitesTable),
        ),
      );
    return suite ?? null;
  }

  /** The requested suites the caller may see, fenced to their organization. */
  static async listByIds(
    ids: string[],
    organizationId: string,
  ): Promise<EvalSuite[]> {
    if (ids.length === 0) return [];
    return await db
      .select()
      .from(schema.evalSuitesTable)
      .where(
        and(
          inArray(schema.evalSuitesTable.id, ids),
          eq(schema.evalSuitesTable.organizationId, organizationId),
          notDeleted(schema.evalSuitesTable),
        ),
      );
  }

  static async update(params: {
    id: string;
    organizationId: string;
    updates: UpdateEvalSuite;
  }): Promise<EvalSuite | null> {
    try {
      const [suite] = await db
        .update(schema.evalSuitesTable)
        .set(params.updates)
        .where(
          and(
            eq(schema.evalSuitesTable.id, params.id),
            eq(schema.evalSuitesTable.organizationId, params.organizationId),
            notDeleted(schema.evalSuitesTable),
          ),
        )
        .returning();
      return suite ?? null;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(
          409,
          `An eval suite named "${params.updates.name}" already exists`,
        );
      }
      throw error;
    }
  }

  /** Soft delete. Cases/runs stay in place (runs keep their snapshots). */
  static async softDelete(
    id: string,
    organizationId: string,
  ): Promise<boolean> {
    const [suite] = await db
      .update(schema.evalSuitesTable)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(schema.evalSuitesTable.id, id),
          eq(schema.evalSuitesTable.organizationId, organizationId),
          notDeleted(schema.evalSuitesTable),
        ),
      )
      .returning({ id: schema.evalSuitesTable.id });
    return suite !== undefined;
  }

  /**
   * Audit snapshot: the suite plus its case list, so case CRUD (audited as
   * `evalSuite.updated`) produces meaningful before/after diffs.
   */
  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const suite = await EvalSuiteModel.findById(id, organizationId);
    if (!suite) return null;

    const cases = await EvalCaseModel.listBySuite(id);
    return {
      id: suite.id,
      name: suite.name,
      description: suite.description,
      createdBy: suite.createdBy,
      createdAt: suite.createdAt.toISOString(),
      cases: cases.map((evalCase) => ({
        id: evalCase.id,
        name: evalCase.name,
        input: evalCase.input,
        assertions: evalCase.assertions,
        position: evalCase.position,
      })),
    };
  }
}

export default EvalSuiteModel;

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  const cause = (error as { cause?: { code?: string } })?.cause;
  return code === "23505" || cause?.code === "23505";
}

function listFilters(params: { organizationId: string; name?: string }) {
  return [
    eq(schema.evalSuitesTable.organizationId, params.organizationId),
    notDeleted(schema.evalSuitesTable),
    ...(params.name
      ? [
          ilike(
            schema.evalSuitesTable.name,
            `%${escapeLikePattern(params.name)}%`,
          ),
        ]
      : []),
  ];
}
