import { archestraApiClient as client } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

export type MemoryItem = {
  id: string;
  organizationId: string;
  userId: string;
  content: string;
  namespace: string | null;
  createdAt: string;
  updatedAt: string;
};

export function useMemoryItems() {
  return useQuery({
    queryKey: ["memory-items"],
    queryFn: async () => {
      const { data } = await client.get({
        url: "/api/memory-items" as "/api/memory-items",
      });
      return (data ?? []) as MemoryItem[];
    },
  });
}

export function useCreateMemoryItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { content: string; namespace?: string }) => {
      const { data } = await client.post({
        url: "/api/memory-items" as "/api/memory-items",
        body,
      });
      return data as MemoryItem;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["memory-items"] });
      toast.success("Memory saved");
    },
    onError: () => {
      toast.error("Failed to save memory");
    },
  });
}

export function useUpdateMemoryItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...body
    }: {
      id: string;
      content: string;
      namespace?: string;
    }) => {
      const { data } = await client.put({
        url: "/api/memory-items/{id}" as "/api/memory-items/{id}",
        path: { id },
        body,
      });
      return data as MemoryItem;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["memory-items"] });
      toast.success("Memory updated");
    },
    onError: () => {
      toast.error("Failed to update memory");
    },
  });
}

export function useDeleteMemoryItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await client.delete({
        url: "/api/memory-items/{id}" as "/api/memory-items/{id}",
        path: { id },
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["memory-items"] });
      toast.success("Memory deleted");
    },
    onError: () => {
      toast.error("Failed to delete memory");
    },
  });
}
