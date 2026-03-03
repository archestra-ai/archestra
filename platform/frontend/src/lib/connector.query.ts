import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError } from "./utils";

const {
  getConnectors,
  getConnector,
  createConnector,
  updateConnector,
  deleteConnector,
  syncConnector,
  testConnectorConnection,
  getConnectorRuns,
} = archestraApiSdk;

// ===== Query hooks =====

export function useConnectors(kgId: string) {
  return useQuery({
    queryKey: ["knowledge-bases", kgId, "connectors"],
    queryFn: async () => {
      const { data, error } = await getConnectors({ path: { kgId } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    enabled: !!kgId,
  });
}

export function useConnector(kgId: string, id: string) {
  return useQuery({
    queryKey: ["knowledge-bases", kgId, "connectors", id],
    queryFn: async () => {
      const { data, error } = await getConnector({ path: { kgId, id } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    enabled: !!kgId && !!id,
  });
}

export function useCreateConnector(kgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: archestraApiTypes.CreateConnectorData["body"]) => {
      const { data, error } = await createConnector({ path: { kgId }, body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({
        queryKey: ["knowledge-bases", kgId, "connectors"],
      });
      queryClient.invalidateQueries({ queryKey: ["knowledge-bases"] });
      toast.success("Connector created successfully");
    },
  });
}

export function useUpdateConnector(kgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      body,
    }: {
      id: string;
      body: archestraApiTypes.UpdateConnectorData["body"];
    }) => {
      const { data, error } = await updateConnector({
        path: { kgId, id },
        body,
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data, variables) => {
      if (!data) return;
      queryClient.invalidateQueries({
        queryKey: ["knowledge-bases", kgId, "connectors"],
      });
      queryClient.invalidateQueries({
        queryKey: ["knowledge-bases", kgId, "connectors", variables.id],
      });
      toast.success("Connector updated successfully");
    },
  });
}

export function useDeleteConnector(kgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await deleteConnector({ path: { kgId, id } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({
        queryKey: ["knowledge-bases", kgId, "connectors"],
      });
      queryClient.invalidateQueries({ queryKey: ["knowledge-bases"] });
      toast.success("Connector deleted successfully");
    },
  });
}

export function useSyncConnector(kgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (connectorId: string) => {
      const { data, error } = await syncConnector({
        path: { kgId, id: connectorId },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data, connectorId) => {
      if (!data) return;
      queryClient.invalidateQueries({
        queryKey: ["knowledge-bases", kgId, "connectors", connectorId],
      });
      queryClient.invalidateQueries({
        queryKey: ["knowledge-bases", kgId, "connectors", connectorId, "runs"],
      });
      toast.success("Sync started successfully");
    },
  });
}

export function useTestConnectorConnection(kgId: string) {
  return useMutation({
    mutationFn: async (connectorId: string) => {
      const { data, error } = await testConnectorConnection({
        path: { kgId, id: connectorId },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      if (data.success) {
        toast.success("Connection test successful");
      } else {
        toast.error(data.error || "Connection test failed");
      }
    },
  });
}

export function useConnectorRuns(params: {
  kgId: string;
  connectorId: string;
  limit?: number;
  offset?: number;
}) {
  const { kgId, connectorId, limit = 10, offset = 0 } = params;
  return useQuery({
    queryKey: [
      "knowledge-bases",
      kgId,
      "connectors",
      connectorId,
      "runs",
      { limit, offset },
    ],
    queryFn: async () => {
      const { data, error } = await getConnectorRuns({
        path: { kgId, id: connectorId },
        query: { limit, offset },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    enabled: !!kgId && !!connectorId,
  });
}
