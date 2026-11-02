import EnvironmentModel from "@/models/environment";
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

/**
 * The egress policy a runtime runs under. An agent's own policy wins over its
 * environment's, which wins over the organization default. Only the agent's
 * own runtimes (Agent Runtime pods and Code Sandbox engines) pass
 * `agentNetworkPolicy`; MCP servers follow their environment.
 */
export async function resolveEffectiveNetworkPolicy(params: {
  organizationId: string;
  agentNetworkPolicy?: NetworkPolicy | null;
  environmentId?: string | null;
  environmentNetworkPolicy?: NetworkPolicy | null;
  defaultNetworkPolicy?: NetworkPolicy | null;
}): Promise<EffectiveNetworkPolicy> {
  if (params.agentNetworkPolicy) {
    return { source: "agent", policy: params.agentNetworkPolicy };
  }

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
