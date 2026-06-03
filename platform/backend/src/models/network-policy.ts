import { and, count, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  CreateNetworkPolicy,
  NetworkPolicy,
  NetworkPolicyReferenceCounts,
  NetworkPolicyWithReferences,
  UpdateNetworkPolicy,
} from "@/types";

// === Public API ===

class NetworkPolicyModel {
  static async listForOrganization(
    organizationId: string,
  ): Promise<NetworkPolicyWithReferences[]> {
    const policies = await db
      .select()
      .from(schema.networkPoliciesTable)
      .where(eq(schema.networkPoliciesTable.organizationId, organizationId))
      .orderBy(schema.networkPoliciesTable.createdAt);

    if (policies.length === 0) return [];

    const referenceCounts = await NetworkPolicyModel.countReferencesForPolicies(
      policies.map((policy) => policy.id),
    );

    return policies.map((policy) => ({
      ...policy,
      references: referenceCounts.get(policy.id) ?? emptyReferenceCounts(),
    }));
  }

  static async findByIdForOrganization(params: {
    id: string;
    organizationId: string;
  }): Promise<NetworkPolicy | null> {
    const [row] = await db
      .select()
      .from(schema.networkPoliciesTable)
      .where(
        and(
          eq(schema.networkPoliciesTable.id, params.id),
          eq(schema.networkPoliciesTable.organizationId, params.organizationId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    return NetworkPolicyModel.findByIdForOrganization({ id, organizationId });
  }

  static async listByIdsForOrganizations(params: {
    ids: string[];
    organizationIds: string[];
  }): Promise<NetworkPolicy[]> {
    if (params.ids.length === 0 || params.organizationIds.length === 0) {
      return [];
    }

    return db
      .select()
      .from(schema.networkPoliciesTable)
      .where(
        and(
          inArray(schema.networkPoliciesTable.id, params.ids),
          inArray(
            schema.networkPoliciesTable.organizationId,
            params.organizationIds,
          ),
        ),
      );
  }

  static async findByNameForOrganization(params: {
    name: string;
    organizationId: string;
  }): Promise<NetworkPolicy | null> {
    const [row] = await db
      .select()
      .from(schema.networkPoliciesTable)
      .where(
        and(
          eq(schema.networkPoliciesTable.name, params.name),
          eq(schema.networkPoliciesTable.organizationId, params.organizationId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  static async create(params: {
    organizationId: string;
    data: CreateNetworkPolicy;
  }): Promise<NetworkPolicy> {
    const [row] = await db
      .insert(schema.networkPoliciesTable)
      .values({
        organizationId: params.organizationId,
        ...params.data,
        description: params.data.description ?? null,
      })
      .returning();
    return row;
  }

  static async update(params: {
    id: string;
    organizationId: string;
    data: UpdateNetworkPolicy;
  }): Promise<NetworkPolicy | null> {
    const [row] = await db
      .update(schema.networkPoliciesTable)
      .set(params.data)
      .where(
        and(
          eq(schema.networkPoliciesTable.id, params.id),
          eq(schema.networkPoliciesTable.organizationId, params.organizationId),
        ),
      )
      .returning();
    return row ?? null;
  }

  static async delete(params: {
    id: string;
    organizationId: string;
  }): Promise<boolean> {
    const deleted = await db
      .delete(schema.networkPoliciesTable)
      .where(
        and(
          eq(schema.networkPoliciesTable.id, params.id),
          eq(schema.networkPoliciesTable.organizationId, params.organizationId),
        ),
      )
      .returning({ id: schema.networkPoliciesTable.id });
    return deleted.length > 0;
  }

  static async countReferences(
    networkPolicyId: string,
  ): Promise<NetworkPolicyReferenceCounts> {
    const [environments, defaultEnvironments] = await Promise.all([
      db
        .select({ count: count() })
        .from(schema.environmentsTable)
        .where(eq(schema.environmentsTable.networkPolicyId, networkPolicyId)),
      db
        .select({ count: count() })
        .from(schema.organizationsTable)
        .where(
          eq(schema.organizationsTable.defaultNetworkPolicyId, networkPolicyId),
        ),
    ]);

    return {
      environments: environments[0]?.count ?? 0,
      defaultEnvironments: defaultEnvironments[0]?.count ?? 0,
    };
  }

  static async countReferencesForPolicies(
    networkPolicyIds: string[],
  ): Promise<Map<string, NetworkPolicyReferenceCounts>> {
    if (networkPolicyIds.length === 0) return new Map();

    const countsByPolicyId = new Map<string, NetworkPolicyReferenceCounts>();
    for (const id of networkPolicyIds) {
      countsByPolicyId.set(id, emptyReferenceCounts());
    }

    const [environmentCounts, defaultEnvironmentCounts] = await Promise.all([
      db
        .select({
          networkPolicyId: schema.environmentsTable.networkPolicyId,
          count: count(),
        })
        .from(schema.environmentsTable)
        .where(
          inArray(schema.environmentsTable.networkPolicyId, networkPolicyIds),
        )
        .groupBy(schema.environmentsTable.networkPolicyId),
      db
        .select({
          networkPolicyId: schema.organizationsTable.defaultNetworkPolicyId,
          count: count(),
        })
        .from(schema.organizationsTable)
        .where(
          inArray(
            schema.organizationsTable.defaultNetworkPolicyId,
            networkPolicyIds,
          ),
        )
        .groupBy(schema.organizationsTable.defaultNetworkPolicyId),
    ]);

    for (const row of environmentCounts) {
      if (!row.networkPolicyId) continue;
      countsByPolicyId.set(row.networkPolicyId, {
        ...(countsByPolicyId.get(row.networkPolicyId) ??
          emptyReferenceCounts()),
        environments: row.count,
      });
    }
    for (const row of defaultEnvironmentCounts) {
      if (!row.networkPolicyId) continue;
      countsByPolicyId.set(row.networkPolicyId, {
        ...(countsByPolicyId.get(row.networkPolicyId) ??
          emptyReferenceCounts()),
        defaultEnvironments: row.count,
      });
    }

    return countsByPolicyId;
  }
}

function emptyReferenceCounts(): NetworkPolicyReferenceCounts {
  return {
    environments: 0,
    defaultEnvironments: 0,
  };
}

export default NetworkPolicyModel;
