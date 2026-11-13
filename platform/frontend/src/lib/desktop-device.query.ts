import {
  archestraApiSdk,
  type archestraApiTypes,
  type McpInstallationStatusMessage,
} from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "sonner";
import {
  type DesktopArgumentsProgramNotice,
  desktopArgumentsSaveIsFollowed,
} from "@/lib/mcp/desktop-mcp";
import { mcpRegistryQueryKey } from "@/lib/mcp/mcp-registry.query";
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
  /** "checking" during the first read; undefined when it could not be read. */
  hasComputer: boolean | "checking" | undefined;
  name: string | null;
} {
  const { data, isLoading } = useDesktopDevices({ ...options, live: false });
  return {
    hasComputer:
      data !== undefined ? data.length > 0 : isLoading ? "checking" : undefined,
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

/**
 * Stores the arguments the signed-in user adds to the command of a desktop
 * MCP server, for their own installation. The MCP bridge on their device
 * then starts the server again with them, and the installation waits until
 * its tools are read again. The Connect dialog then follows the
 * installation and says how it went, so there is no success toast. A device
 * whose program is from before the arguments starts nothing again (`notice`
 * is what the dialog said of it): there is nothing to follow, and a toast
 * says that the arguments are saved. See `desktopArgumentsSaveIsFollowed`.
 */
export function useUpdateDesktopMcpArguments() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      id: string;
      desktopArguments: string[];
      notice: DesktopArgumentsProgramNotice | null;
    }) => {
      const { data, error } =
        await archestraApiSdk.updateMcpServerDesktopArguments({
          path: { id: params.id },
          body: { desktopArguments: params.desktopArguments },
        });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: async (server, params) => {
      const installStatus = server?.localInstallationStatus ?? null;
      if (
        !desktopArgumentsSaveIsFollowed({
          notice: params.notice,
          installStatus,
        })
      ) {
        toast.success("Arguments saved");
      }
      // What the dialog that follows the installation reads first: without
      // these it would show the status and the state of the MCP server from
      // before the change, and its steps would go back.
      queryClient.setQueryData(
        desktopMcpInstallationStatusKey(params.id),
        installStatus,
      );
      void queryClient.invalidateQueries({ queryKey: mcpRegistryQueryKey });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: desktopDevicesQueryKey }),
        queryClient.refetchQueries({ queryKey: ["mcp-servers"] }),
      ]);
    },
  });
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

/**
 * A setup code for the MCP bridge setup dialog while it is open. A new one
 * comes before it expires; a dialog opened again gets a new one.
 */
export function useDesktopDeviceSetupCode(options: { enabled: boolean }) {
  return useQuery({
    queryKey: ["desktop-device-setup-code"] as const,
    enabled: options.enabled,
    staleTime: SETUP_CODE_REFRESH_MS,
    refetchInterval: SETUP_CODE_REFRESH_MS,
    refetchOnWindowFocus: false,
    gcTime: 0,
    queryFn: async () => {
      const { data, error } =
        await archestraApiSdk.createDesktopDeviceSetupCode();
      throwOnApiError(error, { toastOnError: false });
      return data?.setupCode ?? null;
    },
  });
}

/**
 * The sign-in that the command of the setup dialog started, read every 2
 * seconds while the dialog waits for it; null while there is none.
 */
export function useDesktopDeviceSetupSignIn(params: {
  setupCode: string | null | undefined;
  enabled: boolean;
}) {
  const { setupCode, enabled } = params;
  return useQuery({
    queryKey: ["desktop-device-setup-sign-in", setupCode] as const,
    enabled: enabled && Boolean(setupCode),
    refetchInterval: DESKTOP_MCP_STATUS_POLL_MS,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getDesktopDeviceSetupSignIn(
        {
          path: { setupCode: setupCode ?? "" },
        },
      );
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
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
/** Half the life of a setup code on the server (30 minutes). */
const SETUP_CODE_REFRESH_MS = 15 * 60_000;
const DESKTOP_MCP_STATUS_POLL_MS = 2_000;

function desktopMcpInstallationStatusKey(serverId: string | null) {
  return ["desktop-mcp-installation-status", serverId] as const;
}
