import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toBulkOutcome } from "@/lib/bulk-action";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils/api";

const {
  getOauthClients,
  createOauthClient,
  updateOauthClient,
  rotateOauthClientSecret,
  deleteOauthClient,
  bulkDeleteOauthClients,
} = archestraApiSdk;

type OauthClientsQuery = NonNullable<
  archestraApiTypes.GetOauthClientsData["query"]
>;
type OauthClientsParams = Partial<OauthClientsQuery> & {
  enabled?: boolean;
  toastOnError?: boolean;
};

export function useOauthClients(params?: OauthClientsParams) {
  const limit = params?.limit ?? 20;
  const offset = params?.offset ?? 0;
  const search = params?.search;
  const capability = params?.capability;
  const providerApiKeyId = params?.providerApiKeyId;
  const grantType = params?.grantType;
  const labels = params?.labels;
  const access = params?.access;
  const sharedWith = params?.sharedWith;
  const owner = params?.owner;

  return useQuery({
    queryKey: [
      "oauth-clients",
      limit,
      offset,
      search,
      capability,
      providerApiKeyId,
      grantType,
      labels,
      { access, sharedWith, owner },
    ],
    queryFn: async () => {
      const { data, error } = await getOauthClients({
        query: {
          limit,
          offset,
          search: search || undefined,
          capability,
          providerApiKeyId: providerApiKeyId || undefined,
          grantType: grantType || undefined,
          labels,
          access,
          sharedWith,
          owner,
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

export function useCreateOauthClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.CreateOauthClientData["body"],
    ) => {
      const { data, error } = await createOauthClient({ body });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      toast.success("OAuth client created");
      for (const key of [
        "oauth-clients",
        "mcp-oauth-clients",
        "llm-oauth-clients",
      ])
        queryClient.invalidateQueries({ queryKey: [key] });
    },
  });
}

export function useUpdateOauthClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      body,
    }: {
      id: string;
      body: archestraApiTypes.UpdateOauthClientData["body"];
    }) => {
      const { data, error } = await updateOauthClient({
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
      for (const key of [
        "oauth-clients",
        "mcp-oauth-clients",
        "llm-oauth-clients",
      ])
        queryClient.invalidateQueries({ queryKey: [key] });
    },
  });
}

export function useRotateOauthClientSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const { data, error } = await rotateOauthClientSecret({
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
      for (const key of [
        "oauth-clients",
        "mcp-oauth-clients",
        "llm-oauth-clients",
      ])
        queryClient.invalidateQueries({ queryKey: [key] });
    },
  });
}

export function useDeleteOauthClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const { data, error } = await deleteOauthClient({ path: { id } });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      toast.success("OAuth client deleted");
      for (const key of [
        "oauth-clients",
        "mcp-oauth-clients",
        "llm-oauth-clients",
      ])
        queryClient.invalidateQueries({ queryKey: [key] });
    },
  });
}

/**
 * Deletes a selection of OAuth clients in one request. The caller reports the
 * batch once via `reportBulkOutcome` rather than a toast per row.
 */
export function useBulkDeleteOauthClients() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (clients: readonly { id: string }[]) =>
      bulkDeleteOauthClients({
        body: { ids: clients.map((client) => client.id) },
      }).then(({ data, error }) => {
        throwOnApiError(error, { toastOnError: false });
        return toBulkOutcome(data ?? { succeeded: [], failed: [] });
      }),
    // Settled rather than success: a partly applied batch still moved rows.
    onSettled: () => {
      for (const key of [
        "oauth-clients",
        "mcp-oauth-clients",
        "llm-oauth-clients",
      ])
        queryClient.invalidateQueries({ queryKey: [key] });
    },
  });
}

/**
 * The clients that can reach one agent or MCP gateway. The server filters, so
 * this is one page unless more than 100 clients match.
 */
export function useOauthClientsForResource({
  resourceId,
  enabled = true,
}: {
  resourceId: string;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: ["oauth-clients", "applicable", resourceId],
    enabled,
    queryFn: async () => {
      const clients: archestraApiTypes.GetOauthClientsResponses["200"]["data"] =
        [];
      for (let offset = 0; ; offset += 100) {
        const { data, error } = await getOauthClients({
          query: { applicableTo: resourceId, limit: 100, offset },
        });
        throwOnApiError(error, { toastOnError: false });
        const page = data?.data ?? [];
        clients.push(...page);
        // An empty page also ends the walk, so a wrong hasNext cannot spin.
        if (!data?.pagination.hasNext || page.length === 0) return clients;
      }
    },
  });
}
