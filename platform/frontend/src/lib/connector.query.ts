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
  getConnectorRun,
  assignConnectorToKnowledgeBases,
  unassignConnectorFromKnowledgeBase,
  getConnectorKnowledgeBases,
} = archestraApiSdk;

type ConnectorsQuery = NonNullable<
  archestraApiTypes.GetConnectorsData["query"]
>;
type ConnectorsListParams = Pick<
  ConnectorsQuery,
  "knowledgeBaseId" | "limit" | "offset"
> & {
  enabled?: boolean;
};
type ConnectorsPaginatedParams = Pick<
  ConnectorsQuery,
  "limit" | "offset" | "search" | "connectorType"
>;

// ===== Query hooks =====

export function useConnectors(params?: string | Partial<ConnectorsListParams>) {
  const knowledgeBaseId =
    typeof params === "string" ? params : params?.knowledgeBaseId;
  const enabled = typeof params === "object" ? params?.enabled : undefined;
  const limit = typeof params === "object" ? params?.limit : undefined;
  const offset = typeof params === "object" ? params?.offset : undefined;
  return useQuery({
    queryKey: knowledgeBaseId
      ? ["connectors", { knowledgeBaseId, limit, offset }]
      : ["connectors", { limit, offset }],
    queryFn: async () => {
      const { data, error } = await getConnectors({
        query: {
          knowledgeBaseId,
          limit: limit ?? 100,
          offset: offset ?? 0,
        },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data?.data ?? [];
    },
    enabled,
    refetchInterval: (query) => {
      const hasRunning = query.state.data?.some(
        (c) => c.lastSyncStatus === "running",
      );
      return hasRunning ? 3000 : false;
    },
  });
}

export function useConnectorsPaginated(params: ConnectorsPaginatedParams) {
  return useQuery({
    queryKey: ["connectors", "paginated", params],
    placeholderData: (previousData) => previousData,
    queryFn: async () => {
      const { data, error } = await getConnectors({ query: params });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
  });
}

export function useConnector(id: string) {
  return useQuery({
    queryKey: ["connectors", id],
    queryFn: async () => {
      const { data, error } = await getConnector({ path: { id } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    enabled: !!id,
    refetchInterval: (query) => {
      return query.state.data?.lastSyncStatus === "running" ? 3000 : false;
    },
  });
}

export function useConnectorKnowledgeBases(connectorId: string) {
  return useQuery({
    queryKey: ["connectors", connectorId, "knowledge-bases"],
    queryFn: async () => {
      const { data, error } = await getConnectorKnowledgeBases({
        path: { id: connectorId },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    enabled: !!connectorId,
  });
}

export function useCreateConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: archestraApiTypes.CreateConnectorData["body"]) => {
      const { data, error } = await createConnector({ body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["connectors"] });
      queryClient.invalidateQueries({ queryKey: ["knowledge-bases"] });
      toast.success("Connector created successfully");
    },
  });
}

export function useUpdateConnector() {
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
        path: { id },
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
      queryClient.invalidateQueries({ queryKey: ["connectors"] });
      queryClient.invalidateQueries({
        queryKey: ["connectors", variables.id],
      });
      toast.success("Connector updated successfully");
    },
  });
}

export function useDeleteConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await deleteConnector({ path: { id } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["connectors"] });
      queryClient.invalidateQueries({ queryKey: ["knowledge-bases"] });
      toast.success("Connector deleted successfully");
    },
  });
}

export function useSyncConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (connectorId: string) => {
      const { data, error } = await syncConnector({
        path: { id: connectorId },
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
        queryKey: ["connectors", connectorId],
      });
      queryClient.invalidateQueries({
        queryKey: ["connectors", connectorId, "runs"],
      });
      toast.success("Sync started successfully");
    },
  });
}

export function useTestConnectorConnection() {
  return useMutation({
    mutationFn: async (connectorId: string) => {
      const { data, error } = await testConnectorConnection({
        path: { id: connectorId },
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
  connectorId: string;
  limit?: number;
  offset?: number;
}) {
  const { connectorId, limit = 10, offset = 0 } = params;
  return useQuery({
    queryKey: ["connectors", connectorId, "runs", { limit, offset }],
    queryFn: async () => {
      const { data, error } = await getConnectorRuns({
        path: { id: connectorId },
        query: { limit, offset },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    enabled: !!connectorId,
    refetchInterval: (query) => {
      const hasRunning = query.state.data?.data?.some(
        (r) => r.status === "running",
      );
      return hasRunning ? 3000 : false;
    },
  });
}

export function useConnectorRun(params: {
  connectorId: string;
  runId: string | null;
}) {
  const { connectorId, runId } = params;
  return useQuery({
    queryKey: ["connectors", connectorId, "runs", runId],
    queryFn: async () => {
      if (!runId) return null;
      const { data, error } = await getConnectorRun({
        path: { id: connectorId, runId },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    enabled: !!connectorId && !!runId,
    refetchInterval: (query) => {
      return query.state.data?.status === "running" ? 2000 : false;
    },
  });
}

export function useAssignConnectorToKnowledgeBases() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      connectorId,
      knowledgeBaseIds,
    }: { connectorId: string } & NonNullable<
      archestraApiTypes.AssignConnectorToKnowledgeBasesData["body"]
    >) => {
      const { data, error } = await assignConnectorToKnowledgeBases({
        path: { id: connectorId },
        body: { knowledgeBaseIds },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["connectors"] });
      queryClient.invalidateQueries({ queryKey: ["knowledge-bases"] });
      toast.success("Connector assigned successfully");
    },
  });
}

export function useUnassignConnectorFromKnowledgeBase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      connectorId,
      knowledgeBaseId,
    }: {
      connectorId: string;
      knowledgeBaseId: string;
    }) => {
      const { data, error } = await unassignConnectorFromKnowledgeBase({
        path: { id: connectorId, kbId: knowledgeBaseId },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["connectors"] });
      queryClient.invalidateQueries({ queryKey: ["knowledge-bases"] });
      toast.success("Connector unassigned successfully");
    },
  });
}
