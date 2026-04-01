import { archestraApiSdk, type archestraApiTypes } from "@shared";
import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import type { PolicyCondition } from "@/app/mcp/tool-guardrails/_parts/tool-call-policy-condition";

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
  type CallPolicyAction,
  type ResultPolicyAction,
  transformToolInvocationPolicies,
  transformToolResultPolicies,
} from "./policy.utils";
import { handleApiError } from "./utils";

export function useToolInvocationPolicies(
  initialData?: ReturnType<typeof transformToolInvocationPolicies>,
) {
  return useQuery({
    queryKey: ["tool-invocation-policies"],
    queryFn: async () => {
      const all = (await getToolInvocationPolicies()).data ?? [];
      return transformToolInvocationPolicies(all);
    },
    initialData,
  });
}

export function useOperators() {
  return useQuery({
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
  return useQuery({
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
      action,
    }: {
      toolId: string;
      action: CallPolicyAction;
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

      const result = defaultPolicy
        ? await updateToolInvocationPolicy({
            path: { id: defaultPolicy.id },
            body: { action },
          })
        : await createToolInvocationPolicy({
            body: {
              toolId,
              conditions: [],
              action,
              reason: null,
            },
          });

      if (result.error) {
        handleApiError(result.error);
        return false;
      }

      return true;
    },
    onSuccess: (success) => {
      if (!success) {
        return;
      }

      queryClient.invalidateQueries({ queryKey: ["tool-invocation-policies"] });
      queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
      toast.success("Call policy updated");
    },
  });
}

// Upsert a default result policy (trusted data policy with empty conditions)
export function useResultPolicyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      toolId,
      action,
    }: {
      toolId: string;
      action: ResultPolicyAction;
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

      const result = defaultPolicy
        ? await updateTrustedDataPolicy({
            path: { id: defaultPolicy.id },
            body: { action },
          })
        : await createTrustedDataPolicy({
            body: {
              toolId,
              conditions: [],
              action,
            },
          });

      if (result.error) {
        handleApiError(result.error);
        return false;
      }

      return true;
    },
    onSuccess: (success) => {
      if (!success) {
        return;
      }

      queryClient.invalidateQueries({ queryKey: ["tool-result-policies"] });
      queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
      toast.success("Result policy updated");
    },
  });
}

// Bulk update default call policies for multiple tools
export function useBulkCallPolicyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      toolIds,
      action,
    }: {
      toolIds: string[];
      action: CallPolicyAction;
    }) => {
      const result = await bulkUpsertDefaultCallPolicy({
        body: { toolIds, action },
      });
      return result.data ?? { updated: 0, created: 0 };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["tool-invocation-policies"] });
      queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
      const total = result.updated + result.created;
      toast.success(
        `Updated default call policy for ${total} tool${total === 1 ? "" : "s"}.`,
      );
    },
    onError: () => {
      toast.error("Failed to update default call policies.");
    },
  });
}

// Bulk update default result policies for multiple tools
export function useBulkResultPolicyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      toolIds,
      action,
    }: {
      toolIds: string[];
      action: ResultPolicyAction;
    }) => {
      const result = await bulkUpsertDefaultResultPolicy({
        body: { toolIds, action },
      });
      return result.data ?? { updated: 0, created: 0 };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["tool-result-policies"] });
      queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
      const total = result.updated + result.created;
      toast.success(
        `Updated default result policy for ${total} tool${total === 1 ? "" : "s"}.`,
      );
    },
    onError: () => {
      toast.error("Failed to update default result policies.");
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
