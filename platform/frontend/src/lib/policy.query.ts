import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

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

export function useToolInvocationPolicies() {
  return useQuery({
    queryKey: ["tool-invocation-policies"],
    queryFn: async () => {
      const all = (await getToolInvocationPolicies()).data ?? [];
      const byToolPolicyId = all.reduce(
        (acc, policy) => {
          // @ts-expect-error legacy agentToolId in generated types
          const key = policy.toolPolicyId ?? policy.agentToolId;
          if (!key) return acc;
          acc[key] = [...(acc[key] || []), policy];
          return acc;
        },
        {} as Record<
          string,
          archestraApiTypes.GetToolInvocationPoliciesResponse["200"][]
        >,
      );
      return {
        all,
        byToolPolicyId,
      };
    },
  });
}

export function useToolInvocationPoliciesForPolicy(
  toolPolicyId: string | null,
) {
  return useQuery({
    queryKey: ["tool-invocation-policies", toolPolicyId],
    enabled: Boolean(toolPolicyId),
    queryFn: async () => {
      if (!toolPolicyId) return [];
      const all = (await getToolInvocationPolicies()).data ?? [];
      return all.filter((policy) => {
        return policy.toolPolicyId === toolPolicyId;
      });
    },
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
    },
  });
}

export function useToolInvocationPolicyCreateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ toolPolicyId }: { toolPolicyId: string }) =>
      await createToolInvocationPolicy({
        body: {
          toolPolicyId,
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
      updatedPolicy: archestraApiTypes.UpdateToolInvocationPolicyData["body"] & {
        id: string;
      },
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
  return useQuery({
    queryKey: ["tool-result-policies"],
    queryFn: async () => {
      const all = (await getTrustedDataPolicies()).data ?? [];
      const byToolPolicyId = all.reduce(
        (acc, policy) => {
          // @ts-expect-error legacy agentToolId in generated types
          const key = policy.toolPolicyId ?? policy.agentToolId;
          if (!key) return acc;
          acc[key] = [...(acc[key] || []), policy];
          return acc;
        },
        {} as Record<
          string,
          archestraApiTypes.GetTrustedDataPoliciesResponse["200"][]
        >,
      );
      return {
        all,
        byToolPolicyId,
      };
    },
  });
}

export function useToolResultPoliciesForPolicy(toolPolicyId: string | null) {
  return useQuery({
    queryKey: ["tool-result-policies", toolPolicyId],
    enabled: Boolean(toolPolicyId),
    queryFn: async () => {
      if (!toolPolicyId) return [];
      const all = (await getTrustedDataPolicies()).data ?? [];
      return all.filter((policy) => {
        return policy.toolPolicyId === toolPolicyId;
      });
    },
  });
}

export function useToolResultPoliciesCreateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ toolPolicyId }: { toolPolicyId: string }) =>
      await createTrustedDataPolicy({
        body: {
          toolPolicyId,
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
      updatedPolicy: archestraApiTypes.UpdateTrustedDataPolicyData["body"] & {
        id: string;
      },
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
