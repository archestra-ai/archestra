import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError } from "./utils";

const {
  getKnowledgeGraphs,
  getKnowledgeGraph,
  getKnowledgeGraphHealth,
  createKnowledgeGraph,
  updateKnowledgeGraph,
  deleteKnowledgeGraph,
} = archestraApiSdk;

// ===== Query hooks =====

export function useKnowledgeGraphs() {
  return useQuery({
    queryKey: ["knowledge-graphs"],
    queryFn: async () => {
      const { data, error } = await getKnowledgeGraphs();
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
  });
}

export function useKnowledgeGraph(id: string) {
  return useQuery({
    queryKey: ["knowledge-graphs", id],
    queryFn: async () => {
      const { data, error } = await getKnowledgeGraph({ path: { id } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    enabled: !!id,
  });
}

export function useKnowledgeGraphHealth(id: string) {
  return useQuery({
    queryKey: ["knowledge-graphs", id, "health"],
    queryFn: async () => {
      const { data, error } = await getKnowledgeGraphHealth({ path: { id } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    enabled: false, // Only fetch on demand
  });
}

export function useCreateKnowledgeGraph() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.CreateKnowledgeGraphData["body"],
    ) => {
      const { data, error } = await createKnowledgeGraph({ body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["knowledge-graphs"] });
      toast.success("Knowledge graph created successfully");
    },
  });
}

export function useUpdateKnowledgeGraph() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      body,
    }: {
      id: string;
      body: archestraApiTypes.UpdateKnowledgeGraphData["body"];
    }) => {
      const { data, error } = await updateKnowledgeGraph({
        path: { id },
        body,
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data, variables) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["knowledge-graphs"] });
      queryClient.invalidateQueries({
        queryKey: ["knowledge-graphs", variables.id],
      });
      toast.success("Knowledge graph updated successfully");
    },
  });
}

export function useDeleteKnowledgeGraph() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await deleteKnowledgeGraph({ path: { id } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["knowledge-graphs"] });
      toast.success("Knowledge graph deleted successfully");
    },
  });
}
