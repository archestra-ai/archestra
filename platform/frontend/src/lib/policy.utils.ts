import type { archestraApiTypes } from "@shared";

export function transformToolInvocationPolicies(
  all: archestraApiTypes.GetToolInvocationPoliciesResponses["200"],
) {
  const byToolId = all.reduce(
    (acc, policy) => {
      acc[policy.toolId] = [...(acc[policy.toolId] || []), policy];
      return acc;
    },
    {} as Record<
      string,
      archestraApiTypes.GetToolInvocationPoliciesResponses["200"]
    >,
  );
  return {
    all,
    byToolId,
  };
}

export function transformToolResultPolicies(
  all: archestraApiTypes.GetTrustedDataPoliciesResponses["200"],
) {
  const byToolId = all.reduce(
    (acc, policy) => {
      acc[policy.toolId] = [...(acc[policy.toolId] || []), policy];
      return acc;
    },
    {} as Record<
      string,
      archestraApiTypes.GetTrustedDataPoliciesResponses["200"]
    >,
  );
  return {
    all,
    byToolId,
  };
}
