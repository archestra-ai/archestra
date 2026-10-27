import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { handleApiError, throwOnApiError } from "./utils";

const { getSecretsType, checkSecretsConnectivity } = archestraApiSdk;

export const secretsKeys = {
  all: ["secrets"] as const,
  type: () => [...secretsKeys.all, "type"] as const,
  connectivity: () => [...secretsKeys.all, "connectivity"] as const,
};

export function useSecretsType({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: secretsKeys.type(),
    enabled,
    queryFn: async () => {
      const { data, error } = await getSecretsType();
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
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
