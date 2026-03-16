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

type KnowledgeBasesQuery = NonNullable<
  archestraApiTypes.GetKnowledgeBasesData["query"]
>;
type KnowledgeBasesListParams = {
  enabled?: boolean;
  query?: Partial<Pick<KnowledgeBasesQuery, "limit" | "offset" | "search">>;
};
type KnowledgeBasesPaginatedParams = Pick<
  KnowledgeBasesQuery,
  "limit" | "offset" | "search"
>;

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

export function useKnowledgeBases(params?: KnowledgeBasesListParams) {
  return useQuery({
    queryKey: ["knowledge-bases", "all", params?.query],
    queryFn: async () => {
      const { data, error } = await getKnowledgeBases({
        query: {
          limit: params?.query?.limit ?? 100,
          offset: params?.query?.offset ?? 0,
          search: params?.query?.search,
        },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data?.data ?? [];
    },
    enabled: params?.enabled,
  });
}

export function useKnowledgeBasesPaginated(
  params: KnowledgeBasesPaginatedParams,
) {
  return useQuery({
    queryKey: ["knowledge-bases", "paginated", params],
    placeholderData: (previousData) => previousData,
    queryFn: async () => {
      const { data, error } = await getKnowledgeBases({ query: params });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
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
      toast.success("Knowledge base created successfully");
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
      toast.success("Knowledge base updated successfully");
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
      toast.success("Knowledge base deleted successfully");
    },
  });
}
