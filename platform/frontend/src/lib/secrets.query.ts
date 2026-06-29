import {
  archestraApiSdk,
  type archestraApiTypes,
  SecretsManagerType,
} from "@archestra/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { handleApiError, throwOnApiError } from "./utils";

const { getSecretsType, checkSecretsConnectivity, getSecret } = archestraApiSdk;

export const secretsKeys = {
  all: ["secrets"] as const,
  type: () => [...secretsKeys.all, "type"] as const,
  byId: (id: string) => [...secretsKeys.all, "byId", id] as const,
  connectivity: () => [...secretsKeys.all, "connectivity"] as const,
};

export function useSecretsType() {
  return useQuery({
    queryKey: secretsKeys.type(),
    queryFn: async () => {
      const { data, error } = await getSecretsType();
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
  });
}

/**
 * Reads a secret by ID. The backend only allows this when BYOS is enabled
 * (or the specific secret is BYOS-backed) — calling it otherwise returns 403.
 * We gate the request on the secrets-type lookup so we don't fire pointless
 * 403s in non-BYOS deployments.
 */
export function useGetSecret(secretId: string | null | undefined) {
  const { data: secretsType } = useSecretsType();
  const byosEnabled = secretsType?.type === SecretsManagerType.BYOS_VAULT;

  return useQuery({
    queryKey: secretsKeys.byId(secretId ?? ""),
    queryFn: async () => {
      if (!secretId) {
        return null;
      }
      const response = await getSecret({ path: { id: secretId } });
      throwOnApiError(response.error, { allowNotFound: true });
      return response.data;
    },
    enabled: !!secretId && byosEnabled,
  });
}

export function useCheckSecretsConnectivity() {
  return useMutation({
    mutationFn: async () => {
      const response = await checkSecretsConnectivity();
      if (response.error) {
        handleApiError(response.error);
        return null;
      }
      return response.data as archestraApiTypes.CheckSecretsConnectivityResponses["200"];
    },
  });
}
