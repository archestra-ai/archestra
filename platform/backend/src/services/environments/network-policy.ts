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

// === Public API ===

export const BUILT_IN_NETWORK_POLICY: EffectiveNetworkPolicy = {
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
  return NetworkPolicyModel.create(params);
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

  const updated = await NetworkPolicyModel.update(params);
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
      "This network policy is still assigned. Clear its environment, catalog, or installation assignments before deleting it.",
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
  installationNetworkPolicyId?: string | null;
  catalogNetworkPolicyId?: string | null;
  environmentId?: string | null;
  defaultNetworkPolicyId?: string | null;
}): Promise<EffectiveNetworkPolicy> {
  const installationPolicy = await findPolicyOrThrow({
    source: "installation",
    networkPolicyId: params.installationNetworkPolicyId,
    organizationId: params.organizationId,
  });
  if (installationPolicy) return installationPolicy;

  const catalogPolicy = await findPolicyOrThrow({
    source: "catalog",
    networkPolicyId: params.catalogNetworkPolicyId,
    organizationId: params.organizationId,
  });
  if (catalogPolicy) return catalogPolicy;

  if (params.environmentId) {
    const environment = await EnvironmentModel.findByIdForOrganization(
      params.environmentId,
      params.organizationId,
    );
    if (!environment) {
      throw new ApiError(404, "Environment not found");
    }

    const environmentPolicy = await findPolicyOrThrow({
      source: "environment",
      networkPolicyId: environment.networkPolicyId,
      organizationId: params.organizationId,
    });
    if (environmentPolicy) return environmentPolicy;
  }

  const defaultPolicy = await findPolicyOrThrow({
    source: "organization_default",
    networkPolicyId: params.defaultNetworkPolicyId,
    organizationId: params.organizationId,
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
  const existing = await NetworkPolicyModel.listForOrganization(
    params.organizationId,
  );
  if (
    existing.some(
      (policy) => policy.id !== params.exceptId && policy.name === params.name,
    )
  ) {
    throw new ApiError(409, "A network policy with this name already exists.");
  }
}

function countTotalReferences(
  references: NetworkPolicyReferenceCounts,
): number {
  return (
    references.environments +
    references.defaultEnvironments +
    references.catalogItems +
    references.mcpServerInstallations
  );
}

async function findPolicyOrThrow(params: {
  source: EffectiveNetworkPolicy["source"];
  networkPolicyId?: string | null;
  organizationId: string;
}): Promise<EffectiveNetworkPolicy | null> {
  if (!params.networkPolicyId) {
    return null;
  }
  const policy = await NetworkPolicyModel.findByIdForOrganization({
    id: params.networkPolicyId,
    organizationId: params.organizationId,
  });
  if (!policy) {
    throw new ApiError(404, "Network policy not found");
  }
  return { source: params.source, policy };
}
