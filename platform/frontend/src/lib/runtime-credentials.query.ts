import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { reportApiError, throwOnApiError } from "@/lib/utils";

const {
  createRuntimeCredential,
  deleteRuntimeCredential,
  deleteOrganizationRuntimeCredentialConnection,
  deletePersonalRuntimeCredentialConnection,
  getRuntimeCredentialUsage,
  listRuntimeCredentials,
  setOrganizationRuntimeCredentialConnection,
  setPersonalRuntimeCredentialConnection,
  updateRuntimeCredential,
} = archestraApiSdk;

export type RuntimeCredentialDefinition =
  archestraApiTypes.ListRuntimeCredentialsResponses["200"][number];
export type RuntimeCredentialUsage =
  archestraApiTypes.GetRuntimeCredentialUsageResponses["200"];

export const runtimeCredentialsQueryKey = ["runtime-credentials"] as const;
export const runtimeCredentialUsageQueryKey = (key: string | null) =>
  ["runtime-credential-usage", key] as const;

export function useRuntimeCredentials(enabled = true) {
  return useQuery({
    queryKey: runtimeCredentialsQueryKey,
    queryFn: async () => {
      const { data, error } = await listRuntimeCredentials();
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
    enabled,
  });
}

export function useCreateRuntimeCredential() {
  return useCredentialMutation(
    async (body: archestraApiTypes.CreateRuntimeCredentialData["body"]) => {
      const { data, error } = await createRuntimeCredential({ body });
      if (error) throw reportApiError(error);
      return data;
    },
    (_, body) => toast.success(`${body.name} added`),
  );
}

export function useRuntimeCredentialUsage(key: string | null, enabled = true) {
  return useQuery({
    queryKey: runtimeCredentialUsageQueryKey(key),
    queryFn: async () => {
      if (!key) return { agents: [] };
      const { data, error } = await getRuntimeCredentialUsage({
        path: { key },
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? { agents: [] };
    },
    enabled: enabled && Boolean(key),
  });
}

export function useUpdateRuntimeCredential() {
  return useCredentialMutation(
    async ({
      key,
      body,
    }: {
      key: string;
      name: string;
      body: archestraApiTypes.UpdateRuntimeCredentialData["body"];
    }) => {
      const { data, error } = await updateRuntimeCredential({
        path: { key },
        body,
      });
      if (error) throw reportApiError(error);
      return data;
    },
    (_, input) => toast.success(`${input.name} updated`),
  );
}

export function useDeleteRuntimeCredential() {
  return useCredentialMutation(
    async ({ key }: { key: string; name: string }) => {
      const { data, error } = await deleteRuntimeCredential({
        path: { key },
      });
      if (error) throw reportApiError(error);
      return data;
    },
    (_, input) => toast.success(`${input.name} deleted`),
  );
}

export function useSetRuntimeCredentialConnection() {
  return useCredentialMutation(
    async (input: {
      key: string;
      name: string;
      scope: "personal" | "organization";
      value: string;
    }) => {
      const { key, scope, value } = input;
      const request = { path: { key }, body: { value } };
      const { data, error } =
        scope === "personal"
          ? await setPersonalRuntimeCredentialConnection(request)
          : await setOrganizationRuntimeCredentialConnection(request);
      if (error) throw reportApiError(error);
      return data;
    },
    (_, input) => toast.success(`${input.name} connected`),
  );
}

export function useDeleteRuntimeCredentialConnection() {
  return useCredentialMutation(
    async (input: {
      key: string;
      name: string;
      scope: "personal" | "organization";
    }) => {
      const { key, scope } = input;
      const request = { path: { key } };
      const { data, error } =
        scope === "personal"
          ? await deletePersonalRuntimeCredentialConnection(request)
          : await deleteOrganizationRuntimeCredentialConnection(request);
      if (error) throw reportApiError(error);
      return data;
    },
    (_, input) => toast.success(`${input.name} disconnected`),
  );
}

function useCredentialMutation<TInput, TOutput>(
  mutationFn: (input: TInput) => Promise<TOutput>,
  onSuccess?: (data: TOutput, input: TInput) => void,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (data, input) => {
      onSuccess?.(data, input);
      return queryClient.invalidateQueries({
        queryKey: runtimeCredentialsQueryKey,
      });
    },
  });
}
