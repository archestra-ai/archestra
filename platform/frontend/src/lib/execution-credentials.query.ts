import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { reportApiError, throwOnApiError } from "@/lib/utils";

const {
  createExecutionCredential,
  deleteExecutionCredential,
  deleteOrganizationExecutionCredentialConnection,
  deletePersonalExecutionCredentialConnection,
  getExecutionCredentialUsage,
  listExecutionCredentials,
  setOrganizationExecutionCredentialConnection,
  setPersonalExecutionCredentialConnection,
  updateExecutionCredential,
} = archestraApiSdk;

export type ExecutionCredentialDefinition =
  archestraApiTypes.ListExecutionCredentialsResponses["200"][number];
export type ExecutionCredentialUsage =
  archestraApiTypes.GetExecutionCredentialUsageResponses["200"];

export const executionCredentialsQueryKey = ["execution-credentials"] as const;
export const executionCredentialUsageQueryKey = (key: string | null) =>
  ["execution-credential-usage", key] as const;

export function useExecutionCredentials(enabled = true) {
  return useQuery({
    queryKey: executionCredentialsQueryKey,
    queryFn: async () => {
      const { data, error } = await listExecutionCredentials();
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
    enabled,
  });
}

export function useCreateExecutionCredential() {
  return useCredentialMutation(
    async (body: archestraApiTypes.CreateExecutionCredentialData["body"]) => {
      const { data, error } = await createExecutionCredential({ body });
      if (error) throw reportApiError(error);
      return data;
    },
  );
}

export function useExecutionCredentialUsage(
  key: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: executionCredentialUsageQueryKey(key),
    queryFn: async () => {
      if (!key) return { agents: [] };
      const { data, error } = await getExecutionCredentialUsage({
        path: { key },
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? { agents: [] };
    },
    enabled: enabled && Boolean(key),
  });
}

export function useUpdateExecutionCredential() {
  return useCredentialMutation(
    async ({
      key,
      body,
    }: {
      key: string;
      body: archestraApiTypes.UpdateExecutionCredentialData["body"];
    }) => {
      const { data, error } = await updateExecutionCredential({
        path: { key },
        body,
      });
      if (error) throw reportApiError(error);
      return data;
    },
  );
}

export function useDeleteExecutionCredential() {
  return useCredentialMutation(async (key: string) => {
    const { data, error } = await deleteExecutionCredential({ path: { key } });
    if (error) throw reportApiError(error);
    return data;
  });
}

export function useSetExecutionCredentialConnection() {
  return useCredentialMutation(
    async ({
      key,
      scope,
      value,
    }: {
      key: string;
      scope: "personal" | "organization";
      value: string;
    }) => {
      const request = { path: { key }, body: { value } };
      const { data, error } =
        scope === "personal"
          ? await setPersonalExecutionCredentialConnection(request)
          : await setOrganizationExecutionCredentialConnection(request);
      if (error) throw reportApiError(error);
      return data;
    },
  );
}

export function useDeleteExecutionCredentialConnection() {
  return useCredentialMutation(
    async ({
      key,
      scope,
    }: {
      key: string;
      scope: "personal" | "organization";
    }) => {
      const request = { path: { key } };
      const { data, error } =
        scope === "personal"
          ? await deletePersonalExecutionCredentialConnection(request)
          : await deleteOrganizationExecutionCredentialConnection(request);
      if (error) throw reportApiError(error);
      return data;
    },
  );
}

function useCredentialMutation<TInput, TOutput>(
  mutationFn: (input: TInput) => Promise<TOutput>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: executionCredentialsQueryKey }),
  });
}
