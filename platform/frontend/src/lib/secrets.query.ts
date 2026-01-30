import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { handleApiError } from "./utils";

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
      const { data } = await getSecretsType();
      return data;
    },
  });
}

export function useGetSecret(secretId: string | null | undefined) {
  return useQuery({
    queryKey: secretsKeys.byId(secretId ?? ""),
    queryFn: async () => {
      if (!secretId) {
        return null;
      }
      const response = await getSecret({ path: { id: secretId } });
      if (response.error) {
        handleApiError(response.error);
        return null;
      }
      return response.data;
    },
    enabled: !!secretId,
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
