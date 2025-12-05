import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery } from "@tanstack/react-query";

const { getSecretsType, checkSecretsConnectivity } = archestraApiSdk;

export const secretsKeys = {
  all: ["secrets"] as const,
  type: () => [...secretsKeys.all, "type"] as const,
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

export function useCheckSecretsConnectivity() {
  return useMutation({
    mutationFn: async () => {
      const response = await checkSecretsConnectivity();
      if (response.error) {
        throw new Error(
          response.error?.error?.message ||
            "Failed to check secrets connectivity",
        );
      }
      return response.data as archestraApiTypes.CheckSecretsConnectivityResponses["200"];
    },
  });
}
