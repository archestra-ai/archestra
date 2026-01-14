import type { archestraApiTypes } from "@shared";

export type CallPolicyAction =
  archestraApiTypes.GetToolInvocationPoliciesResponses["200"][number]["action"];

export type ResultPolicyAction =
  archestraApiTypes.GetTrustedDataPoliciesResponses["200"][number]["action"];

export const RESULT_POLICY_ACTION_OPTIONS: {
  value: ResultPolicyAction;
  label: string;
}[] = [
  { value: "mark_as_trusted", label: "Trusted" },
  { value: "mark_as_untrusted", label: "Untrusted" },
  { value: "sanitize_with_dual_llm", label: "Dual LLM" },
  { value: "block_always", label: "Blocked" },
];

// Longer labels for the policy modal
export const RESULT_POLICY_ACTION_OPTIONS_LONG: {
  value: ResultPolicyAction;
  label: string;
}[] = [
  { value: "mark_as_trusted", label: "Mark as trusted" },
  { value: "mark_as_untrusted", label: "Mark as untrusted" },
  { value: "sanitize_with_dual_llm", label: "Sanitize with Dual LLM" },
  { value: "block_always", label: "Block" },
];

type InvocationPolicy =
  archestraApiTypes.GetToolInvocationPoliciesResponses["200"][number];

type ResultPolicy =
  archestraApiTypes.GetTrustedDataPoliciesResponses["200"][number];

// Helper to derive call policy action from invocation policies
// Checks if there's a default policy (no conditions or empty conditions)
export function getCallPolicyActionFromPolicies(
  toolId: string,
  invocationPolicies: {
    byProfileToolId: Record<string, InvocationPolicy[]>;
  },
): CallPolicyAction {
  const policies = invocationPolicies.byProfileToolId[toolId] || [];
  // Check for a "default" policy (empty conditions array)
  const defaultPolicy = policies.find((p) => p.conditions.length === 0);
  if (defaultPolicy) {
    const action = defaultPolicy.action as CallPolicyAction;
    if (
      action === "allow_when_context_is_untrusted" ||
      action === "block_when_context_is_untrusted" ||
      action === "block_always"
    ) {
      return action;
    }
  }
  // No default policy found, block when untrusted by default
  return "block_when_context_is_untrusted";
}

// Legacy helper - returns boolean for backwards compatibility
// Checks if there's a default policy (no conditions or empty conditions) with action allow_when_context_is_untrusted
export function getAllowUsageFromPolicies(
  toolId: string,
  invocationPolicies: {
    byProfileToolId: Record<string, InvocationPolicy[]>;
  },
): boolean {
  const action = getCallPolicyActionFromPolicies(toolId, invocationPolicies);
  return action === "allow_when_context_is_untrusted";
}

// Helper to derive result policy action from result policies
export function getResultPolicyActionFromPolicies(
  toolId: string,
  resultPolicies: {
    byProfileToolId: Record<string, ResultPolicy[]>;
  },
): ResultPolicyAction {
  const policies = resultPolicies.byProfileToolId[toolId] || [];
  // If no policies, default to mark_as_untrusted
  if (policies.length === 0) return "mark_as_untrusted";
  // Check for a "default" policy (empty conditions array)
  const defaultPolicy = policies.find((p) => p.conditions.length === 0);
  if (defaultPolicy) {
    return defaultPolicy.action;
  }
  // No default policy found, mark_as_untrusted by default
  return "mark_as_untrusted";
}

// Transform policy to have flat fields for UI compatibility
export type TransformedInvocationPolicy = InvocationPolicy & {
  argumentName: string;
  operator: string;
  value: string;
};

export type TransformedResultPolicy = ResultPolicy & {
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
