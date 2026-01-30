"use client";

import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError } from "./utils";

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
      if (response.error) {
        handleApiError(response.error);
      }
      return response.data ?? [];
    },
  });
}

// Create optimization rule
export function useCreateOptimizationRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreateOptimizationRuleInput) => {
      const { data: responseData, error } = await createOptimizationRule({
        body: data,
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return responseData;
    },
    onSuccess: async () => {
      toast.success("Optimization rule created");
      // Wait for the query to refetch to avoid showing stale data
      await queryClient.invalidateQueries({
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
      const { data: responseData, error } = await updateOptimizationRule({
        path: { id },
        body: updates,
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return responseData;
    },
    onSuccess: async () => {
      toast.success("Optimization rule updated");
      // Wait for the query to refetch to avoid showing stale data
      await queryClient.invalidateQueries({ queryKey: ["optimization-rules"] });
    },
  });
}

// Delete optimization rule
export function useDeleteOptimizationRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await deleteOptimizationRule({
        path: { id },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return { success: true };
    },
    onSuccess: async () => {
      toast.success("Optimization rule deleted");
      // Wait for the query to refetch to avoid showing stale data
      await queryClient.invalidateQueries({ queryKey: ["optimization-rules"] });
    },
  });
}
