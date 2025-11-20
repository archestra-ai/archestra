import { and, count, eq, getTableColumns } from "drizzle-orm";

import db, { schema } from "@/database";
import {
  createPaginatedResult,
  type PaginatedResult,
} from "@/database/utils/pagination";
import type {
  InsertToolPolicy,
  ToolPolicy,
  ToolPolicyFilters,
  UpdateToolPolicy,
} from "@/types";

class ToolPolicyModel {
  static async create(policy: InsertToolPolicy): Promise<ToolPolicy> {
    const [created] = await db
      .insert(schema.toolPoliciesTable)
      .values(policy)
      .returning();

    return created as ToolPolicy;
  }

  static async findById(id: string): Promise<ToolPolicy | undefined> {
    const [policy] = await db
      .select()
      .from(schema.toolPoliciesTable)
      .where(eq(schema.toolPoliciesTable.id, id))
      .limit(1);

    return policy as ToolPolicy | undefined;
  }

  static async findAllByToolId(toolId: string): Promise<ToolPolicy[]> {
    const results = await db
      .select()
      .from(schema.toolPoliciesTable)
      .where(eq(schema.toolPoliciesTable.toolId, toolId))
      .orderBy(schema.toolPoliciesTable.createdAt);

    return results as ToolPolicy[];
  }

  static async findAllByOrganization(
    organizationId: string,
  ): Promise<ToolPolicy[]> {
    const results = await db
      .select()
      .from(schema.toolPoliciesTable)
      .where(eq(schema.toolPoliciesTable.organizationId, organizationId))
      .orderBy(schema.toolPoliciesTable.createdAt);

    return results as ToolPolicy[];
  }

  static async search(
    filters: ToolPolicyFilters,
  ): Promise<PaginatedResult<ToolPolicy>> {
    const { limit, offset, toolId, organizationId } = filters;
    const conditions = [] as Array<ReturnType<typeof eq>>;

    if (toolId) {
      conditions.push(eq(schema.toolPoliciesTable.toolId, toolId));
    }

    if (organizationId) {
      conditions.push(
        eq(schema.toolPoliciesTable.organizationId, organizationId),
      );
    }

    const whereClause = conditions.length ? and(...conditions) : undefined;

    const [data, totalResult] = await Promise.all([
      db
        .select()
        .from(schema.toolPoliciesTable)
        .where(whereClause)
        .orderBy(schema.toolPoliciesTable.createdAt)
        .limit(limit)
        .offset(offset),
      db
        .select({ count: count() })
        .from(schema.toolPoliciesTable)
        .where(whereClause),
    ]);

    const total = Number(totalResult[0]?.count ?? 0);

    return createPaginatedResult(data as ToolPolicy[], total, {
      limit,
      offset,
    });
  }

  static async update(
    id: string,
    updates: UpdateToolPolicy,
  ): Promise<ToolPolicy | undefined> {
    const [updated] = await db
      .update(schema.toolPoliciesTable)
      .set(updates)
      .where(eq(schema.toolPoliciesTable.id, id))
      .returning();

    return updated as ToolPolicy | undefined;
  }

  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.toolPoliciesTable)
      .where(eq(schema.toolPoliciesTable.id, id));

    return (result.rowCount ?? 0) > 0;
  }

  static async findByAgentTool(
    agentToolId: string,
  ): Promise<ToolPolicy | null> {
    const [assignment] = await db
      .select({ policy: getTableColumns(schema.toolPoliciesTable) })
      .from(schema.agentToolsTable)
      .leftJoin(
        schema.toolPoliciesTable,
        eq(schema.agentToolsTable.toolPolicyId, schema.toolPoliciesTable.id),
      )
      .where(eq(schema.agentToolsTable.id, agentToolId));

    return (assignment?.policy as ToolPolicy | undefined) ?? null;
  }
}

export default ToolPolicyModel;
