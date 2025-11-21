import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const {
  getToolPoliciesForTool,
  createToolPolicy,
  updateToolPolicy,
  deleteToolPolicy,
} = archestraApiSdk;

export function useToolPolicies(toolId: string | null) {
  return useQuery({
    queryKey: ["tool-policies", toolId],
    enabled: Boolean(toolId),
    queryFn: async () => {
      if (!toolId) return [];
      const result = await getToolPoliciesForTool({
        path: { toolId },
      });
      return result.data ?? [];
    },
  });
}

export function useCreateToolPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      toolId,
      ...body
    }: {
      toolId: string;
    } & archestraApiTypes.CreateToolPolicyData["body"]) => {
      const result = await createToolPolicy({
        path: { toolId },
        body,
      });
      return result.data ?? null;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["tool-policies", variables.toolId],
      });
    },
  });
}

export function useUpdateToolPolicy(toolId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      policyId,
      ...body
    }: {
      policyId: string;
    } & archestraApiTypes.UpdateToolPolicyData["body"]) => {
      const result = await updateToolPolicy({
        path: { policyId },
        body,
      });
      return result.data ?? null;
    },
    onSuccess: () => {
      if (toolId) {
        queryClient.invalidateQueries({
          queryKey: ["tool-policies", toolId],
        });
      }
    },
  });
}

export function useDeleteToolPolicy(toolId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (policyId: string) => {
      const result = await deleteToolPolicy({
        path: { policyId },
      });
      return result.data?.success ?? false;
    },
    onSuccess: () => {
      if (toolId) {
        queryClient.invalidateQueries({
          queryKey: ["tool-policies", toolId],
        });
      }
    },
  });
}
