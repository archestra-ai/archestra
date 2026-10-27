import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { throwOnApiError, toApiError } from "@/lib/utils/api";

/**
 * GitHub Copilot paid by a GitHub organization: the GitHub App setup that
 * stores it as a shared provider key.
 */
export function usePendingCopilotGithubApp(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: pendingQueryKey,
    queryFn: async () => {
      const { data, error } =
        await archestraApiSdk.getPendingCopilotGithubApp();
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
  });
}

export function useStartCopilotGithubApp() {
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.StartCopilotGithubAppData["body"],
    ) => {
      const { data, error } = await archestraApiSdk.startCopilotGithubApp({
        body,
      });
      if (error) throw toApiError(error);
      return data;
    },
  });
}

export function useCompleteCopilotGithubApp() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.CompleteCopilotGithubAppData["body"],
    ) => {
      const { data, error } = await archestraApiSdk.completeCopilotGithubApp({
        body,
      });
      if (error) throw toApiError(error);
      return data;
    },
    onSuccess: (data) => client.setQueryData(pendingQueryKey, data ?? null),
  });
}

export function useInstallCopilotGithubApp() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.InstallCopilotGithubAppData["body"],
    ) => {
      const { data, error } = await archestraApiSdk.installCopilotGithubApp({
        body,
      });
      if (error) throw toApiError(error);
      return data;
    },
    onSuccess: (data) => {
      if (data?.status !== "installed") return;
      client.setQueryData(pendingQueryKey, null);
      invalidateKeys(client);
    },
    // The App may have been deleted on GitHub, which also clears it here.
    onError: () => client.invalidateQueries({ queryKey: pendingQueryKey }),
  });
}

export function useDiscardCopilotGithubApp() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { error } = await archestraApiSdk.discardCopilotGithubApp();
      if (error) throw toApiError(error);
    },
    onSuccess: () => client.setQueryData(pendingQueryKey, null),
  });
}

export function useValidateExistingCopilotGithubApp() {
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.ValidateExistingCopilotGithubAppData["body"],
    ) => {
      const { data, error } =
        await archestraApiSdk.validateExistingCopilotGithubApp({ body });
      if (error) throw toApiError(error);
      return data;
    },
  });
}

export function useConnectExistingCopilotGithubApp() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.ConnectExistingCopilotGithubAppData["body"],
    ) => {
      const { data, error } =
        await archestraApiSdk.connectExistingCopilotGithubApp({ body });
      if (error) throw toApiError(error);
      return data;
    },
    onSuccess: () => invalidateKeys(client),
  });
}

const pendingQueryKey = ["github-copilot-app", "pending"];

function invalidateKeys(client: QueryClient) {
  client.invalidateQueries({ queryKey: ["llm-provider-api-keys"] });
  client.invalidateQueries({ queryKey: ["available-llm-provider-api-keys"] });
  client.invalidateQueries({ queryKey: ["llm-models"] });
  client.invalidateQueries({ queryKey: ["models-with-api-keys"] });
}

/** What the edit dialog shows for an organization subscription's App. */
export function useCopilotGithubAppKeySummary(keyId: string | null) {
  return useQuery({
    enabled: !!keyId,
    queryKey: ["github-copilot-app", "key", keyId],
    queryFn: async () => {
      const { data, error } =
        await archestraApiSdk.getCopilotGithubAppKeySummary({
          path: { id: keyId as string },
        });
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
  });
}

export function useReplaceCopilotGithubAppPrivateKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (params: { id: string; privateKey: string }) => {
      const { data, error } =
        await archestraApiSdk.replaceCopilotGithubAppPrivateKey({
          path: { id: params.id },
          body: { privateKey: params.privateKey },
        });
      if (error) throw toApiError(error);
      return data;
    },
    onSuccess: (_data, params) => {
      client.invalidateQueries({
        queryKey: ["github-copilot-app", "key", params.id],
      });
      invalidateKeys(client);
    },
  });
}
