import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

const { getLimits, createLimit, getLimit, updateLimit, deleteLimit } =
  archestraApiSdk;

export function useLimits(params?: {
  entityType?: "team" | "organization" | "agent";
  entityId?: string;
  limitType?: "token_cost" | "mcp_server_calls" | "tool_calls";
}) {
  return useQuery({
    queryKey: ["limits", params],
    queryFn: async () => {
      const response = await getLimits({
        query: params
          ? {
              ...(params.entityType && { entityType: params.entityType }),
              ...(params.entityId && { entityId: params.entityId }),
              ...(params.limitType && { limitType: params.limitType }),
            }
          : undefined,
      });
      return response.data ?? [];
    },
    // Automatically refetch every 5 seconds to keep usage data fresh
    refetchInterval: 5000,
    // Refetch when window regains focus
    refetchOnWindowFocus: true,
  });
}

export function useLimit(id: string) {
  return useQuery({
    queryKey: ["limits", id],
    queryFn: async () => {
      const response = await getLimit({ path: { id } });
      return response.data;
    },
    enabled: !!id,
  });
}

export function useCreateLimit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: archestraApiTypes.CreateLimitData["body"]) => {
      const response = await createLimit({ body: data });
      return response.data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["limits"] });
      toast.success("Limit created successfully");
    },
    onError: (error) => {
      console.error("Create limit error:", error);
      toast.error("Failed to create limit");
    },
  });
}

export function useUpdateLimit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...data
    }: { id: string } & Partial<archestraApiTypes.UpdateLimitData["body"]>) => {
      const response = await updateLimit({
        path: { id },
        body: data,
      });
      return response.data;
    },
    onSuccess: async (_, variables) => {
      await queryClient.invalidateQueries({ queryKey: ["limits"] });
      await queryClient.invalidateQueries({
        queryKey: ["limits", variables.id],
      });
      toast.success("Limit updated successfully");
    },
    onError: (error) => {
      console.error("Update limit error:", error);
      toast.error("Failed to update limit");
    },
  });
}

export function useDeleteLimit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const response = await deleteLimit({ path: { id } });
      return response.data;
    },
    onSuccess: async (_, variables) => {
      await queryClient.invalidateQueries({ queryKey: ["limits"] });
      queryClient.removeQueries({ queryKey: ["limits", variables.id] });
      toast.success("Limit deleted successfully");
    },
    onError: (error) => {
      console.error("Delete limit error:", error);
      toast.error("Failed to delete limit");
    },
  });
}
