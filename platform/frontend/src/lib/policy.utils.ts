import type { archestraApiTypes } from "@shared";

export type ToolResultTreatment =
  | "trusted"
  | "untrusted"
  | "sanitize_with_dual_llm";

// Helper to derive allowUsageWhenUntrustedDataIsPresent from invocation policies
// Checks if there's a default policy (no conditions or empty conditions) with action allow_when_context_is_untrusted
export function getAllowUsageFromPolicies(
  toolId: string,
  invocationPolicies: {
    byProfileToolId: Record<
      string,
      { conditions?: unknown; action?: string }[]
    >;
  },
): boolean {
  const policies = invocationPolicies.byProfileToolId[toolId] || [];
  // Check for a "default" policy (empty conditions array)
  const defaultPolicy = policies.find((p) => {
    const conditions = p.conditions as unknown[];
    return conditions.length === 0;
  });
  if (defaultPolicy) {
    return defaultPolicy.action === "allow_when_context_is_untrusted";
  }
  // No default policy found, blocked by default
  return false;
}

// Helper to derive toolResultTreatment from result policies
export function getResultTreatmentFromPolicies(
  toolId: string,
  resultPolicies: {
    byProfileToolId: Record<
      string,
      { conditions?: unknown; action?: string }[]
    >;
  },
): ToolResultTreatment {
  const policies = resultPolicies.byProfileToolId[toolId] || [];
  // If no policies, default to untrusted
  if (policies.length === 0) return "untrusted";
  // Check for a "default" policy (empty conditions array)
  const defaultPolicy = policies.find((p) => {
    const conditions = p.conditions as unknown[];
    return conditions.length === 0;
  });
  if (defaultPolicy) {
    const action = defaultPolicy.action;
    if (action === "mark_as_trusted") return "trusted";
    if (action === "sanitize_with_dual_llm") return "sanitize_with_dual_llm";
    return "untrusted";
  }
  // No default policy found, untrusted by default
  return "untrusted";
}

type InvocationPolicyRaw =
  archestraApiTypes.GetToolInvocationPoliciesResponses["200"][number];
type ResultPolicyRaw =
  archestraApiTypes.GetTrustedDataPoliciesResponses["200"][number];

// Transform policy to have flat fields for UI compatibility
export type TransformedInvocationPolicy = InvocationPolicyRaw & {
  argumentName: string;
  operator: string;
  value: string;
};

export type TransformedResultPolicy = ResultPolicyRaw & {
  attributePath: string;
  operator: string;
  value: string;
};

function extractFirstCondition(conditions: unknown): {
  key: string;
  operator: string;
  value: string;
} {
  if (Array.isArray(conditions) && conditions.length > 0) {
    const first = conditions[0];
    if (
      typeof first === "object" &&
      first !== null &&
      "key" in first &&
      "operator" in first &&
      "value" in first
    ) {
      return {
        key: String(first.key ?? ""),
        operator: String(first.operator ?? "equal"),
        value: String(first.value ?? ""),
      };
    }
  }
  return { key: "", operator: "equal", value: "" };
}

export function transformToolInvocationPolicies(
  all: archestraApiTypes.GetToolInvocationPoliciesResponses["200"],
) {
  // Transform to add flat fields
  const transformed: TransformedInvocationPolicy[] = all.map((policy) => {
    const { key, operator, value } = extractFirstCondition(policy.conditions);
    return {
      ...policy,
      argumentName: key,
      operator,
      value,
    };
  });

  const byProfileToolId = transformed.reduce(
    (acc, policy) => {
      acc[policy.toolId] = [...(acc[policy.toolId] || []), policy];
      return acc;
    },
    {} as Record<string, TransformedInvocationPolicy[]>,
  );

  return {
    all: transformed,
    byProfileToolId,
  };
}

export function transformToolResultPolicies(
  all: archestraApiTypes.GetTrustedDataPoliciesResponses["200"],
) {
  // Transform to add flat fields
  const transformed: TransformedResultPolicy[] = all.map((policy) => {
    const { key, operator, value } = extractFirstCondition(policy.conditions);
    return {
      ...policy,
      attributePath: key,
      operator,
      value,
    };
  });

  const byProfileToolId = transformed.reduce(
    (acc, policy) => {
      acc[policy.toolId] = [...(acc[policy.toolId] || []), policy];
      return acc;
    },
    {} as Record<string, TransformedResultPolicy[]>,
  );

  return {
    all: transformed,
    byProfileToolId,
  };
}
