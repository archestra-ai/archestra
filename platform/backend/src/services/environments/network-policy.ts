import { EnvironmentModel } from "@/models";
import {
  ApiError,
  type EffectiveNetworkPolicy,
  type NetworkPolicy,
} from "@/types";

// === Public API ===

const BUILT_IN_NETWORK_POLICY: EffectiveNetworkPolicy = {
  source: "built_in",
  policy: null,
};

export async function resolveEffectiveNetworkPolicy(params: {
  organizationId: string;
  environmentId?: string | null;
  environmentNetworkPolicy?: NetworkPolicy | null;
  defaultNetworkPolicy?: NetworkPolicy | null;
}): Promise<EffectiveNetworkPolicy> {
  if (params.environmentId) {
    let environmentNetworkPolicy = params.environmentNetworkPolicy;
    if (environmentNetworkPolicy === undefined) {
      const environment = await EnvironmentModel.findByIdForOrganization(
        params.environmentId,
        params.organizationId,
      );
      if (!environment) {
        throw new ApiError(404, "Environment not found");
      }
      environmentNetworkPolicy = environment.networkPolicy;
    }

    if (environmentNetworkPolicy) {
      return { source: "environment", policy: environmentNetworkPolicy };
    }
  }

  if (params.defaultNetworkPolicy) {
    return {
      source: "organization_default",
      policy: params.defaultNetworkPolicy,
    };
  }

  return BUILT_IN_NETWORK_POLICY;
}
