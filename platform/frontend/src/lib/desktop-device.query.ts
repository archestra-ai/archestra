import {
  archestraApiSdk,
  type archestraApiTypes,
  type McpInstallationStatusMessage,
} from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "sonner";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils/api";
import websocketService from "@/lib/websocket/websocket";

const desktopDevicesQueryKey = ["desktop-devices"] as const;

export type DesktopDevice =
  archestraApiTypes.GetDesktopDevicesResponses["200"][number];

/**
 * The signed-in user's devices. A page that shows liveness reads them again
 * every 5 seconds. A page that only asks whether there is a computer passes
 * `live: false`: it reads them again only while it knows of none, to notice
 * the first one.
 */
export function useDesktopDevices(options?: {
  enabled?: boolean;
  live?: boolean;
}) {
  const live = options?.live ?? true;
  return useQuery({
    queryKey: desktopDevicesQueryKey,
    enabled: options?.enabled ?? true,
    refetchInterval: (query) =>
      live || !query.state.data?.length ? DESKTOP_DEVICES_POLL_MS : false,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getDesktopDevices();
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
  });
}

/**
 * The signed-in user's computer with the MCP bridge, for a page that says
 * where a desktop MCP server stands: whether there is one (undefined until
 * the devices are read) and its name. A desktop MCP server is only "on your
 * computer" while there is one. Read only when `enabled`, so a page with no
 * desktop MCP server asks nothing.
 */
export function useDesktopComputer(options: { enabled: boolean }): {
  hasComputer: boolean | undefined;
  name: string | null;
} {
  const { data } = useDesktopDevices({ ...options, live: false });
  return {
    hasComputer: data === undefined ? undefined : data.length > 0,
    name: data?.[0]?.name ?? null,
  };
}

/**
 * The status of one desktop MCP installation while the Add dialog follows
 * it: pushed over the websocket the moment it changes, and read every 2
 * seconds in case a push is missed. Stops reading once the tools are read.
 * Shows no toast: the dialog says it.
 */
export function useDesktopMcpInstallationStatus(serverId: string | null) {
  const queryClient = useQueryClient();
  const queryKey = desktopMcpInstallationStatusKey(serverId);
  const query = useQuery({
    queryKey,
    enabled: Boolean(serverId),
    refetchInterval: (q) =>
      q.state.data === "success" ? false : DESKTOP_MCP_STATUS_POLL_MS,
    queryFn: async () => {
      if (!serverId) return null;
      const { data, error } = await archestraApiSdk.getMcpServer({
        path: { id: serverId },
      });
      throwOnApiError(error, { toastOnError: false });
      return data?.localInstallationStatus ?? null;
    },
  });

  useEffect(() => {
    if (!serverId) return;
    websocketService.connect();
    return websocketService.subscribe(
      "mcp_installation_status",
      (message: McpInstallationStatusMessage) => {
        if (message.payload.serverId !== serverId) return;
        queryClient.setQueryData(
          desktopMcpInstallationStatusKey(serverId),
          message.payload.status,
        );
      },
    );
  }, [serverId, queryClient]);

  return query;
}

export function useDeleteDesktopDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await archestraApiSdk.deleteDesktopDevice({
        path: { id },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      toast.success("Device unlinked");
      return queryClient.invalidateQueries({
        queryKey: desktopDevicesQueryKey,
      });
    },
  });
}

/** A pending device sign-in, for the approval page. */
export function useDesktopDeviceSignIn(id: string) {
  return useQuery({
    queryKey: ["desktop-device-sign-in", id] as const,
    enabled: Boolean(id),
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getDesktopDeviceSignIn({
        path: { id },
      });
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
  });
}

export function useDecideDesktopDeviceSignIn(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.DecideDesktopDeviceSignInData["body"],
    ) => {
      const { data, error } = await archestraApiSdk.decideDesktopDeviceSignIn({
        path: { id },
        body,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: desktopDevicesQueryKey }),
  });
}

// ===

const DESKTOP_DEVICES_POLL_MS = 5_000;
const DESKTOP_MCP_STATUS_POLL_MS = 2_000;

function desktopMcpInstallationStatusKey(serverId: string | null) {
  return ["desktop-mcp-installation-status", serverId] as const;
}
