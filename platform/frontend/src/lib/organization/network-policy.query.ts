import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useQuery } from "@tanstack/react-query";
import { handleApiError } from "@/lib/utils";

export const networkPolicyKeys = {
  all: ["network-policy"] as const,
  capabilities: () => [...networkPolicyKeys.all, "capabilities"] as const,
};

export type K8sCapabilities =
  archestraApiTypes.GetK8sCapabilitiesResponses["200"];

export function useK8sCapabilities(enabled = true) {
  return useQuery({
    queryKey: networkPolicyKeys.capabilities(),
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getK8sCapabilities();
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
    enabled,
    staleTime: 60 * 1000,
  });
}
