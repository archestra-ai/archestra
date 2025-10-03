import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  createToolInvocationPolicy,
  createTrustedDataPolicy,
  deleteToolInvocationPolicy,
  deleteTrustedDataPolicy,
  type GetToolInvocationPoliciesResponse,
  type GetTrustedDataPoliciesResponse,
  getOperators,
  getToolInvocationPolicies,
  getTrustedDataPolicies,
  type UpdateToolInvocationPolicyData,
  type UpdateTrustedDataPolicyData,
  updateToolInvocationPolicy,
  updateTrustedDataPolicy,
} from "shared/api-client";

export function useToolInvocationPolicies() {
  return useSuspenseQuery({
    queryKey: ["tool-invocation-policies"],
    queryFn: async () => {
      const all = (await getToolInvocationPolicies()).data ?? [];
      const byToolId = all.reduce(
        (acc, policy) => {
          acc[policy.toolId] = [...(acc[policy.toolId] || []), policy];
          return acc;
        },
        {} as Record<string, GetToolInvocationPoliciesResponse["200"][]>,
      );
      return {
        all,
        byToolId,
      };
    },
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
          argumentName: "",
          operator: "equal",
          value: "",
          action: "allow_when_context_is_untrusted",
          reason: null,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tool-invocation-policies"] });
    },
  });
}

export function useToolInvocationPolicyUpdateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      updatedPolicy: UpdateToolInvocationPolicyData["body"] & { id: string },
    ) => {
      return await updateToolInvocationPolicy({
        body: updatedPolicy,
        path: { id: updatedPolicy.id },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tool-invocation-policies"] });
    },
  });
}

export function useToolResultPolicies() {
  return useSuspenseQuery({
    queryKey: ["tool-result-policies"],
    queryFn: async () => {
      const all = (await getTrustedDataPolicies()).data ?? [];
      const byToolId = all.reduce(
        (acc, policy) => {
          acc[policy.toolId] = [...(acc[policy.toolId] || []), policy];
          return acc;
        },
        {} as Record<string, GetTrustedDataPoliciesResponse["200"][]>,
      );
      return {
        all,
        byToolId,
      };
    },
  });
}

export function useToolResultPoliciesCreateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ toolId }: { toolId: string }) =>
      await createTrustedDataPolicy({
        body: {
          toolId,
          description: "",
          attributePath: "",
          operator: "equal",
          value: "",
          action: "mark_as_trusted",
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tool-result-policies"] });
    },
  });
}

export function useToolResultPoliciesUpdateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      updatedPolicy: UpdateTrustedDataPolicyData["body"] & { id: string },
    ) => {
      return await updateTrustedDataPolicy({
        body: updatedPolicy,
        path: { id: updatedPolicy.id },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tool-result-policies"] });
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
    },
  });
}
