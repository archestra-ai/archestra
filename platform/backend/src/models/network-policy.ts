import { and, count, eq } from "drizzle-orm";
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

    return Promise.all(
      policies.map(async (policy) => ({
        ...policy,
        references: await NetworkPolicyModel.countReferences(policy.id),
      })),
    );
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
    const [
      environments,
      defaultEnvironments,
      catalogItems,
      mcpServerInstallations,
    ] = await Promise.all([
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
      db
        .select({ count: count() })
        .from(schema.internalMcpCatalogTable)
        .where(
          eq(schema.internalMcpCatalogTable.networkPolicyId, networkPolicyId),
        ),
      db
        .select({ count: count() })
        .from(schema.mcpServersTable)
        .where(eq(schema.mcpServersTable.networkPolicyId, networkPolicyId)),
    ]);

    return {
      environments: environments[0]?.count ?? 0,
      defaultEnvironments: defaultEnvironments[0]?.count ?? 0,
      catalogItems: catalogItems[0]?.count ?? 0,
      mcpServerInstallations: mcpServerInstallations[0]?.count ?? 0,
    };
  }
}

export default NetworkPolicyModel;
