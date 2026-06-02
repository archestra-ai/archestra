import { EnvironmentModel, NetworkPolicyModel } from "@/models";
import {
  ApiError,
  type CreateNetworkPolicy,
  type EffectiveNetworkPolicy,
  type NetworkPolicy,
  type NetworkPolicyReferenceCounts,
  type NetworkPolicyWithReferences,
  type UpdateNetworkPolicy,
} from "@/types";
import { isUniqueConstraintError } from "@/utils/db";

// === Public API ===

const NETWORK_POLICY_UNIQUE_CONSTRAINT = "network_policy_org_name_unique";

const BUILT_IN_NETWORK_POLICY: EffectiveNetworkPolicy = {
  source: "built_in",
  policy: null,
};

export async function listNetworkPolicies(
  organizationId: string,
): Promise<NetworkPolicyWithReferences[]> {
  return NetworkPolicyModel.listForOrganization(organizationId);
}

export async function createNetworkPolicy(params: {
  organizationId: string;
  data: CreateNetworkPolicy;
}): Promise<NetworkPolicy> {
  await assertUniqueName({
    organizationId: params.organizationId,
    name: params.data.name,
  });
  try {
    return await NetworkPolicyModel.create(params);
  } catch (error) {
    throw mapNetworkPolicyWriteError(error);
  }
}

export async function updateNetworkPolicy(params: {
  id: string;
  organizationId: string;
  data: UpdateNetworkPolicy;
}): Promise<NetworkPolicy> {
  if (params.data.name !== undefined) {
    await assertUniqueName({
      organizationId: params.organizationId,
      name: params.data.name,
      exceptId: params.id,
    });
  }

  let updated: NetworkPolicy | null;
  try {
    updated = await NetworkPolicyModel.update(params);
  } catch (error) {
    throw mapNetworkPolicyWriteError(error);
  }
  if (!updated) {
    throw new ApiError(404, "Network policy not found");
  }
  return updated;
}

export async function deleteNetworkPolicy(params: {
  id: string;
  organizationId: string;
}): Promise<void> {
  const existing = await NetworkPolicyModel.findByIdForOrganization(params);
  if (!existing) {
    throw new ApiError(404, "Network policy not found");
  }

  const references = await NetworkPolicyModel.countReferences(params.id);
  if (countTotalReferences(references) > 0) {
    throw new ApiError(
      409,
      "This network policy is still assigned. Clear its environment assignments before deleting it.",
    );
  }

  await NetworkPolicyModel.delete(params);
}

export async function assertNetworkPolicyBelongsToOrganization(params: {
  networkPolicyId: string | null | undefined;
  organizationId: string;
}): Promise<void> {
  if (!params.networkPolicyId) {
    return;
  }

  const policy = await NetworkPolicyModel.findByIdForOrganization({
    id: params.networkPolicyId,
    organizationId: params.organizationId,
  });
  if (!policy) {
    throw new ApiError(400, "Network policy not found");
  }
}

export async function resolveEffectiveNetworkPolicy(params: {
  organizationId: string;
  environmentId?: string | null;
  environmentNetworkPolicyId?: string | null;
  defaultNetworkPolicyId?: string | null;
  networkPoliciesById?: Map<string, NetworkPolicy>;
}): Promise<EffectiveNetworkPolicy> {
  if (params.environmentId) {
    let environmentNetworkPolicyId = params.environmentNetworkPolicyId;
    if (environmentNetworkPolicyId === undefined) {
      const environment = await EnvironmentModel.findByIdForOrganization(
        params.environmentId,
        params.organizationId,
      );
      if (!environment) {
        throw new ApiError(404, "Environment not found");
      }
      environmentNetworkPolicyId = environment.networkPolicyId;
    }

    const environmentPolicy = await findPolicyOrThrow({
      source: "environment",
      networkPolicyId: environmentNetworkPolicyId,
      organizationId: params.organizationId,
      networkPoliciesById: params.networkPoliciesById,
    });
    if (environmentPolicy) return environmentPolicy;
  }

  const defaultPolicy = await findPolicyOrThrow({
    source: "organization_default",
    networkPolicyId: params.defaultNetworkPolicyId,
    organizationId: params.organizationId,
    networkPoliciesById: params.networkPoliciesById,
  });
  if (defaultPolicy) return defaultPolicy;

  return BUILT_IN_NETWORK_POLICY;
}

// === Internal helpers ===

async function assertUniqueName(params: {
  organizationId: string;
  name: string;
  exceptId?: string;
}) {
  const existing = await NetworkPolicyModel.findByNameForOrganization({
    organizationId: params.organizationId,
    name: params.name,
  });
  if (existing && existing.id !== params.exceptId) {
    throw new ApiError(409, "A network policy with this name already exists.");
  }
}

function mapNetworkPolicyWriteError(error: unknown): Error {
  if (isUniqueConstraintError(error, NETWORK_POLICY_UNIQUE_CONSTRAINT)) {
    return new ApiError(409, "A network policy with this name already exists.");
  }
  return error instanceof Error ? error : new Error(String(error));
}

function countTotalReferences(
  references: NetworkPolicyReferenceCounts,
): number {
  return references.environments + references.defaultEnvironments;
}

async function findPolicyOrThrow(params: {
  source: EffectiveNetworkPolicy["source"];
  networkPolicyId?: string | null;
  organizationId: string;
  networkPoliciesById?: Map<string, NetworkPolicy>;
}): Promise<EffectiveNetworkPolicy | null> {
  if (!params.networkPolicyId) {
    return null;
  }
  const policy =
    params.networkPoliciesById?.get(params.networkPolicyId) ??
    (await NetworkPolicyModel.findByIdForOrganization({
      id: params.networkPolicyId,
      organizationId: params.organizationId,
    }));
  if (!policy) {
    throw new ApiError(404, "Network policy not found");
  }
  return { source: params.source, policy };
}
