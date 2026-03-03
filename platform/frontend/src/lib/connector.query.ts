import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError } from "./utils";

const API_BASE = "/api/knowledge-graphs";

// ===== Types (will be replaced with generated SDK types later) =====

export interface ConnectorResponse {
  id: string;
  organizationId: string;
  knowledgeGraphId: string;
  name: string;
  connectorType: string;
  config: Record<string, unknown>;
  secretId: string | null;
  schedule: string;
  enabled: boolean;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateConnectorBody {
  name: string;
  connectorType: string;
  config: Record<string, unknown>;
  credentials?: {
    email: string;
    apiToken: string;
  };
  schedule: string;
  enabled?: boolean;
}

export interface UpdateConnectorBody {
  name?: string;
  config?: Record<string, unknown>;
  credentials?: {
    email: string;
    apiToken: string;
  };
  schedule?: string;
  enabled?: boolean;
}

export interface ConnectorRunResponse {
  id: string;
  connectorId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  documentsProcessed: number | null;
  documentsIngested: number | null;
  error: string | null;
  createdAt: string;
}

export interface PaginatedConnectorRuns {
  data: ConnectorRunResponse[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
  };
}

export interface TestConnectionResponse {
  success: boolean;
  message?: string;
}

// ===== Query hooks =====

export function useConnectors(kgId: string) {
  return useQuery({
    queryKey: ["knowledge-graphs", kgId, "connectors"],
    queryFn: async () => {
      const response = await fetch(`${API_BASE}/${kgId}/connectors`);
      if (!response.ok) {
        const error = await response.json();
        handleApiError(error);
        return [];
      }
      return (await response.json()) as ConnectorResponse[];
    },
    enabled: !!kgId,
  });
}

export function useConnector(kgId: string, id: string) {
  return useQuery({
    queryKey: ["knowledge-graphs", kgId, "connectors", id],
    queryFn: async () => {
      const response = await fetch(`${API_BASE}/${kgId}/connectors/${id}`);
      if (!response.ok) {
        const error = await response.json();
        handleApiError(error);
        return null;
      }
      return (await response.json()) as ConnectorResponse;
    },
    enabled: !!kgId && !!id,
  });
}

export function useCreateConnector(kgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateConnectorBody) => {
      const response = await fetch(`${API_BASE}/${kgId}/connectors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!response.ok) {
        const error = await response.json();
        handleApiError(error);
        return null;
      }
      return (await response.json()) as ConnectorResponse;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({
        queryKey: ["knowledge-graphs", kgId, "connectors"],
      });
      queryClient.invalidateQueries({ queryKey: ["knowledge-graphs"] });
      toast.success("Connector created successfully");
    },
  });
}

export function useUpdateConnector(kgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      data: UpdateConnectorBody;
    }) => {
      const response = await fetch(`${API_BASE}/${kgId}/connectors/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!response.ok) {
        const error = await response.json();
        handleApiError(error);
        return null;
      }
      return (await response.json()) as ConnectorResponse;
    },
    onSuccess: (data, variables) => {
      if (!data) return;
      queryClient.invalidateQueries({
        queryKey: ["knowledge-graphs", kgId, "connectors"],
      });
      queryClient.invalidateQueries({
        queryKey: ["knowledge-graphs", kgId, "connectors", variables.id],
      });
      toast.success("Connector updated successfully");
    },
  });
}

export function useDeleteConnector(kgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch(`${API_BASE}/${kgId}/connectors/${id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const error = await response.json();
        handleApiError(error);
        return null;
      }
      return true;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({
        queryKey: ["knowledge-graphs", kgId, "connectors"],
      });
      queryClient.invalidateQueries({ queryKey: ["knowledge-graphs"] });
      toast.success("Connector deleted successfully");
    },
  });
}

export function useSyncConnector(kgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (connectorId: string) => {
      const response = await fetch(
        `${API_BASE}/${kgId}/connectors/${connectorId}/sync`,
        { method: "POST" },
      );
      if (!response.ok) {
        const error = await response.json();
        handleApiError(error);
        return null;
      }
      return (await response.json()) as ConnectorRunResponse;
    },
    onSuccess: (data, connectorId) => {
      if (!data) return;
      queryClient.invalidateQueries({
        queryKey: ["knowledge-graphs", kgId, "connectors", connectorId],
      });
      queryClient.invalidateQueries({
        queryKey: ["knowledge-graphs", kgId, "connectors", connectorId, "runs"],
      });
      toast.success("Sync started successfully");
    },
  });
}

export function useTestConnectorConnection(kgId: string) {
  return useMutation({
    mutationFn: async (connectorId: string) => {
      const response = await fetch(
        `${API_BASE}/${kgId}/connectors/${connectorId}/test`,
        { method: "POST" },
      );
      if (!response.ok) {
        const error = await response.json();
        handleApiError(error);
        return null;
      }
      return (await response.json()) as TestConnectionResponse;
    },
    onSuccess: (data) => {
      if (!data) return;
      if (data.success) {
        toast.success("Connection test successful");
      } else {
        toast.error(data.message || "Connection test failed");
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
      "knowledge-graphs",
      kgId,
      "connectors",
      connectorId,
      "runs",
      { limit, offset },
    ],
    queryFn: async () => {
      const searchParams = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
      });
      const response = await fetch(
        `${API_BASE}/${kgId}/connectors/${connectorId}/runs?${searchParams}`,
      );
      if (!response.ok) {
        const error = await response.json();
        handleApiError(error);
        return { data: [], pagination: { total: 0, limit, offset } };
      }
      return (await response.json()) as PaginatedConnectorRuns;
    },
    enabled: !!kgId && !!connectorId,
  });
}
