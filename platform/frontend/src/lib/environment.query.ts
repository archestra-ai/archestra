import {
  archestraApiSdk,
  type archestraApiTypes,
  type EnvironmentDefaultableResource,
} from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { toBulkOutcome } from "@/lib/bulk-action";
import {
  type EnvironmentDeleteBlock,
  environmentDeleteBlock,
} from "@/lib/environment-cluster";
import { resolveDefaultEnvironmentId } from "@/lib/resolve-default-environment";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils/api";

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
  knowledgeSource: null,
};

const EMPTY_ENVIRONMENT_LIST: EnvironmentList = {
  environments: [],
  defaultAssignedCatalogCount: 0,
  resourceDefaults: EMPTY_RESOURCE_DEFAULTS,
};

export function useEnvironments(enabled = true) {
  const { data: canReadEnvironments } = useHasPermissions({
    environment: ["read"],
  });
  return useQuery({
    queryKey: environmentKeys.list(),
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.listEnvironments();
      throwOnApiError(error);
      return data ?? EMPTY_ENVIRONMENT_LIST;
    },
    enabled: enabled && !!canReadEnvironments,
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

  // The listing already answers "may I deploy here?" per environment, so there
  // is no separate permission round trip to wait for.
  if (!environmentsLoaded) {
    return { environmentId: null, isResolved: false };
  }

  return {
    environmentId: resolveDefaultEnvironmentId({
      environments: environmentList?.environments ?? [],
      resourceDefaults:
        environmentList?.resourceDefaults ?? EMPTY_RESOURCE_DEFAULTS,
      resource,
    }),
    isResolved: true,
  };
}

/**
 * Deletes an environment. For an environment with a Kubernetes cluster of its
 * own, the platform first removes its workloads from that cluster; a delete it
 * refuses for a reason the person can act on resolves to that reason, for the
 * dialog to show, instead of a toast. `skipClusterCleanup` deletes the
 * environment and leaves its workloads in the cluster.
 */
export function useDeleteEnvironment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      id: string;
      skipClusterCleanup?: boolean;
    }): Promise<{ block: EnvironmentDeleteBlock | null }> => {
      const { error } = await archestraApiSdk.deleteEnvironment({
        path: { id: params.id },
        query: params.skipClusterCleanup
          ? { skipClusterCleanup: "true" }
          : undefined,
      });
      if (!error) return { block: null };
      const block = environmentDeleteBlock(error);
      if (block) return { block };
      handleApiError(error);
      throw toApiError(error);
    },
    onSuccess: ({ block }) => {
      // A refused delete may still have marked the environment as being
      // deleted, which the list shows.
      queryClient.invalidateQueries({ queryKey: environmentKeys.list() });
      if (block) return;
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
 * Reports what a Kubernetes cluster lets the platform do, per feature: the
 * cluster of a pasted kubeconfig, or, with `environmentId`, the cluster that
 * environment already deploys into (with `kubeconfig`, a replacement
 * credential for it). Nothing is stored or deployed.
 */
export function useTestEnvironmentCluster() {
  return useMutation({
    mutationFn: async (params: {
      environmentId?: string;
      kubeconfig?: string;
      namespace: string;
      agentRuntimePlatformBaseUrl: string | null;
    }) => {
      const { environmentId, kubeconfig, ...rest } = params;
      const { data, error } = environmentId
        ? await archestraApiSdk.testEnvironmentCluster({
            path: { id: environmentId },
            body: { ...rest, ...(kubeconfig ? { kubeconfig } : {}) },
          })
        : await archestraApiSdk.testEnvironmentKubeconfig({
            body: { ...rest, kubeconfig: kubeconfig ?? "" },
          });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
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
