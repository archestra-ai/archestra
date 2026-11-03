import { archestraApiSdk } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils/api";

const deviceMcpKeys = {
  all: ["device-mcp"] as const,
  catalog: (catalogId: string) => ["device-mcp", catalogId] as const,
};

export function useDeviceMcpConnections(catalogId: string, enabled: boolean) {
  return useQuery({
    queryKey: deviceMcpKeys.catalog(catalogId),
    enabled,
    refetchInterval: enabled ? 5000 : false,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.listDeviceMcpConnections({
        query: { catalogId },
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
  });
}

export function useDeviceMcpReview(catalogId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["device-mcp-review", catalogId],
    enabled,
    staleTime: 0,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getDeviceMcpReview({
        query: { catalogId },
      });
      throwOnApiError(error, { toastOnError: false });
      if (!data) throw new Error("No reviewed configuration received");
      return data;
    },
  });
}
export function useInstallManagedDeviceMcp() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      catalogId: string;
      localDeviceId: string;
      configDigest: string;
      replaceExisting: boolean;
    }) => {
      const { data, error } = await archestraApiSdk.installManagedDeviceMcp({
        body,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: ["device-mcp-review"] });
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: deviceMcpKeys.all });
      toast.success(
        "Installation approved. Your computer will start the MCP when connected.",
      );
    },
  });
}

export function useRevokeDeviceMcp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await archestraApiSdk.revokeDeviceMcp({
        path: { id },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: deviceMcpKeys.all });
      toast.success("Device connection revoked");
    },
  });
}
