import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError } from "./utils";

const API_BASE = "/api/knowledge-graphs";

// ===== Types (will be replaced with generated SDK types later) =====

export interface KnowledgeGraphResponse {
  id: string;
  organizationId: string;
  name: string;
  provider: string;
  config: Record<string, unknown>;
  secretId: string | null;
  status: string;
  seededFromEnv: boolean;
  connectorsCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateKnowledgeGraphBody {
  name: string;
  provider: string;
  config: Record<string, unknown>;
  apiKey?: string;
}

export interface UpdateKnowledgeGraphBody {
  name?: string;
  config?: Record<string, unknown>;
  apiKey?: string;
  status?: string;
}

export interface HealthCheckResponse {
  status: "healthy" | "unhealthy";
  message?: string;
}

// ===== Query hooks =====

export function useKnowledgeGraphs() {
  return useQuery({
    queryKey: ["knowledge-graphs"],
    queryFn: async () => {
      const response = await fetch(API_BASE);
      if (!response.ok) {
        const error = await response.json();
        handleApiError(error);
        return [];
      }
      return (await response.json()) as KnowledgeGraphResponse[];
    },
  });
}

export function useKnowledgeGraph(id: string) {
  return useQuery({
    queryKey: ["knowledge-graphs", id],
    queryFn: async () => {
      const response = await fetch(`${API_BASE}/${id}`);
      if (!response.ok) {
        const error = await response.json();
        handleApiError(error);
        return null;
      }
      return (await response.json()) as KnowledgeGraphResponse;
    },
    enabled: !!id,
  });
}

export function useKnowledgeGraphHealth(id: string) {
  return useQuery({
    queryKey: ["knowledge-graphs", id, "health"],
    queryFn: async () => {
      const response = await fetch(`${API_BASE}/${id}/health`);
      if (!response.ok) {
        const error = await response.json();
        handleApiError(error);
        return null;
      }
      return (await response.json()) as HealthCheckResponse;
    },
    enabled: false, // Only fetch on demand
  });
}

export function useCreateKnowledgeGraph() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateKnowledgeGraphBody) => {
      const response = await fetch(API_BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!response.ok) {
        const error = await response.json();
        handleApiError(error);
        return null;
      }
      return (await response.json()) as KnowledgeGraphResponse;
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
      data,
    }: {
      id: string;
      data: UpdateKnowledgeGraphBody;
    }) => {
      const response = await fetch(`${API_BASE}/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!response.ok) {
        const error = await response.json();
        handleApiError(error);
        return null;
      }
      return (await response.json()) as KnowledgeGraphResponse;
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
      const response = await fetch(`${API_BASE}/${id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const error = await response.json();
        handleApiError(error);
        return null;
      }
      return true;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["knowledge-graphs"] });
      toast.success("Knowledge graph deleted successfully");
    },
  });
}
