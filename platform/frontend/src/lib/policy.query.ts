import { archestraApiSdk, type archestraApiTypes } from "@shared";
import {
  type QueryClient,
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";

const {
  createToolInvocationPolicy,
  createTrustedDataPolicy,
  deleteToolInvocationPolicy,
  deleteTrustedDataPolicy,
  getOperators,
  getToolInvocationPolicies,
  getTrustedDataPolicies,
  updateToolInvocationPolicy,
  updateTrustedDataPolicy,
} = archestraApiSdk;

import {
  transformToolInvocationPolicies,
  transformToolResultPolicies,
} from "./policy.utils";

export function useToolInvocationPolicies(
  initialData?: ReturnType<typeof transformToolInvocationPolicies>,
) {
  return useSuspenseQuery({
    queryKey: ["tool-invocation-policies"],
    queryFn: async () => {
      const all = (await getToolInvocationPolicies()).data ?? [];
      return transformToolInvocationPolicies(all);
    },
    initialData,
  });
}

export function useOperators() {
  return useSuspenseQuery({
    queryKey: ["operators"],
    queryFn: async () => (await getOperators()).data ?? [],
  });
}

export function useToolInvocationPolicyDeleteMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      await deleteToolInvocationPolicy({ path: { id } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tool-invocation-policies"] });
      queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
    },
  });
}

export function useToolInvocationPolicyCreateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ toolId }: { toolId: string }) =>
      await createToolInvocationPolicy({
        body: {
          toolId,
          conditions: [{ key: "", operator: "equal", value: "" }],
          action: "allow_when_context_is_untrusted",
          reason: null,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tool-invocation-policies"] });
      queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
    },
  });
}

export function useToolInvocationPolicyUpdateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    // Accept flat fields (argumentName, operator, value) and convert to conditions[]
    mutationFn: async (
      updatedPolicy: {
        id: string;
        argumentName?: string;
        operator?: string;
        value?: string;
        action?: "allow_when_context_is_untrusted" | "block_always";
        reason?: string | null;
      } & Record<string, unknown>,
    ) => {
      const { id, argumentName, operator, value, action, reason, ...rest } =
        updatedPolicy;

      // Build conditions array from flat fields if any are provided
      const hasConditionFields =
        argumentName !== undefined ||
        operator !== undefined ||
        value !== undefined;

      const body: archestraApiTypes.UpdateToolInvocationPolicyData["body"] = {
        ...rest,
        ...(action !== undefined && { action }),
        ...(reason !== undefined && { reason }),
        ...(hasConditionFields && {
          conditions: [
            {
              key: argumentName ?? "",
              operator: (operator as "equal") ?? "equal",
              value: value ?? "",
            },
          ],
        }),
      };

      return await updateToolInvocationPolicy({
        body,
        path: { id },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tool-invocation-policies"] });
      queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
    },
  });
}

export function useToolResultPolicies(
  initialData?: ReturnType<typeof transformToolResultPolicies>,
) {
  return useSuspenseQuery({
    queryKey: ["tool-result-policies"],
    queryFn: async () => {
      const all = (await getTrustedDataPolicies()).data ?? [];
      return transformToolResultPolicies(all);
    },
    initialData,
  });
}

export function useToolResultPoliciesCreateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ toolId }: { toolId: string }) =>
      await createTrustedDataPolicy({
        body: {
          toolId,
          conditions: [{ key: "", operator: "equal", value: "" }],
          action: "mark_as_trusted",
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tool-result-policies"] });
      queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
    },
  });
}

export function useToolResultPoliciesUpdateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    // Accept flat fields (attributePath, operator, value) and convert to conditions[]
    mutationFn: async (
      updatedPolicy: {
        id: string;
        attributePath?: string;
        operator?: string;
        value?: string;
        action?: "mark_as_trusted" | "block_always" | "sanitize_with_dual_llm";
      } & Record<string, unknown>,
    ) => {
      const { id, attributePath, operator, value, action, ...rest } =
        updatedPolicy;

      const hasConditionFields =
        attributePath !== undefined ||
        operator !== undefined ||
        value !== undefined;

      const body: archestraApiTypes.UpdateTrustedDataPolicyData["body"] = {
        ...rest,
        ...(action !== undefined && { action }),
        ...(hasConditionFields && {
          conditions: [
            {
              key: attributePath ?? "",
              operator: (operator as "equal") ?? "equal",
              value: value ?? "",
            },
          ],
        }),
      };

      return await updateTrustedDataPolicy({
        body,
        path: { id },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tool-result-policies"] });
      queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
    },
  });
}

export function useToolResultPoliciesDeleteMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      await deleteTrustedDataPolicy({ path: { id } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tool-result-policies"] });
      queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
    },
  });
}

// Prefetch functions
export function prefetchOperators(queryClient: QueryClient) {
  return queryClient.prefetchQuery({
    queryKey: ["operators"],
    queryFn: async () => (await getOperators()).data ?? [],
  });
}

export function prefetchToolInvocationPolicies(queryClient: QueryClient) {
  return queryClient.prefetchQuery({
    queryKey: ["tool-invocation-policies"],
    queryFn: async () => {
      const all = (await getToolInvocationPolicies()).data ?? [];
      const byProfileToolId = all.reduce(
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
        byProfileToolId,
      };
    },
  });
}

export function prefetchToolResultPolicies(queryClient: QueryClient) {
  return queryClient.prefetchQuery({
    queryKey: ["tool-result-policies"],
    queryFn: async () => {
      const all = (await getTrustedDataPolicies()).data ?? [];
      const byProfileToolId = all.reduce(
        (acc, policy) => {
          acc[policy.toolId] = [...(acc[policy.toolId] || []), policy];
          return acc;
        },
        {} as Record<
          string,
          archestraApiTypes.GetTrustedDataPoliciesResponse["200"][]
        >,
      );
      return {
        all,
        byProfileToolId,
      };
    },
  });
}
