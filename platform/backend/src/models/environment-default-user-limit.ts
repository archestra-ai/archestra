import { and, asc, eq, isNull } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  CreateEnvironmentDefaultUserLimit,
  EnvironmentDefaultUserLimit,
  UpdateEnvironmentDefaultUserLimit,
} from "@/types";

/**
 * Data access for default user limits. A row with `environmentId = null` is the
 * organization-wide default; a row with a set `environmentId` is a
 * per-environment override. Org ownership is enforced by callers (routes) via
 * `findByIdInOrganization` / the environment lookup; the
 * one-default-per-environment and one-global-per-org constraints are enforced by
 * the database (see the schema).
 */
class EnvironmentDefaultUserLimitModel {
  static async findAllForOrganization(
    organizationId: string,
  ): Promise<EnvironmentDefaultUserLimit[]> {
    return db
      .select()
      .from(schema.environmentDefaultUserLimitsTable)
      .where(
        eq(
          schema.environmentDefaultUserLimitsTable.organizationId,
          organizationId,
        ),
      )
      .orderBy(asc(schema.environmentDefaultUserLimitsTable.createdAt));
  }

  static async findByEnvironmentId(
    environmentId: string,
  ): Promise<EnvironmentDefaultUserLimit | null> {
    const [row] = await db
      .select()
      .from(schema.environmentDefaultUserLimitsTable)
      .where(
        eq(
          schema.environmentDefaultUserLimitsTable.environmentId,
          environmentId,
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** The organization-wide default (the NULL-environment row), if any. */
  static async findGlobal(
    organizationId: string,
  ): Promise<EnvironmentDefaultUserLimit | null> {
    const [row] = await db
      .select()
      .from(schema.environmentDefaultUserLimitsTable)
      .where(
        and(
          eq(
            schema.environmentDefaultUserLimitsTable.organizationId,
            organizationId,
          ),
          isNull(schema.environmentDefaultUserLimitsTable.environmentId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  static async findByIdInOrganization(
    id: string,
    organizationId: string,
  ): Promise<EnvironmentDefaultUserLimit | null> {
    const [row] = await db
      .select()
      .from(schema.environmentDefaultUserLimitsTable)
      .where(
        and(
          eq(schema.environmentDefaultUserLimitsTable.id, id),
          eq(
            schema.environmentDefaultUserLimitsTable.organizationId,
            organizationId,
          ),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  // Org-scoped snapshot for the audit hook (see middleware/audit-decisions.ts).
  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    return EnvironmentDefaultUserLimitModel.findByIdInOrganization(
      id,
      organizationId,
    );
  }

  static async create(
    params: CreateEnvironmentDefaultUserLimit & { organizationId: string },
  ): Promise<EnvironmentDefaultUserLimit> {
    const [row] = await db
      .insert(schema.environmentDefaultUserLimitsTable)
      .values({
        organizationId: params.organizationId,
        environmentId: params.environmentId ?? null,
        limitValue: params.limitValue,
        model: params.model ?? null,
        ...(params.cleanupInterval
          ? { cleanupInterval: params.cleanupInterval }
          : {}),
      })
      .returning();
    return row;
  }

  static async patch(
    id: string,
    data: UpdateEnvironmentDefaultUserLimit,
  ): Promise<EnvironmentDefaultUserLimit | null> {
    const [row] = await db
      .update(schema.environmentDefaultUserLimitsTable)
      .set({
        ...data,
        ...(data.model !== undefined ? { model: data.model ?? null } : {}),
      })
      .where(eq(schema.environmentDefaultUserLimitsTable.id, id))
      .returning();
    return row ?? null;
  }

  static async delete(id: string): Promise<void> {
    await db
      .delete(schema.environmentDefaultUserLimitsTable)
      .where(eq(schema.environmentDefaultUserLimitsTable.id, id));
  }
}

export default EnvironmentDefaultUserLimitModel;
