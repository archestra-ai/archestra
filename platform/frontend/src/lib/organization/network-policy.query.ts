import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError } from "@/lib/utils";

export const networkPolicyKeys = {
  all: ["network-policies"] as const,
  list: () => [...networkPolicyKeys.all, "list"] as const,
  capabilities: () => [...networkPolicyKeys.all, "capabilities"] as const,
};

export type NetworkPolicyWithReferences =
  archestraApiTypes.ListNetworkPoliciesResponses["200"][number];
export type NetworkPolicy =
  archestraApiTypes.CreateNetworkPolicyResponses["200"];
export type K8sCapabilities =
  archestraApiTypes.GetK8sCapabilitiesResponses["200"];

export function useNetworkPolicies(enabled = true) {
  return useQuery({
    queryKey: networkPolicyKeys.list(),
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.listNetworkPolicies();
      if (error) {
        handleApiError(error);
        return [] as NetworkPolicyWithReferences[];
      }
      return data ?? [];
    },
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}

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

export function useCreateNetworkPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.CreateNetworkPolicyData["body"],
    ) => {
      const { data, error } = await archestraApiSdk.createNetworkPolicy({
        body,
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (policy) => {
      if (!policy) return;
      queryClient.invalidateQueries({ queryKey: networkPolicyKeys.list() });
      toast.success(`${policy.name} added`);
    },
  });
}

export function useUpdateNetworkPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      id: string;
      body: archestraApiTypes.UpdateNetworkPolicyData["body"];
    }) => {
      const { data, error } = await archestraApiSdk.updateNetworkPolicy({
        path: { id: params.id },
        body: params.body,
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (policy) => {
      if (!policy) return;
      queryClient.invalidateQueries({ queryKey: networkPolicyKeys.list() });
      toast.success(`${policy.name} updated`);
    },
  });
}

export function useDeleteNetworkPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await archestraApiSdk.deleteNetworkPolicy({
        path: { id },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: networkPolicyKeys.list() });
      toast.success("Network policy deleted");
    },
  });
}
