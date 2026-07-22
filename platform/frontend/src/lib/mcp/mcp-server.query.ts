import {
  archestraApiSdk,
  type archestraApiTypes,
  type McpDeploymentStatusEntry,
  type McpDeploymentStatusesMessage,
  type McpInstallationStatusMessage,
} from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { invalidateToolAssignmentQueries } from "@/lib/agent-tools.hook";
import { clipErrorMessage, trackEvent } from "@/lib/analytics";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import {
  getApiErrorMessage,
  handleApiError,
  throwOnApiError,
} from "@/lib/utils";
import websocketService from "@/lib/websocket/websocket";

const {
  deleteMcpServer,
  getMcpServers,
  getMcpServerTools,
  installMcpServer,
  getMcpServer,
  reauthenticateMcpServer,
  reinstallMcpServer,
  reloadMcpServerTools,
} = archestraApiSdk;

type McpServersQuery = Partial<
  NonNullable<archestraApiTypes.GetMcpServersData["query"]>
>;
type McpServersParams = McpServersQuery & {
  initialData?: archestraApiTypes.GetMcpServersResponses["200"];
  hasInstallingServers?: boolean;
  enabled?: boolean;
};

export function useMcpServers(params?: McpServersParams) {
  // The endpoint requires mcpServerInstallation:read; skip the request for
  // users whose role lacks it instead of letting it 403.
  const { data: canReadInstallations } = useHasPermissions({
    mcpServerInstallation: ["read"],
  });

  return useQuery({
    // Include catalogId in queryKey only when provided to maintain cache separation
    queryKey: [
      "mcp-servers",
      {
        catalogId: params?.catalogId,
        assignmentScope: params?.assignmentScope,
        assignmentTeamIds: params?.assignmentTeamIds,
      },
    ],
    queryFn: async () => {
      const { data, error } = await getMcpServers({
        query:
          params?.catalogId ||
          params?.assignmentScope ||
          params?.assignmentTeamIds
            ? {
                ...(params?.catalogId && { catalogId: params.catalogId }),
                ...(params?.assignmentScope && {
                  assignmentScope: params.assignmentScope,
                }),
                ...(params?.assignmentTeamIds && {
                  assignmentTeamIds: params.assignmentTeamIds,
                }),
              }
            : undefined,
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
    initialData: params?.initialData,
    enabled: (params?.enabled ?? true) && !!canReadInstallations,
    refetchInterval: params?.hasInstallingServers ? 2000 : false,
  });
}

export function useMcpInstallationStatusCacheSync(enabled = true) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return;

    websocketService.connect();
    const unsubscribe = websocketService.subscribe(
      "mcp_installation_status",
      (message: McpInstallationStatusMessage) => {
        const { serverId, status, error } = message.payload;

        // Several components mount this hook at once, and each gets this
        // callback for the same message — dedupe by server so one runtime
        // failure produces one event. A later non-error status re-arms the
        // server (a retried install can fail again and be captured again).
        if (status === "error") {
          if (!runtimeInstallErrorsAlreadyTracked.has(serverId)) {
            runtimeInstallErrorsAlreadyTracked.add(serverId);
            const server = queryClient
              .getQueriesData<archestraApiTypes.GetMcpServersResponses["200"]>({
                queryKey: ["mcp-servers"],
              })
              .flatMap(([, servers]) => servers ?? [])
              .find((candidate) => candidate.id === serverId);
            trackEvent("mcp_server_installation_failed", {
              serverId,
              serverName: server?.name,
              catalogId: server?.catalogId ?? undefined,
              stage: "runtime",
              errorMessage: clipErrorMessage(error),
            });
          }
        } else {
          runtimeInstallErrorsAlreadyTracked.delete(serverId);
        }

        queryClient.setQueriesData<
          archestraApiTypes.GetMcpServersResponses["200"]
        >({ queryKey: ["mcp-servers"] }, (servers) => {
          if (!servers) return servers;
          let didUpdate = false;
          const nextServers = servers.map((server) => {
            if (server.id !== serverId) return server;
            didUpdate = true;
            return {
              ...server,
              localInstallationStatus: status,
              localInstallationError: error,
            };
          });
          return didUpdate ? nextServers : servers;
        });

        if (status === "success" || status === "error") {
          // Refetch the full mcp-servers list: the install row may have
          // changes the surgical setQueriesData above doesn't cover. In
          // particular, the per-install reinstall route returns 200 with
          // status="pending" before the background task clears
          // `reinstall_required`; without this invalidation the button
          // stays visible until a manual refresh.
          void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
          void queryClient.invalidateQueries({ queryKey: ["mcp-catalog"] });
          void queryClient.invalidateQueries({
            queryKey: ["mcp-servers", serverId, "tools"],
          });
        }
      },
    );

    return unsubscribe;
  }, [enabled, queryClient]);
}

/**
 * Get MCP servers grouped by catalogId with current user's credentials first.
 * Used for credential/installation selection in tool configuration.
 *
 * @param catalogId - Optional catalog ID to filter. If provided, only returns servers for that catalog.
 */
export function useMcpServersGroupedByCatalog(params?: McpServersQuery) {
  const { data: servers } = useMcpServers({
    catalogId: params?.catalogId,
    assignmentScope: params?.assignmentScope,
    assignmentTeamIds: params?.assignmentTeamIds,
  });
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

  return useMemo(() => {
    if (!servers) return {};

    // Filter out servers without catalogId
    const withCatalog = servers.filter(
      (s): s is typeof s & { catalogId: string } => !!s.catalogId,
    );

    // Sort: current user's credentials first
    const sorted = [...withCatalog].sort((a, b) => {
      const aIsOwner = a.ownerId === currentUserId ? 1 : 0;
      const bIsOwner = b.ownerId === currentUserId ? 1 : 0;
      return bIsOwner - aIsOwner;
    });

    // Group by catalogId
    return sorted.reduce(
      (acc, server) => {
        const key = server.catalogId;
        if (!acc[key]) acc[key] = [];
        acc[key].push(server);
        return acc;
      },
      {} as Record<string, typeof servers>,
    );
  }, [servers, currentUserId]);
}

export function useInstallMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      data: archestraApiTypes.InstallMcpServerData["body"] & {
        dontShowToast?: boolean;
      },
    ) => {
      const { data: installedServer, error } = await installMcpServer({
        body: data,
      });
      if (error) {
        // `handleApiError` doesn't throw, so API rejections still flow
        // through onSuccess (with `installedServer` undefined) — capture the
        // failure here, at the only place the API error is visible.
        trackEvent("mcp_server_installation_failed", {
          serverName: data.name,
          catalogId: data.catalogId,
          stage: "request",
          errorMessage: clipErrorMessage(getApiErrorMessage(error)),
        });
        handleApiError(error);
      }
      return { installedServer, dontShowToast: data.dontShowToast };
    },
    onSuccess: async ({ installedServer, dontShowToast }, variables) => {
      if (installedServer) {
        trackEvent("mcp_server_installed", {
          serverId: installedServer.id,
          serverName: variables.name,
          catalogId: variables.catalogId,
          scope: variables.scope,
        });
      }
      // Show success toast for remote servers (local servers show toast after async tool fetch completes)
      if (!dontShowToast && installedServer) {
        toast.success(`Successfully installed ${variables.name}`);
      }
      // Refetch instead of just invalidating to ensure data is fresh
      await queryClient.refetchQueries({ queryKey: ["mcp-servers"] });
      // Invalidate tools queries since MCP server installation creates new tools
      queryClient.invalidateQueries({ queryKey: ["tools"] });
      queryClient.invalidateQueries({ queryKey: ["tools", "unassigned"] });
      queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
      // Invalidate the specific MCP server's tools query
      if (installedServer) {
        queryClient.invalidateQueries({
          queryKey: ["mcp-servers", installedServer.id, "tools"],
        });
      }
      // Invalidate catalog tools query so the manage-tools dialog shows discovered tools
      if (variables.catalogId) {
        queryClient.invalidateQueries({
          queryKey: ["mcp-catalog", variables.catalogId, "tools"],
        });
      }
      // Invalidate all chat MCP tools (new tools may be available)
      queryClient.invalidateQueries({ queryKey: ["chat", "agents"] });
    },
    onError: (error, variables) => {
      // Thrown (non-API) failures, e.g. the request never reached the backend.
      trackEvent("mcp_server_installation_failed", {
        serverName: variables.name,
        catalogId: variables.catalogId,
        stage: "request",
        errorMessage: clipErrorMessage(error.message),
      });
      toast.error(`Failed to install ${variables.name}`);
    },
  });
}

export function useDeleteMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { id: string; name: string }) => {
      const response = await deleteMcpServer({ path: { id: data.id } });
      return response.data;
    },
    onSuccess: async (_, variables) => {
      trackEvent("mcp_server_uninstalled", {
        serverId: variables.id,
        serverName: variables.name,
      });
      // Refetch instead of just invalidating to ensure data is fresh
      await queryClient.refetchQueries({ queryKey: ["mcp-servers"] });
      // Invalidate all tool assignment queries (tools, agent-tools, chat, etc.)
      invalidateToolAssignmentQueries(queryClient);
      toast.success(`Successfully uninstalled ${variables.name}`);
    },
    onError: (error, variables) => {
      console.error("Uninstall error:", error);
      toast.error(`Failed to uninstall ${variables.name}`);
    },
  });
}

/**
 * Re-discover a server's tools from the live server and persist them to the
 * tool catalog (add/update/remove) — no reinstall, no pod restart. Refreshes
 * every query that renders tool lists or counts, since the shared catalog
 * rows may have changed for all installs of the same server.
 */
export function useReloadMcpServerTools() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      id: string;
      name?: string;
      catalogId?: string | null;
    }) => {
      const { data: result, error } = await reloadMcpServerTools({
        path: { id: data.id },
      });
      if (error) {
        handleApiError(error);
        throw new Error(getApiErrorMessage(error));
      }
      return result;
    },
    onSuccess: async (result, variables) => {
      // Callers pass only the server id; recover name/catalogId from the
      // cached mcp-servers lists (same lookup useMcpInstallationStatusCacheSync
      // uses) for the toast and catalog-scoped invalidation.
      const cachedServer = queryClient
        .getQueriesData<archestraApiTypes.GetMcpServersResponses["200"]>({
          queryKey: ["mcp-servers"],
        })
        .flatMap(([, servers]) => (Array.isArray(servers) ? servers : []))
        .find((candidate) => candidate.id === variables.id);
      const name = variables.name ?? cachedServer?.name;
      const catalogId = variables.catalogId ?? cachedServer?.catalogId;

      await queryClient.refetchQueries({ queryKey: ["mcp-servers"] });
      invalidateToolAssignmentQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: ["mcp-servers", variables.id, "tools"],
      });
      if (catalogId) {
        queryClient.invalidateQueries({
          queryKey: ["mcp-catalog", catalogId, "tools"],
        });
      }
      const target = name ?? "server";
      const changed =
        (result?.created ?? 0) +
        (result?.updated ?? 0) +
        (result?.deleted ?? 0);
      toast.success(
        changed > 0 && result
          ? `Refreshed ${target} tools: ${result.created} added, ${result.updated} updated, ${result.deleted} removed`
          : `${name ?? "Server"} tools are already up to date`,
      );
    },
    onError: (_error, variables) => {
      toast.error(`Failed to refresh ${variables.name ?? "server"} tools`);
    },
  });
}

export function useMcpServerTools(mcpServerId: string | null) {
  return useQuery({
    queryKey: ["mcp-servers", mcpServerId, "tools"],
    queryFn: async () => {
      if (!mcpServerId) return [];
      const { data, error } = await getMcpServerTools({
        path: { id: mcpServerId },
      });
      // A not-yet-connected server 404s here; treat that as an empty tool list
      // (no error state, no toast) rather than a failure.
      throwOnApiError(error, { allowNotFound: true, toastOnError: false });
      return data ?? [];
    },
    enabled: !!mcpServerId,
  });
}

export function useMcpServerInstallationStatus(
  installingMcpServerId: string | null,
) {
  const queryClient = useQueryClient();
  const queryKey = ["mcp-servers-installation-polling", installingMcpServerId];
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      if (!installingMcpServerId) {
        await queryClient.refetchQueries({ queryKey: ["mcp-servers"] });
        return "success";
      }
      const response = await getMcpServer({
        path: { id: installingMcpServerId },
      });
      const result = response.data?.localInstallationStatus ?? null;
      if (result === "success") {
        await queryClient.refetchQueries({
          queryKey: ["mcp-servers", installingMcpServerId],
        });
        toast.success(`Successfully installed server`);
      }
      if (result === "error") {
        await queryClient.refetchQueries({ queryKey: ["mcp-servers"] });
        toast.error("Failed to install server");
      }
      return result;
    },
    throwOnError: false,
    // 2s poll is a safety net; the WebSocket subscription below pushes
    // updates the moment the backend writes to the DB.
    refetchInterval: (q) => {
      const status = q.state.data;
      return (
        !q.state.error &&
        (status === "pending" ||
        status === "discovering-tools" ||
        status === null
          ? 2000
          : false)
      );
    },
    enabled: !!installingMcpServerId,
  });

  // Eagerly seed the cache from WS pushes so the UI updates without waiting
  // for the next 2s poll tick — and so it still updates after the poll has
  // been disabled (status went success/error and React Query stops polling).
  useEffect(() => {
    if (!installingMcpServerId) return;
    const cacheKey = [
      "mcp-servers-installation-polling",
      installingMcpServerId,
    ];
    websocketService.connect();
    const unsubscribe = websocketService.subscribe(
      "mcp_installation_status",
      (message: McpInstallationStatusMessage) => {
        if (message.payload.serverId !== installingMcpServerId) return;
        const status = message.payload.status;
        const previous = queryClient.getQueryData<typeof status>(cacheKey);
        queryClient.setQueryData(cacheKey, status);
        // Only toast on a genuine transition into a terminal state, so we
        // don't double-toast when the 2s poll happens to land first.
        if (status === "success" && previous !== "success") {
          void queryClient.refetchQueries({
            queryKey: ["mcp-servers", installingMcpServerId],
          });
          toast.success("Successfully installed server");
        } else if (status === "error" && previous !== "error") {
          void queryClient.refetchQueries({ queryKey: ["mcp-servers"] });
          toast.error("Failed to install server");
        }
      },
    );
    return unsubscribe;
  }, [installingMcpServerId, queryClient]);

  return query;
}

export function useReauthenticateMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      data: { id: string; name: string } & NonNullable<
        archestraApiTypes.ReauthenticateMcpServerData["body"]
      >,
    ) => {
      const { id, name, ...body } = data;
      const response = await reauthenticateMcpServer({
        path: { id },
        body,
      });
      if (response.error) {
        handleApiError(response.error);
        return null;
      }
      return response.data;
    },
    onSuccess: async (updatedServer, variables) => {
      if (!updatedServer) {
        return;
      }
      await queryClient.refetchQueries({ queryKey: ["mcp-servers"] });
      invalidateToolAssignmentQueries(queryClient);
      toast.success(`Successfully re-authenticated ${variables.name}`);
    },
    onError: (_error, variables) => {
      toast.error(`Failed to re-authenticate ${variables.name}`);
    },
  });
}

/**
 * Reinstall an MCP server without losing tool assignments and policies.
 * This is used when a catalog item is edited and requires manual reinstall
 * (e.g., when new prompted env vars were added).
 */
export function useReinstallMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      data: { id: string; name: string } & NonNullable<
        archestraApiTypes.ReinstallMcpServerData["body"]
      >,
    ) => {
      const { id, name, ...body } = data;
      const response = await reinstallMcpServer({
        path: { id },
        body,
      });
      if (response.error) {
        trackEvent("mcp_server_installation_failed", {
          serverId: id,
          serverName: name,
          stage: "request",
          errorMessage: clipErrorMessage(getApiErrorMessage(response.error)),
        });
        handleApiError(response.error);
        return null;
      }
      return { data: response.data, name };
    },
    onSuccess: async (_result, variables) => {
      // Refetch servers to get updated status (will show "pending" initially)
      await queryClient.refetchQueries({ queryKey: ["mcp-servers"] });
      // Invalidate tools queries since tools may have been synced
      queryClient.invalidateQueries({ queryKey: ["tools"] });
      queryClient.invalidateQueries({ queryKey: ["tools", "unassigned"] });
      queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
      // Invalidate catalog tools query
      if (variables.id) {
        queryClient.invalidateQueries({
          queryKey: ["mcp-servers", variables.id, "tools"],
        });
      }
      // Note: No success toast here - the progress bar provides feedback
      // Success toast is shown when polling detects status changed to "success"
    },
  });
}

/**
 * Subscribe to real-time MCP deployment statuses via WebSocket.
 * Returns a record mapping server IDs to their deployment status entries.
 * Only subscribes when the K8s runtime feature flag is enabled.
 */
export function useMcpDeploymentStatuses(): Record<
  string,
  McpDeploymentStatusEntry
> {
  const [statuses, setStatuses] = useState<
    Record<string, McpDeploymentStatusEntry>
  >({});
  const isK8sEnabled = useFeature("orchestratorK8sRuntime");

  useEffect(() => {
    if (!isK8sEnabled) return;

    websocketService.connect();
    websocketService.send({
      type: "subscribe_mcp_deployment_statuses",
      payload: {},
    });

    const unsubscribe = websocketService.subscribe(
      "mcp_deployment_statuses",
      (message: McpDeploymentStatusesMessage) => {
        setStatuses(message.payload.statuses);
      },
    );

    return () => {
      websocketService.send({
        type: "unsubscribe_mcp_deployment_statuses",
        payload: {},
      });
      unsubscribe();
    };
  }, [isK8sEnabled]);

  return statuses;
}

// Server ids whose async ("runtime") install failure was already sent to
// analytics. Module-level so the capture happens once regardless of how many
// components have `useMcpInstallationStatusCacheSync` mounted.
const runtimeInstallErrorsAlreadyTracked = new Set<string>();
