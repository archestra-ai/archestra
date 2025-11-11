"use client";

import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const {
  getOptimizationRules,
  createOptimizationRule,
  updateOptimizationRule,
  deleteOptimizationRule,
} = archestraApiSdk;

export type OptimizationRule =
  archestraApiTypes.CreateOptimizationRuleResponses["201"];

export type CreateOptimizationRuleInput =
  archestraApiTypes.CreateOptimizationRuleData["body"] &
    archestraApiTypes.CreateOptimizationRuleData["path"];

export type UpdateOptimizationRuleInput = Partial<
  archestraApiTypes.UpdateOptimizationRuleData["body"]
> &
  archestraApiTypes.UpdateOptimizationRuleData["path"];

// Get all optimization rules for an agent
export function useOptimizationRules(agentId: string | null) {
  return useQuery<OptimizationRule[]>({
    queryKey: ["optimization-rules", agentId],
    queryFn: async () => {
      if (!agentId) return [];
      const response = await getOptimizationRules({
        path: { agentId },
      });
      return response.data ?? [];
    },
    enabled: !!agentId,
  });
}

// Get all optimization rules across all agents
export function useAllOptimizationRules() {
  return useQuery<OptimizationRule[]>({
    queryKey: ["optimization-rules", "all"],
    queryFn: async () => {
      // This would need a backend endpoint to list all rules
      // For now, return empty array
      return [];
    },
  });
}

// Create optimization rule
export function useCreateOptimizationRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreateOptimizationRuleInput) => {
      const { agentId, ...body } = data;
      const response = await createOptimizationRule({
        path: { agentId },
        body,
      });
      return response.data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["optimization-rules", variables.agentId],
      });
      queryClient.invalidateQueries({
        queryKey: ["optimization-rules", "all"],
      });
    },
  });
}

// Update optimization rule
export function useUpdateOptimizationRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: UpdateOptimizationRuleInput) => {
      const { id, ...updates } = data;
      const response = await updateOptimizationRule({
        path: { id },
        body: updates,
      });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["optimization-rules"] });
    },
  });
}

// Delete optimization rule
export function useDeleteOptimizationRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      await deleteOptimizationRule({
        path: { id },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["optimization-rules"] });
    },
  });
}
