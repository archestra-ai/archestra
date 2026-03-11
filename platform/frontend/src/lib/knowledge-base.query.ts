import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useOrganization } from "./organization.query";
import { handleApiError } from "./utils";

const {
  getKnowledgeBases,
  getKnowledgeBase,
  getKnowledgeBaseHealth,
  createKnowledgeBase,
  updateKnowledgeBase,
  deleteKnowledgeBase,
} = archestraApiSdk;

/**
 * Check if knowledge base prerequisites are configured.
 * Returns a boolean (all configured) and details about which parts are ready.
 */
export function useIsKnowledgeBaseConfigured(): boolean {
  const status = useKnowledgeBaseConfigStatus();
  return status.embedding && status.reranker;
}

export function useKnowledgeBaseConfigStatus() {
  const { data: organization } = useOrganization();
  const embedding =
    !!organization?.embeddingChatApiKeyId && !!organization?.embeddingModel;
  const reranker =
    !!organization?.rerankerChatApiKeyId && !!organization?.rerankerModel;
  return { embedding, reranker };
}

// ===== Query hooks =====

export function useKnowledgeBases(params?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["knowledge-bases"],
    queryFn: async () => {
      const { data, error } = await getKnowledgeBases();
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    enabled: params?.enabled,
  });
}

export function useKnowledgeBase(id: string) {
  return useQuery({
    queryKey: ["knowledge-bases", id],
    queryFn: async () => {
      const { data, error } = await getKnowledgeBase({ path: { id } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    enabled: !!id,
  });
}

export function useKnowledgeBaseHealth(id: string) {
  return useQuery({
    queryKey: ["knowledge-bases", id, "health"],
    queryFn: async () => {
      const { data, error } = await getKnowledgeBaseHealth({ path: { id } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    enabled: false, // Only fetch on demand
  });
}

export function useCreateKnowledgeBase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.CreateKnowledgeBaseData["body"],
    ) => {
      const { data, error } = await createKnowledgeBase({ body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["knowledge-bases"] });
      toast.success("Knowledge graph created successfully");
    },
  });
}

export function useUpdateKnowledgeBase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      body,
    }: {
      id: string;
      body: archestraApiTypes.UpdateKnowledgeBaseData["body"];
    }) => {
      const { data, error } = await updateKnowledgeBase({
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
      queryClient.invalidateQueries({ queryKey: ["knowledge-bases"] });
      queryClient.invalidateQueries({
        queryKey: ["knowledge-bases", variables.id],
      });
      toast.success("Knowledge graph updated successfully");
    },
  });
}

export function useDeleteKnowledgeBase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await deleteKnowledgeBase({ path: { id } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["knowledge-bases"] });
      toast.success("Knowledge graph deleted successfully");
    },
  });
}
