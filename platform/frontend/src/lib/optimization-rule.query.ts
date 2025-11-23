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
  archestraApiTypes.CreateOptimizationRuleResponses["200"];

export type CreateOptimizationRuleInput =
  archestraApiTypes.CreateOptimizationRuleData["body"];

export type UpdateOptimizationRuleInput = Partial<
  archestraApiTypes.UpdateOptimizationRuleData["body"]
> &
  archestraApiTypes.UpdateOptimizationRuleData["path"];

// Get all optimization rules for the organization
export function useOptimizationRules() {
  return useQuery<OptimizationRule[]>({
    queryKey: ["optimization-rules"],
    queryFn: async () => {
      const response = await getOptimizationRules();
      return response.data ?? [];
    },
  });
}

// Create optimization rule
export function useCreateOptimizationRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreateOptimizationRuleInput) => {
      const response = await createOptimizationRule({
        body: data,
      });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["optimization-rules"],
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
