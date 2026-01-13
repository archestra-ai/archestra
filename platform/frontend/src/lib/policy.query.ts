import { archestraApiSdk, type archestraApiTypes } from "@shared";
import {
  type QueryClient,
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import type { PolicyCondition } from "@/app/tools/_parts/tool-call-policy-condition";

const {
  bulkUpsertDefaultCallPolicy,
  bulkUpsertDefaultResultPolicy,
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
    mutationFn: async ({
      toolId,
      argumentName,
    }: {
      toolId: string;
      argumentName: string;
    }) =>
      await createToolInvocationPolicy({
        body: {
          toolId,
          conditions: [{ key: argumentName, operator: "equal", value: "" }],
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
    mutationFn: async (
      updatedPolicy: {
        id: string;
        conditions?: PolicyCondition[];
      } & NonNullable<archestraApiTypes.UpdateToolInvocationPolicyData["body"]>,
    ) => {
      const { id, conditions, action, reason } = updatedPolicy;

      return await updateToolInvocationPolicy({
        body: {
          ...(action !== undefined && { action }),
          ...(reason !== undefined && { reason }),
          ...(conditions !== undefined && { conditions }),
        },
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
    mutationFn: async ({
      toolId,
      attributePath,
    }: {
      toolId: string;
      attributePath: string;
    }) =>
      await createTrustedDataPolicy({
        body: {
          toolId,
          conditions: [{ key: attributePath, operator: "equal", value: "" }],
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
    mutationFn: async (
      updatedPolicy: {
        id: string;
        conditions?: PolicyCondition[];
      } & NonNullable<archestraApiTypes.UpdateTrustedDataPolicyData["body"]>,
    ) => {
      const { id, conditions, action } = updatedPolicy;

      return await updateTrustedDataPolicy({
        body: {
          ...(action !== undefined && { action }),
          ...(conditions !== undefined && { conditions }),
        },
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

// Upsert a default call policy (tool invocation policy with empty conditions)
export function useCallPolicyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      toolId,
      allowUsage,
    }: {
      toolId: string;
      allowUsage: boolean;
    }) => {
      // Get current policies from cache
      const cachedPolicies = queryClient.getQueryData<
        ReturnType<
          typeof import("./policy.utils").transformToolInvocationPolicies
        >
      >(["tool-invocation-policies"]);

      const existingPolicies = cachedPolicies?.byProfileToolId[toolId] || [];

      // Find default policy (empty conditions array)
      const defaultPolicy = existingPolicies.find(
        (p) => p.conditions.length === 0,
      );

      const action = allowUsage
        ? "allow_when_context_is_untrusted"
        : "block_when_context_is_untrusted";

      if (defaultPolicy) {
        // Update existing default policy
        return await updateToolInvocationPolicy({
          path: { id: defaultPolicy.id },
          body: { action },
        });
      }
      // Create new default policy with empty conditions
      return await createToolInvocationPolicy({
        body: {
          toolId,
          conditions: [],
          action,
          reason: null,
        },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tool-invocation-policies"] });
      queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
    },
  });
}

// Upsert a default result policy (trusted data policy with empty conditions)
export function useResultPolicyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      toolId,
      treatment,
    }: {
      toolId: string;
      treatment: "trusted" | "untrusted" | "sanitize_with_dual_llm";
    }) => {
      // Get current policies from cache
      const cachedPolicies = queryClient.getQueryData<
        ReturnType<typeof import("./policy.utils").transformToolResultPolicies>
      >(["tool-result-policies"]);

      const existingPolicies = cachedPolicies?.byProfileToolId[toolId] || [];

      // Find default policy (empty conditions array)
      const defaultPolicy = existingPolicies.find(
        (p) => p.conditions.length === 0,
      );

      // Map treatment to action
      const actionMap = {
        trusted: "mark_as_trusted",
        untrusted: "mark_as_untrusted",
        sanitize_with_dual_llm: "sanitize_with_dual_llm",
      } as const;
      const action = actionMap[treatment];

      if (defaultPolicy) {
        // Update existing default policy
        return await updateTrustedDataPolicy({
          path: { id: defaultPolicy.id },
          body: { action },
        });
      }
      // Create new default policy with empty conditions
      return await createTrustedDataPolicy({
        body: {
          toolId,
          conditions: [],
          action,
        },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tool-result-policies"] });
      queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
    },
  });
}

// Bulk update default call policies for multiple tools
export function useBulkCallPolicyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      toolIds,
      allowUsage,
    }: {
      toolIds: string[];
      allowUsage: boolean;
    }) => {
      const action = allowUsage
        ? "allow_when_context_is_untrusted"
        : "block_when_context_is_untrusted";
      const result = await bulkUpsertDefaultCallPolicy({
        body: { toolIds, action },
      });
      return result.data ?? { updated: 0, created: 0 };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tool-invocation-policies"] });
      queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
    },
  });
}

// Bulk update default result policies for multiple tools
export function useBulkResultPolicyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      toolIds,
      treatment,
    }: {
      toolIds: string[];
      treatment: "trusted" | "untrusted" | "sanitize_with_dual_llm";
    }) => {
      const actionMap = {
        trusted: "mark_as_trusted",
        untrusted: "mark_as_untrusted",
        sanitize_with_dual_llm: "sanitize_with_dual_llm",
      } as const;
      const action = actionMap[treatment];
      const result = await bulkUpsertDefaultResultPolicy({
        body: { toolIds, action },
      });
      return result.data ?? { updated: 0, created: 0 };
    },
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
