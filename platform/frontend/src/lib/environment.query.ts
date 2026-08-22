import {
  archestraApiSdk,
  type archestraApiTypes,
  type EnvironmentDefaultableResource,
} from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { toBulkOutcome } from "@/lib/bulk-action";
import { resolveDefaultEnvironmentId } from "@/lib/resolve-default-environment";
import { handleApiError, throwOnApiError } from "@/lib/utils";

export const environmentKeys = {
  all: ["environments"] as const,
  list: () => [...environmentKeys.all, "list"] as const,
  k8sCapabilities: () => [...environmentKeys.all, "k8s-capabilities"] as const,
};

export type EnvironmentList =
  archestraApiTypes.ListEnvironmentsResponses["200"];
export type EnvironmentWithAssignedCount =
  EnvironmentList["environments"][number];
export type K8sCapabilities =
  archestraApiTypes.GetK8sCapabilitiesResponses["200"];

export type EnvironmentResourceDefaults = EnvironmentList["resourceDefaults"];

const EMPTY_RESOURCE_DEFAULTS: EnvironmentResourceDefaults = {
  mcpRegistry: null,
  app: null,
  agent: null,
  mcpGateway: null,
  llmProxy: null,
  knowledgeSource: null,
};

const EMPTY_ENVIRONMENT_LIST: EnvironmentList = {
  environments: [],
  defaultAssignedCatalogCount: 0,
  resourceDefaults: EMPTY_RESOURCE_DEFAULTS,
};

export function useEnvironments(enabled = true) {
  return useQuery({
    queryKey: environmentKeys.list(),
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.listEnvironments();
      throwOnApiError(error);
      return data ?? EMPTY_ENVIRONMENT_LIST;
    },
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}

export function useK8sCapabilities(enabled = true) {
  return useQuery({
    queryKey: environmentKeys.k8sCapabilities(),
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getK8sCapabilities();
      throwOnApiError(error);
      return data ?? null;
    },
    enabled,
    staleTime: 60 * 1000,
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
      toast.success(`${environment.name} updated`);
    },
  });
}

export function useUpdateEnvironmentResourceDefaults() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.UpdateEnvironmentResourceDefaultsData["body"],
    ) => {
      const { data, error } =
        await archestraApiSdk.updateEnvironmentResourceDefaults({ body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (defaults) => {
      if (!defaults) return;
      queryClient.invalidateQueries({ queryKey: environmentKeys.list() });
      toast.success("Default environment updated");
    },
  });
}

/**
 * The environment a new resource of this kind should start out in, mirroring
 * the backend's own resolution: the org's configured default for the kind,
 * falling back to null (the Default environment) when none is configured or
 * when the configured one is restricted and this user may not deploy there.
 * Without that fallback a create form would pre-select an environment its own
 * selector hides.
 *
 * `isResolved` tells a form when the answer is trustworthy, so it seeds its
 * field exactly once instead of overwriting an edit the user already made.
 */
export function useDefaultEnvironmentIdForResource(
  resource: EnvironmentDefaultableResource,
): { environmentId: string | null; isResolved: boolean } {
  const { data: environmentList, isSuccess: environmentsLoaded } =
    useEnvironments();
  const { data: hasDeployToRestricted, isSuccess: permissionLoaded } =
    useHasPermissions({ [resource]: ["deploy-to-restricted"] });

  if (!environmentsLoaded || !permissionLoaded) {
    return { environmentId: null, isResolved: false };
  }

  return {
    environmentId: resolveDefaultEnvironmentId({
      environments: environmentList?.environments ?? [],
      resourceDefaults:
        environmentList?.resourceDefaults ?? EMPTY_RESOURCE_DEFAULTS,
      resource,
      canDeployToRestricted: hasDeployToRestricted ?? false,
    }),
    isResolved: true,
  };
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
      // Catalog items assigned to the deleted environment fall back to the
      // virtual Default target (FK set null), so refresh catalog views too.
      queryClient.invalidateQueries({ queryKey: ["mcp-catalog"] });
      queryClient.invalidateQueries({ queryKey: ["internal-mcp-catalog"] });
      // Agents that were in the deleted environment fall back to the Default
      // environment by the same FK.
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      toast.success("Environment deleted");
    },
  });
}

/**
 * Deletes a selection of environments in one request, bypassing
 * `useDeleteEnvironment` so a batch reports once rather than per row. An
 * environment still holding catalog items comes back in `failed` with that
 * reason while the rest are deleted.
 */
export function useBulkDeleteEnvironments() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (environments: readonly { id: string; name: string }[]) =>
      archestraApiSdk
        .bulkDeleteEnvironments({
          body: { ids: environments.map((environment) => environment.id) },
        })
        .then(({ data, error }) => {
          throwOnApiError(error, { toastOnError: false });
          return toBulkOutcome(data ?? { succeeded: [], failed: [] });
        }),
    // Resources in a deleted environment fall back to Default by FK, so the
    // catalog and agent lists are stale too.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: environmentKeys.list() });
      queryClient.invalidateQueries({ queryKey: ["mcp-catalog"] });
      queryClient.invalidateQueries({ queryKey: ["internal-mcp-catalog"] });
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });
}
