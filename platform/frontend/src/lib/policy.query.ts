import {
  type QueryClient,
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
} from "@/lib/clients/api";

export function useToolInvocationPolicies() {
  return useSuspenseQuery({
    queryKey: ["tool-invocation-policies"],
    queryFn: async () => {
      const all = (await getToolInvocationPolicies()).data ?? [];
      const byAgentToolId = all.reduce(
        (acc, policy) => {
          acc[policy.agentToolId] = [
            ...(acc[policy.agentToolId] || []),
            policy,
          ];
          return acc;
        },
        {} as Record<string, GetToolInvocationPoliciesResponse["200"][]>,
      );
      return {
        all,
        byAgentToolId,
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
    mutationFn: async ({ agentToolId }: { agentToolId: string }) =>
      await createToolInvocationPolicy({
        body: {
          agentToolId,
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
      const byAgentToolId = all.reduce(
        (acc, policy) => {
          acc[policy.agentToolId] = [
            ...(acc[policy.agentToolId] || []),
            policy,
          ];
          return acc;
        },
        {} as Record<string, GetTrustedDataPoliciesResponse["200"][]>,
      );
      return {
        all,
        byAgentToolId,
      };
    },
  });
}

export function useToolResultPoliciesCreateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ agentToolId }: { agentToolId: string }) =>
      await createTrustedDataPolicy({
        body: {
          agentToolId,
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
      const byAgentToolId = all.reduce(
        (acc, policy) => {
          acc[policy.agentToolId] = [
            ...(acc[policy.agentToolId] || []),
            policy,
          ];
          return acc;
        },
        {} as Record<string, GetToolInvocationPoliciesResponse["200"][]>,
      );
      return {
        all,
        byAgentToolId,
      };
    },
  });
}

export function prefetchToolResultPolicies(queryClient: QueryClient) {
  return queryClient.prefetchQuery({
    queryKey: ["tool-result-policies"],
    queryFn: async () => {
      const all = (await getTrustedDataPolicies()).data ?? [];
      const byAgentToolId = all.reduce(
        (acc, policy) => {
          acc[policy.agentToolId] = [
            ...(acc[policy.agentToolId] || []),
            policy,
          ];
          return acc;
        },
        {} as Record<string, GetTrustedDataPoliciesResponse["200"][]>,
      );
      return {
        all,
        byAgentToolId,
      };
    },
  });
}
