import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toBulkOutcome } from "@/lib/bulk-action";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils";

const {
  getLlmOauthClients,
  createLlmOauthClient,
  updateLlmOauthClient,
  rotateLlmOauthClientSecret,
  deleteLlmOauthClient,
  bulkDeleteLlmOauthClients,
} = archestraApiSdk;

type LlmOauthClientsQuery = NonNullable<
  archestraApiTypes.GetLlmOauthClientsData["query"]
>;
type LlmOauthClientsParams = Partial<LlmOauthClientsQuery> & {
  enabled?: boolean;
  toastOnError?: boolean;
};

export function useLlmOauthClients(params?: LlmOauthClientsParams) {
  const limit = params?.limit ?? 20;
  const offset = params?.offset ?? 0;
  const search = params?.search;
  const providerApiKeyId = params?.providerApiKeyId;
  const grantType = params?.grantType;
  const labels = params?.labels;

  return useQuery({
    queryKey: [
      "llm-oauth-clients",
      limit,
      offset,
      search,
      providerApiKeyId,
      grantType,
      labels,
    ],
    queryFn: async () => {
      const { data, error } = await getLlmOauthClients({
        query: {
          limit,
          offset,
          search: search || undefined,
          providerApiKeyId: providerApiKeyId || undefined,
          grantType: grantType || undefined,
          labels,
        },
      });
      throwOnApiError(error, { toastOnError: params?.toastOnError ?? true });
      return (
        data ?? {
          data: [],
          pagination: {
            currentPage: 1,
            limit,
            total: 0,
            totalPages: 0,
            hasNext: false,
            hasPrev: false,
          },
        }
      );
    },
    enabled: params?.enabled,
  });
}

export function useCreateLlmOauthClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.CreateLlmOauthClientData["body"],
    ) => {
      const { data, error } = await createLlmOauthClient({ body });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      toast.success("OAuth client created");
      queryClient.invalidateQueries({ queryKey: ["llm-oauth-clients"] });
    },
  });
}

export function useUpdateLlmOauthClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      body,
    }: {
      id: string;
      body: archestraApiTypes.UpdateLlmOauthClientData["body"];
    }) => {
      const { data, error } = await updateLlmOauthClient({
        path: { id },
        body,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      toast.success("OAuth client updated");
      queryClient.invalidateQueries({ queryKey: ["llm-oauth-clients"] });
    },
  });
}

export function useRotateLlmOauthClientSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const { data, error } = await rotateLlmOauthClientSecret({
        path: { id },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      toast.success("OAuth client secret rotated");
      queryClient.invalidateQueries({ queryKey: ["llm-oauth-clients"] });
    },
  });
}

export function useDeleteLlmOauthClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const { data, error } = await deleteLlmOauthClient({ path: { id } });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      toast.success("OAuth client deleted");
      queryClient.invalidateQueries({ queryKey: ["llm-oauth-clients"] });
    },
  });
}

/**
 * Deletes a selection of OAuth clients in one request. The caller reports the
 * batch once via `reportBulkOutcome` rather than a toast per row.
 */
export function useBulkDeleteLlmOauthClients() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (clients: readonly { id: string }[]) =>
      bulkDeleteLlmOauthClients({
        body: { ids: clients.map((client) => client.id) },
      }).then(({ data, error }) => {
        throwOnApiError(error, { toastOnError: false });
        return toBulkOutcome(data ?? { succeeded: [], failed: [] });
      }),
    // Settled rather than success: a partly applied batch still moved rows.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["llm-oauth-clients"] });
    },
  });
}
