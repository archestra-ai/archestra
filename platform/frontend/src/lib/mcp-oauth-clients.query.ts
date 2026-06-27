import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, toApiError } from "@/lib/utils";

const {
  getMcpOauthClients,
  createMcpOauthClient,
  updateMcpOauthClient,
  rotateMcpOauthClientSecret,
  deleteMcpOauthClient,
} = archestraApiSdk;

type McpOauthClientsParams = {
  search?: string;
  enabled?: boolean;
};

export function useMcpOauthClients(params?: McpOauthClientsParams) {
  const search = params?.search;

  return useQuery({
    queryKey: ["mcp-oauth-clients", search],
    queryFn: async () => {
      const { data, error } = await getMcpOauthClients({
        query: {
          search: search || undefined,
        },
      });
      if (error) {
        handleApiError(error);
        return [];
      }
      return data ?? [];
    },
    enabled: params?.enabled,
  });
}

export function useCreateMcpOauthClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.CreateMcpOauthClientData["body"],
    ) => {
      const { data, error } = await createMcpOauthClient({ body });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      toast.success("OAuth client created");
      queryClient.invalidateQueries({ queryKey: ["mcp-oauth-clients"] });
    },
  });
}

export function useUpdateMcpOauthClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      body,
    }: {
      id: string;
      body: archestraApiTypes.UpdateMcpOauthClientData["body"];
    }) => {
      const { data, error } = await updateMcpOauthClient({
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
      queryClient.invalidateQueries({ queryKey: ["mcp-oauth-clients"] });
    },
  });
}

export function useRotateMcpOauthClientSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const { data, error } = await rotateMcpOauthClientSecret({
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
      queryClient.invalidateQueries({ queryKey: ["mcp-oauth-clients"] });
    },
  });
}

export function useDeleteMcpOauthClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const { data, error } = await deleteMcpOauthClient({ path: { id } });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      toast.success("OAuth client deleted");
      queryClient.invalidateQueries({ queryKey: ["mcp-oauth-clients"] });
    },
  });
}
