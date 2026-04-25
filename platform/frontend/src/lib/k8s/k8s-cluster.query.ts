import { archestraApiSdk } from "@shared";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError } from "@/lib/utils";

const { createK8sCluster, updateK8sCluster, deleteK8sCluster, listK8sClusters, listK8sNamespaces } = archestraApiSdk;

export function useK8sClusters() {
  return useQuery({
    queryKey: ["k8s-clusters"],
    queryFn: async () => {
      const { data, error } = await listK8sClusters();
      if (error) {
        handleApiError(error);
        return { clusters: [] };
      }
      return data ?? { clusters: [] };
    },
  });
}

export function useCreateK8sCluster() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name: string; kubeconfig: string }) => {
      const { data, error } = await createK8sCluster({ body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
    onSuccess: (data) => {
      if (data) {
        toast.success("Kubernetes cluster added");
        queryClient.invalidateQueries({ queryKey: ["k8s-clusters"] });
      }
    },
    onError: () => {
      toast.error("Failed to add Kubernetes cluster");
    },
  });
}

export function useUpdateK8sCluster() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { id: string; body: { name?: string; kubeconfig?: string } }) => {
      const { data, error } = await updateK8sCluster({ path: { id: params.id }, body: params.body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
    onSuccess: (data) => {
      if (data) {
        toast.success("Kubernetes cluster updated");
        queryClient.invalidateQueries({ queryKey: ["k8s-clusters"] });
      }
    },
    onError: () => {
      toast.error("Failed to update Kubernetes cluster");
    },
  });
}

export function useDeleteK8sCluster() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await deleteK8sCluster({ path: { id } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
    onSuccess: (data) => {
      if (data) {
        toast.success("Kubernetes cluster removed");
        queryClient.invalidateQueries({ queryKey: ["k8s-clusters"] });
      }
    },
    onError: () => {
      toast.error("Failed to remove Kubernetes cluster");
    },
  });
}

export function useK8sNamespaces(clusterId?: string | null) {
  return useQuery({
    queryKey: ["k8s-namespaces", clusterId ?? null],
    queryFn: async () => {
      const { data, error } = await listK8sNamespaces({
        query: clusterId ? { clusterId } : undefined,
      });
      if (error) {
        handleApiError(error);
        return { namespaces: [] as string[], defaultNamespace: "default" };
      }
      return data ?? { namespaces: [] as string[], defaultNamespace: "default" };
    },
  });
}
