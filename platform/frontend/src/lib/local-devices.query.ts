import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils/api";

export type LocalDevice =
  archestraApiTypes.ListLocalDevicesResponses["200"][number];

export const localDeviceKeys = {
  all: ["local-devices"] as const,
  list: () => ["local-devices", "list"] as const,
};

/**
 * The viewer's own devices. Polls while the page is open so presence (and a
 * just-enrolled device turning online) shows without a reload.
 */
export function useLocalDevices(params: { enabled: boolean; pollMs?: number }) {
  return useQuery({
    queryKey: localDeviceKeys.list(),
    enabled: params.enabled,
    refetchInterval: params.enabled ? (params.pollMs ?? 10_000) : false,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.listLocalDevices();
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
  });
}

export function useRenameLocalDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      const { data, error } = await archestraApiSdk.renameLocalDevice({
        path: { id },
        body: { name },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: localDeviceKeys.list() });
      toast.success("Device renamed");
    },
  });
}

export function useRevokeLocalDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await archestraApiSdk.revokeLocalDevice({
        path: { id },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: localDeviceKeys.list() });
      toast.success("Device access revoked");
    },
  });
}
