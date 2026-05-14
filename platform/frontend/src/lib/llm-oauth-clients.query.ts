import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, toApiError } from "@/lib/utils";

const {
  getLlmOauthClients,
  createLlmOauthClient,
  updateLlmOauthClient,
  rotateLlmOauthClientSecret,
  deleteLlmOauthClient,
} = archestraApiSdk;

type LlmOauthClientsParams = {
  search?: string;
  providerApiKeyId?: string;
  enabled?: boolean;
};

export function useLlmOauthClients(params?: LlmOauthClientsParams) {
  const search = params?.search;
  const providerApiKeyId = params?.providerApiKeyId;

  return useQuery({
    queryKey: ["llm-oauth-clients", search, providerApiKeyId],
    queryFn: async () => {
      const { data, error } = await getLlmOauthClients({
        query: {
          search: search || undefined,
          providerApiKeyId: providerApiKeyId || undefined,
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
