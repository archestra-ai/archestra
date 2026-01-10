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
      queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
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
      queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
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
          acc[policy.agentToolId] = [
            ...(acc[policy.agentToolId] || []),
            policy,
          ];
          return acc;
        },
        {} as Record<
          string,
          archestraApiTypes.GetToolInvocationPoliciesResponse["200"][]
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
          acc[policy.agentToolId] = [
            ...(acc[policy.agentToolId] || []),
            policy,
          ];
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
