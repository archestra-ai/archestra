import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toBulkOutcome } from "@/lib/bulk-action";
import { useAllMatching } from "@/lib/hooks/use-all-matching";
import { useOrganization } from "@/lib/organization.query";
import { handleApiError, throwOnApiError } from "@/lib/utils";

const {
  bulkDeleteKnowledgeBases,
  getKnowledgeBases,
  getKnowledgeBase,
  getKnowledgeBaseHealth,
  createKnowledgeBase,
  updateKnowledgeBase,
  deleteKnowledgeBase,
  restoreKnowledgeBase,
  permanentlyDeleteKnowledgeBase,
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
  "limit" | "offset" | "search" | "status"
>;

/**
 * Check if knowledge base prerequisites are configured.
 *
 * Only embedding is a prerequisite: reranking is optional and best-effort —
 * the backend query path skips it when unconfigured — so it must not gate
 * knowledge base creation or agent knowledge-source assignment.
 */
export function useIsKnowledgeBaseConfigured(): boolean {
  const status = useKnowledgeBaseConfigStatus();
  return status.embedding;
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
      throwOnApiError(error);
      return data?.data ?? [];
    },
    enabled: params?.enabled,
  });
}

/** Every knowledge base matching the table's filters, not just the page in view. */
export function useAllMatchingKnowledgeBases(
  params: Omit<KnowledgeBasesPaginatedParams, "limit" | "offset">,
  options?: { enabled?: boolean },
) {
  return useAllMatching({
    queryKey: ["knowledge-bases", "all-matching", params],
    enabled: options?.enabled,
    fetchPage: async ({ limit, offset }) => {
      const { data, error } = await getKnowledgeBases({
        query: { ...params, limit, offset },
      });
      throwOnApiError(error, { toastOnError: false });
      return data?.data ?? [];
    },
  });
}

/**
 * Deletes a selection of knowledge bases in one request.
 *
 * There is no companion visibility action: a knowledge base has no audience of
 * its own — it is reached through the connectors and documents assigned to it —
 * so the only things editable about one are its name and description, which are
 * per-row by nature.
 */
export function useBulkDeleteKnowledgeBases() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (knowledgeBases: readonly { id: string }[]) =>
      bulkDeleteKnowledgeBases({
        body: { ids: knowledgeBases.map((kb) => kb.id) },
      }).then(({ data, error }) => {
        throwOnApiError(error, { toastOnError: false });
        return toBulkOutcome(data ?? { succeeded: [], failed: [] });
      }),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["knowledge-bases"] }),
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
      // Screen renders its own QueryLoadError panel; don't also toast.
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
  });
}

export function useKnowledgeBase(id: string | undefined) {
  return useQuery({
    queryKey: ["knowledge-bases", id],
    queryFn: async () => {
      if (!id) return null;
      const { data, error } = await getKnowledgeBase({ path: { id } });
      throwOnApiError(error, { allowNotFound: true });
      return data ?? null;
    },
    enabled: !!id,
  });
}

export function useKnowledgeBaseHealth(id: string) {
  return useQuery({
    queryKey: ["knowledge-bases", id, "health"],
    queryFn: async () => {
      const { data, error } = await getKnowledgeBaseHealth({ path: { id } });
      throwOnApiError(error, { allowNotFound: true });
      return data ?? null;
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

/** Restore a soft-deleted knowledge base from the trash view (admins). */
export function useRestoreKnowledgeBase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await restoreKnowledgeBase({ path: { id } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["knowledge-bases"] });
      toast.success("Knowledge base restored");
    },
  });
}

/** Permanently delete a soft-deleted knowledge base (admin-only trash action). */
export function usePermanentlyDeleteKnowledgeBase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await permanentlyDeleteKnowledgeBase({
        path: { id },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data, id) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["knowledge-bases"] });
      // Drop the detail query for an id that no longer resolves, rather than
      // letting a stale `?edit=` URL remount it and refetch into a 404.
      queryClient.removeQueries({ queryKey: ["knowledge-bases", id] });
      toast.success("Knowledge base permanently deleted");
    },
  });
}
