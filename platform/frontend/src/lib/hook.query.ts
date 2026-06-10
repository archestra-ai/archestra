"use client";

import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError } from "./utils";

const { getHooks, createHook, updateHook, deleteHook } = archestraApiSdk;

export type AgentHook = archestraApiTypes.GetHooksResponses["200"][number];

export type HookEvent = AgentHook["event"];

export type CreateHookInput = archestraApiTypes.CreateHookData["body"];

export type UpdateHookInput = archestraApiTypes.UpdateHookData["body"] &
  archestraApiTypes.UpdateHookData["path"];

const hookKeys = {
  all: ["hooks"] as const,
  list: (agentId: string) => [...hookKeys.all, "list", agentId] as const,
};

// List all hooks for an agent
export function useAgentHooks(agentId: string | undefined) {
  return useQuery<AgentHook[]>({
    queryKey: hookKeys.list(agentId ?? ""),
    queryFn: async () => {
      const response = await getHooks({
        query: { agentId: agentId as string },
      });
      if (response.error) {
        handleApiError(response.error);
        return [];
      }
      return response.data ?? [];
    },
    enabled: !!agentId,
    staleTime: 30 * 1000,
  });
}

// Create a hook
export function useCreateHook(agentId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateHookInput) => {
      const { data, error } = await createHook({ body: input });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: async (data) => {
      if (!data) return;
      toast.success("Hook created");
      await queryClient.invalidateQueries({
        queryKey: hookKeys.list(agentId),
      });
    },
  });
}

// Update a hook
export function useUpdateHook(agentId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateHookInput) => {
      const { id, ...body } = input;
      const { data, error } = await updateHook({ path: { id }, body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: async (data) => {
      if (!data) return;
      toast.success("Hook updated");
      await queryClient.invalidateQueries({
        queryKey: hookKeys.list(agentId),
      });
    },
  });
}

// Delete a hook
export function useDeleteHook(agentId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await deleteHook({ path: { id } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return { success: true };
    },
    onSuccess: async (data) => {
      if (!data) return;
      toast.success("Hook deleted");
      await queryClient.invalidateQueries({
        queryKey: hookKeys.list(agentId),
      });
    },
  });
}
