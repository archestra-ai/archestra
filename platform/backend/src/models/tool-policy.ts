import { and, count, eq, getTableColumns } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  createPaginatedResult,
  type PaginatedResult,
} from "@/database/utils/pagination";
import type {
  InsertToolPolicy,
  PaginationQuery,
  ToolPolicy,
  UpdateToolPolicy,
} from "@/types";

class ToolPolicyModel {
  static async create(policy: InsertToolPolicy): Promise<ToolPolicy> {
    const [created] = await db
      .insert(schema.toolPoliciesTable)
      .values(policy)
      .returning();
    return created;
  }

  static async findById(id: string): Promise<ToolPolicy | null> {
    const [policy] = await db
      .select()
      .from(schema.toolPoliciesTable)
      .where(eq(schema.toolPoliciesTable.id, id));
    return policy;
  }

  static async findAllByToolId(
    toolId: string,
    organizationId?: string,
  ): Promise<ToolPolicy[]> {
    let query = db
      .select()
      .from(schema.toolPoliciesTable)
      .where(eq(schema.toolPoliciesTable.toolId, toolId))
      .$dynamic();

    if (organizationId) {
      query = query.where(
        eq(schema.toolPoliciesTable.organizationId, organizationId),
      );
    }

    const rows = await query;
    return rows;
  }

  static async search(
    pagination: PaginationQuery,
    filters: { toolId?: string; organizationId?: string } = {},
  ): Promise<PaginatedResult<ToolPolicy>> {
    const conditions = [];

    if (filters.toolId) {
      conditions.push(eq(schema.toolPoliciesTable.toolId, filters.toolId));
    }

    if (filters.organizationId) {
      conditions.push(
        eq(schema.toolPoliciesTable.organizationId, filters.organizationId),
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [data, [{ total }]] = await Promise.all([
      db
        .select()
        .from(schema.toolPoliciesTable)
        .where(whereClause)
        .orderBy(schema.toolPoliciesTable.createdAt)
        .limit(pagination.limit)
        .offset(pagination.offset),
      db
        .select({ total: count() })
        .from(schema.toolPoliciesTable)
        .where(whereClause),
    ]);

    return createPaginatedResult(data, Number(total), pagination);
  }

  static async findByAgentTool(
    agentToolId: string,
  ): Promise<ToolPolicy | null> {
    const [policy] = await db
      .select({
        ...getTableColumns(schema.toolPoliciesTable),
      })
      .from(schema.agentToolsTable)
      .innerJoin(
        schema.toolPoliciesTable,
        eq(schema.agentToolsTable.toolPolicyId, schema.toolPoliciesTable.id),
      )
      .where(eq(schema.agentToolsTable.id, agentToolId));

    return (policy as ToolPolicy) ?? null;
  }

  static async update(
    id: string,
    data: Partial<UpdateToolPolicy>,
  ): Promise<ToolPolicy | null> {
    const [policy] = await db
      .update(schema.toolPoliciesTable)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(schema.toolPoliciesTable.id, id))
      .returning();
    return policy;
  }

  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.toolPoliciesTable)
      .where(eq(schema.toolPoliciesTable.id, id));
    return (result.rowCount ?? 0) > 0;
  }
}

export default ToolPolicyModel;
