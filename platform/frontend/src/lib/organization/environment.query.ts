import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError } from "@/lib/utils";
import { networkPolicyKeys } from "./network-policy.query";

export const environmentKeys = {
  all: ["environments"] as const,
  list: () => [...environmentKeys.all, "list"] as const,
};

export type EnvironmentList =
  archestraApiTypes.ListEnvironmentsResponses["200"];
export type EnvironmentWithAssignedCount =
  EnvironmentList["environments"][number];

const EMPTY_ENVIRONMENT_LIST: EnvironmentList = {
  environments: [],
  defaultAssignedCatalogCount: 0,
};

export function useEnvironments(enabled = true) {
  return useQuery({
    queryKey: environmentKeys.list(),
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.listEnvironments();
      if (error) {
        handleApiError(error);
        return EMPTY_ENVIRONMENT_LIST;
      }
      return data ?? EMPTY_ENVIRONMENT_LIST;
    },
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}

export function useCreateEnvironment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.CreateEnvironmentData["body"],
    ) => {
      const { data, error } = await archestraApiSdk.createEnvironment({ body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (environment) => {
      if (!environment) return;
      queryClient.invalidateQueries({ queryKey: environmentKeys.list() });
      queryClient.invalidateQueries({ queryKey: networkPolicyKeys.list() });
      toast.success(`${environment.name} added`);
    },
  });
}

export function useUpdateEnvironment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      id: string;
      body: archestraApiTypes.UpdateEnvironmentData["body"];
    }) => {
      const { data, error } = await archestraApiSdk.updateEnvironment({
        path: { id: params.id },
        body: params.body,
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (environment) => {
      if (!environment) return;
      queryClient.invalidateQueries({ queryKey: environmentKeys.list() });
      queryClient.invalidateQueries({ queryKey: networkPolicyKeys.list() });
      toast.success(`${environment.name} updated`);
    },
  });
}

export function useDeleteEnvironment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await archestraApiSdk.deleteEnvironment({
        path: { id },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: environmentKeys.list() });
      queryClient.invalidateQueries({ queryKey: networkPolicyKeys.list() });
      // Catalog items assigned to the deleted environment fall back to the
      // virtual Default target (FK set null), so refresh catalog views too.
      queryClient.invalidateQueries({ queryKey: ["mcp-catalog"] });
      queryClient.invalidateQueries({ queryKey: ["internal-mcp-catalog"] });
      toast.success("Environment deleted");
    },
  });
}
