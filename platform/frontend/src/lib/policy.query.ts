import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  createToolInvocationPolicy,
  deleteToolInvocationPolicy,
  type GetToolInvocationPoliciesResponse,
  getOperators,
  getToolInvocationPolicies,
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
          description: "",
          argumentName: "",
          operator: "equal",
          value: "",
          action: "allow_when_context_is_untrusted",
          blockPrompt: null,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tool-invocation-policies"] });
    },
  });
}
