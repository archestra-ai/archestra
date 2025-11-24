import { and, count, eq, getTableColumns, inArray } from "drizzle-orm";
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
import type { ToolInvocationPolicy } from "@/types/autonomy-policies/tool-invocation";
import type { TrustedDataPolicy } from "@/types/autonomy-policies/trusted-data";

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
  ): Promise<
    Array<
      ToolPolicy & {
        toolInvocationPolicies: ToolInvocationPolicy[];
        trustedDataPolicies: TrustedDataPolicy[];
      }
    >
  > {
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

    const policies = await query;
    if (policies.length === 0) return [];

    const policyIds = policies.map((p) => p.id);

    const [invocationPolicies, trustedPolicies] = await Promise.all([
      db
        .select()
        .from(schema.toolInvocationPoliciesTable)
        .where(
          inArray(schema.toolInvocationPoliciesTable.toolPolicyId, policyIds),
        ),
      db
        .select()
        .from(schema.trustedDataPoliciesTable)
        .where(
          inArray(schema.trustedDataPoliciesTable.toolPolicyId, policyIds),
        ),
    ]);

    const invocationByPolicy = new Map<string, ToolInvocationPolicy[]>();
    for (const policy of invocationPolicies) {
      const list = invocationByPolicy.get(policy.toolPolicyId) ?? [];
      list.push(policy as ToolInvocationPolicy);
      invocationByPolicy.set(policy.toolPolicyId, list);
    }

    const trustedByPolicy = new Map<string, TrustedDataPolicy[]>();
    for (const policy of trustedPolicies) {
      const list = trustedByPolicy.get(policy.toolPolicyId) ?? [];
      list.push(policy as TrustedDataPolicy);
      trustedByPolicy.set(policy.toolPolicyId, list);
    }

    return policies.map((policy) => ({
      ...policy,
      toolInvocationPolicies: invocationByPolicy.get(policy.id) ?? [],
      trustedDataPolicies: trustedByPolicy.get(policy.id) ?? [],
    }));
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
