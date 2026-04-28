import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, toApiError } from "@/lib/utils";

export type Cluster = archestraApiTypes.GetClustersResponses["200"][number];
export type CreateClusterInput = archestraApiTypes.CreateClusterData["body"];
export type UpdateClusterInput = archestraApiTypes.UpdateClusterData["body"];
export type TestClusterResult = archestraApiTypes.TestClusterResponses["200"];

const CLUSTERS_QUERY_KEY = ["clusters"] as const;

export function useClusters() {
  return useQuery({
    queryKey: CLUSTERS_QUERY_KEY,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getClusters();
      if (error) {
        handleApiError(error);
        return [] as Cluster[];
      }
      return (data ?? []) as Cluster[];
    },
  });
}

export function useCluster(id: string | undefined) {
  return useQuery({
    queryKey: ["clusters", id],
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getCluster({
        path: { id: id as string },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return (data ?? null) as Cluster | null;
    },
    enabled: !!id,
  });
}

export function useCreateCluster() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (body: CreateClusterInput) => {
      const { data, error } = await archestraApiSdk.createCluster({ body });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data as Cluster;
    },
    onSuccess: () => {
      toast.success("Cluster created");
      queryClient.invalidateQueries({ queryKey: CLUSTERS_QUERY_KEY });
    },
  });
}

export function useUpdateCluster() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      body,
    }: {
      id: string;
      body: UpdateClusterInput;
    }) => {
      const { data, error } = await archestraApiSdk.updateCluster({
        path: { id },
        body,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data as Cluster;
    },
    onSuccess: () => {
      toast.success("Cluster updated");
      queryClient.invalidateQueries({ queryKey: CLUSTERS_QUERY_KEY });
    },
  });
}

export function useDeleteCluster() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await archestraApiSdk.deleteCluster({
        path: { id },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      toast.success("Cluster deleted");
      queryClient.invalidateQueries({ queryKey: CLUSTERS_QUERY_KEY });
    },
  });
}

export function useTestCluster() {
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await archestraApiSdk.testCluster({
        path: { id },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data as TestClusterResult;
    },
    onSuccess: (data) => {
      if (data?.ok) {
        const visible = data.namespacesVisible;
        toast.success(
          visible !== undefined
            ? `Cluster reachable (${visible} namespaces visible)`
            : "Cluster reachable",
        );
      } else {
        toast.error(data?.error ?? "Cluster connection check failed");
      }
    },
  });
}
