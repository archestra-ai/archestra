import type { archestraApiTypes } from "@shared";

export function transformToolInvocationPolicies(
  all: archestraApiTypes.GetToolInvocationPoliciesResponses["200"],
) {
  const byProfileToolId = all.reduce(
    (acc, policy) => {
      acc[policy.agentToolId] = [...(acc[policy.agentToolId] || []), policy];
      return acc;
    },
    {} as Record<
      string,
      archestraApiTypes.GetToolInvocationPoliciesResponses["200"]
    >,
  );
  return {
    all,
    byProfileToolId,
  };
}

export function transformToolResultPolicies(
  all: archestraApiTypes.GetTrustedDataPoliciesResponses["200"],
) {
  const byProfileToolId = all.reduce(
    (acc, policy) => {
      acc[policy.agentToolId] = [...(acc[policy.agentToolId] || []), policy];
      return acc;
    },
    {} as Record<
      string,
      archestraApiTypes.GetTrustedDataPoliciesResponses["200"]
    >,
  );
  return {
    all,
    byProfileToolId,
  };
}
