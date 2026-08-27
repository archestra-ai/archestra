import {
  archestraApiSdk,
  type archestraApiTypes,
  type McpDeploymentStatusEntry,
  type McpDeploymentStatusesMessage,
  type McpInstallationStatusMessage,
  type McpServersChangedMessage,
} from "@archestra/shared";
import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { toast } from "sonner";
import { invalidateToolAssignmentQueries } from "@/lib/agent-tools.hook";
import { clipErrorMessage, trackEvent } from "@/lib/analytics";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { toBulkOutcome } from "@/lib/bulk-action";
import { useFeature } from "@/lib/config/config.query";
import {
  externalMcpSkillDetailQueryKey,
  externalMcpSkillsQueryKey,
} from "@/lib/skills/skill.query";
import {
  getApiErrorMessage,
  handleApiError,
  throwOnApiError,
} from "@/lib/utils";
import websocketService from "@/lib/websocket/websocket";

const {
  bulkDeleteMcpServers,
  deleteMcpServer,
  getMcpServers,
  getMcpServerTools,
  installMcpServer,
  getMcpServer,
  muteMcpCatalogAlert,
  muteMcpServerAlert,
  reauthenticateMcpServer,
  reinstallMcpServer,
  reloadMcpServerTools,
  unmuteMcpCatalogAlert,
  unmuteMcpServerAlert,
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

/**
 * The organization's auto-mode agents (implicit access to all tools). The set
 * is org-wide — identical for every MCP server — so it is fetched once here
 * rather than embedded on every row of the servers list.
 */
export function useAutoModeAgents(params?: { enabled?: boolean }) {
  const { data: canReadInstallations } = useHasPermissions({
    mcpServerInstallation: ["read"],
  });

  return useQuery({
    queryKey: ["mcp-servers", "auto-mode-agents"],
    queryFn: async () => {
      const { data, error } =
        await archestraApiSdk.getMcpServerAutoModeAgents();
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
    enabled: (params?.enabled ?? true) && !!canReadInstallations,
  });
}

export function useMcpInstallationStatusCacheSync(enabled = true) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return;

    websocketService.connect();
    const unsubscribeStatus = websocketService.subscribe(
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
          if (status === "success") {
            void invalidateExternalMcpSkillQueries(queryClient);
          }
        }
      },
    );
    const unsubscribeLifecycle = websocketService.subscribe(
      "mcp_servers_changed",
      (message: McpServersChangedMessage) => {
        const { serverIds, catalogIds } = message.payload;
        removeExternalMcpSkillCachesForSources({
          queryClient,
          serverIds,
          catalogIds,
        });
        removeMcpServersFromCache({ queryClient, serverIds, catalogIds });
        void invalidateExternalMcpSkillQueries(queryClient);
        void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
        void queryClient.invalidateQueries({ queryKey: ["mcp-catalog"] });
        invalidateToolAssignmentQueries(queryClient);
      },
    );
    const unsubscribeReady = websocketService.subscribe(
      "websocket_ready",
      () => {
        const isReconnect = websocketReadySyncedClients.has(queryClient);
        websocketReadySyncedClients.add(queryClient);
        if (!isReconnect) return;
        void invalidateExternalMcpSkillQueries(queryClient);
        void queryClient.invalidateQueries({
          queryKey: externalMcpSkillDetailQueryKey,
        });
        void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
        void queryClient.invalidateQueries({ queryKey: ["mcp-catalog"] });
        invalidateToolAssignmentQueries(queryClient);
      },
    );

    return () => {
      unsubscribeStatus();
      unsubscribeLifecycle();
      unsubscribeReady();
    };
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
      if (installedServer) {
        await invalidateExternalMcpSkillQueries(queryClient);
      }
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
      // A new connection can be exactly the one an agent was waiting on, so the
      // chat picker and composer notice have to re-ask what is still missing.
      queryClient.invalidateQueries({
        queryKey: ["agents", "credential-readiness"],
      });
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

/**
 * Uninstalls a selection of MCP servers in one request, bypassing
 * `useDeleteMcpServer` — which toasts and refetches per call, so a selection
 * would fire one toast and one refetch per row. Built-in and app-backing
 * servers come back in `failed` with the reason they cannot be uninstalled.
 */
export function useBulkUninstallMcpServers() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (servers: readonly { id: string; name: string }[]) =>
      bulkDeleteMcpServers({
        body: { ids: servers.map((server) => server.id) },
      }).then(({ data, error }) => {
        throwOnApiError(error, { toastOnError: false });
        const result = data ?? { succeeded: [], failed: [] };
        return {
          ...toBulkOutcome(result),
          succeededIds: result.succeeded.map((server) => server.id),
        };
      }),
    onSuccess: (outcome) => {
      removeExternalMcpSkillCachesForSources({
        queryClient,
        serverIds: outcome.succeededIds,
      });
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ["mcp-servers"] }),
        invalidateExternalMcpSkillQueries(queryClient),
      ]);
      invalidateToolAssignmentQueries(queryClient);
    },
  });
}

export function useDeleteMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { id: string; name: string }) => {
      const response = await deleteMcpServer({ path: { id: data.id } });
      // The generated client runs with `throwOnError: false`, so a refusal
      // resolves like a success: without this, a 403 fell straight through to
      // `onSuccess` and the UI reported "Successfully uninstalled" while the
      // install was still there. `onError` below names the server and carries
      // the API's reason, so the refusal is not toasted twice.
      throwOnApiError(response.error, { toastOnError: false });
      return response.data;
    },
    onSuccess: async (_, variables) => {
      trackEvent("mcp_server_uninstalled", {
        serverId: variables.id,
        serverName: variables.name,
      });
      removeExternalMcpSkillCachesForSources({
        queryClient,
        serverIds: [variables.id],
      });
      // Refetch instead of just invalidating to ensure data is fresh
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ["mcp-servers"] }),
        invalidateExternalMcpSkillQueries(queryClient),
      ]);
      // Invalidate all tool assignment queries (tools, agent-tools, chat, etc.)
      invalidateToolAssignmentQueries(queryClient);
      toast.success(`Successfully uninstalled ${variables.name}`);
    },
    onError: (error, variables) => {
      console.error("Uninstall error:", error);
      toast.error(`Failed to uninstall ${variables.name}`, {
        description: error.message,
      });
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

      await Promise.all([
        queryClient.refetchQueries({ queryKey: ["mcp-servers"] }),
        invalidateExternalMcpSkillQueries(queryClient),
      ]);
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
          void invalidateExternalMcpSkillQueries(queryClient);
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
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ["mcp-servers"] }),
        invalidateExternalMcpSkillQueries(queryClient),
      ]);
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

/** The alert kinds the API lets a viewer dismiss from their own queue. */
export type DismissibleAlertKind =
  archestraApiTypes.MuteMcpServerAlertData["path"]["kind"];

export type DismissibleMcpAlert = {
  catalogId: string;
  catalogName: string;
  serverId: string | null;
  serverName?: string;
  kind: DismissibleAlertKind;
  issueFingerprint: string;
};

/**
 * Dismiss one or more alerts from the calling viewer's queue. The backend
 * still calls this state a mute; that transport vocabulary is deliberately
 * kept behind this UI-facing hook.
 */
export function useDismissMcpServerAlerts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (variables: {
      alerts: DismissibleMcpAlert[];
      reason?: string;
    }) => {
      const results = await Promise.all(
        variables.alerts.map(async (alert) => {
          try {
            const response = alert.serverId
              ? await muteMcpServerAlert({
                  path: { id: alert.serverId, kind: alert.kind },
                  body: {
                    issueFingerprint: alert.issueFingerprint,
                    ...(variables.reason ? { reason: variables.reason } : {}),
                  },
                })
              : await muteMcpCatalogAlert({
                  path: { id: alert.catalogId, kind: alert.kind },
                  body: {
                    issueFingerprint: alert.issueFingerprint,
                    ...(variables.reason ? { reason: variables.reason } : {}),
                  },
                });
            if (response.error) {
              handleApiError(response.error);
              return { alert, succeeded: false };
            }
            return { alert, succeeded: true };
          } catch (error) {
            toast.error(
              error instanceof Error
                ? error.message
                : `Could not dismiss alert for ${alertDisplayName(alert)}`,
            );
            return { alert, succeeded: false };
          }
        }),
      );
      return {
        succeeded: results
          .filter((result) => result.succeeded)
          .map((result) => result.alert),
        failed: results
          .filter((result) => !result.succeeded)
          .map((result) => result.alert),
      };
    },
    onSuccess: async ({ succeeded, failed }, variables) => {
      if (succeeded.length === 0) return;
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ["mcp-servers"] }),
        queryClient.refetchQueries({ queryKey: ["mcp-catalog"] }),
      ]);
      toast.success(
        succeeded.length === 1 && failed.length === 0
          ? `Dismissed alert for ${alertDisplayName(succeeded[0])}`
          : failed.length > 0
            ? `Dismissed ${succeeded.length} of ${variables.alerts.length} alerts`
            : `Dismissed ${succeeded.length} alerts`,
      );
    },
  });
}

/** Restore one or more dismissed alerts to the calling viewer's queue. */
export function useRestoreMcpServerAlerts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (variables: { alerts: DismissibleMcpAlert[] }) => {
      const results = await Promise.all(
        variables.alerts.map(async (alert) => {
          try {
            const response = alert.serverId
              ? await unmuteMcpServerAlert({
                  path: { id: alert.serverId, kind: alert.kind },
                  query: { issueFingerprint: alert.issueFingerprint },
                })
              : await unmuteMcpCatalogAlert({
                  path: { id: alert.catalogId, kind: alert.kind },
                  query: { issueFingerprint: alert.issueFingerprint },
                });
            if (response.error) {
              handleApiError(response.error);
              return { alert, succeeded: false };
            }
            return { alert, succeeded: true };
          } catch (error) {
            toast.error(
              error instanceof Error
                ? error.message
                : `Could not restore alert for ${alertDisplayName(alert)}`,
            );
            return { alert, succeeded: false };
          }
        }),
      );
      return {
        succeeded: results
          .filter((result) => result.succeeded)
          .map((result) => result.alert),
        failed: results
          .filter((result) => !result.succeeded)
          .map((result) => result.alert),
      };
    },
    onSuccess: async ({ succeeded, failed }, variables) => {
      if (succeeded.length === 0) return;
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ["mcp-servers"] }),
        queryClient.refetchQueries({ queryKey: ["mcp-catalog"] }),
      ]);
      toast.success(
        succeeded.length === 1 && failed.length === 0
          ? `Restored alert for ${alertDisplayName(succeeded[0])}`
          : failed.length > 0
            ? `Restored ${succeeded.length} of ${variables.alerts.length} alerts`
            : `Restored ${succeeded.length} alerts`,
      );
    },
  });
}

function alertDisplayName(alert: DismissibleMcpAlert | undefined): string {
  return alert?.serverName ?? alert?.catalogName ?? "MCP server";
}

export type McpDeploymentFeedState =
  | "loading"
  | "ready"
  | "disabled"
  | "disconnected";

export type McpDeploymentStatusFeed = {
  statuses: Record<string, McpDeploymentStatusEntry>;
  /**
   * Why callers need this: an empty `statuses` is ambiguous on its own. It
   * means "nothing has arrived yet" on a Kubernetes deployment and "there will
   * never be anything" everywhere else, and a UI that cannot tell them apart
   * shows a permanent "Checking" on every non-Kubernetes deployment.
   */
  state: McpDeploymentFeedState;
};

// Handed to every disabled caller by identity, so it must not be writable.
const NO_DEPLOYMENT_STATUSES: Record<string, McpDeploymentStatusEntry> =
  Object.freeze({});

const DISABLED_DEPLOYMENT_FEED: McpDeploymentStatusFeed = Object.freeze({
  statuses: NO_DEPLOYMENT_STATUSES,
  state: "disabled",
});

// `useFeature` reports undefined until the config query resolves, which is not
// the same as the flag being off: reporting "disabled" there would settle the
// UI on the wrong answer for every deployment during the first render pass.
const CONFIG_PENDING_DEPLOYMENT_FEED: McpDeploymentStatusFeed = Object.freeze({
  statuses: NO_DEPLOYMENT_STATUSES,
  state: "loading",
});

/**
 * Whether the socket carrying the feed is up. "connecting" is the first
 * attempt, still in flight — the only phase where nothing has been decided
 * yet; "disconnected" is an attempt that ended without a live socket, whether
 * it never opened or opened and later closed.
 */
type DeploymentFeedConnection = "connecting" | "connected" | "disconnected";

// The deployment-status feed is shared module state rather than per-component
// state because the backend keys the subscription by socket, not by component:
// one component unsubscribing on unmount used to cut the feed for every other
// component still reading it. Consumers are reference counted instead, and the
// subscription is re-sent whenever it could have gone stale, since the backend
// captures the caller's accessible-server list once, at subscribe time.
const deploymentFeedListeners = new Set<() => void>();
let deploymentFeedConsumers = 0;
let deploymentFeed: McpDeploymentStatusFeed = {
  statuses: NO_DEPLOYMENT_STATUSES,
  state: "loading",
};
let deploymentFeedHasStatuses = false;
let deploymentFeedSocketUnsubscribe: (() => void) | null = null;
let deploymentFeedConnectionUnsubscribe: (() => void) | null = null;
let deploymentFeedConnection: DeploymentFeedConnection = "connecting";
let deploymentFeedServersSignature: string | null = null;
let deploymentFeedUserId: string | null = null;

function currentDeploymentFeedState(): McpDeploymentFeedState {
  // "loading" is only honest while the first connection attempt is in flight
  // or while a live socket has yet to push its first payload. Once an attempt
  // has failed there is nothing to wait for, and a backend that never accepts
  // the socket must not read as "loading" forever.
  if (deploymentFeedConnection === "disconnected") return "disconnected";
  return deploymentFeedHasStatuses ? "ready" : "loading";
}

function publishDeploymentFeed(
  statuses: Record<string, McpDeploymentStatusEntry>,
): void {
  deploymentFeed = { statuses, state: currentDeploymentFeedState() };
  for (const listener of deploymentFeedListeners) {
    listener();
  }
}

function sendDeploymentFeedSubscribe(): void {
  // Only a live socket carries a subscription: the backend attaches it to the
  // connection it arrived on. Queueing one for a socket that has not opened
  // yet would duplicate the subscribe the open handler below already sends.
  if (!websocketService.isConnected()) return;

  websocketService.send({
    type: "subscribe_mcp_deployment_statuses",
    payload: {},
  });
}

function handleDeploymentFeedConnectionChange(isConnected: boolean): void {
  deploymentFeedConnection = isConnected ? "connected" : "disconnected";
  if (isConnected) {
    // The backend drops the subscription along with the closed socket, so
    // every new connection has to ask for the feed again.
    sendDeploymentFeedSubscribe();
  }
  publishDeploymentFeed(deploymentFeed.statuses);
}

function retainDeploymentFeed(): void {
  deploymentFeedConsumers += 1;
  if (deploymentFeedConsumers > 1) return;

  deploymentFeedSocketUnsubscribe = websocketService.subscribe(
    "mcp_deployment_statuses",
    (message: McpDeploymentStatusesMessage) => {
      deploymentFeedHasStatuses = true;
      publishDeploymentFeed(message.payload.statuses);
    },
  );
  deploymentFeedConnectionUnsubscribe = websocketService.onConnectionChange(
    handleDeploymentFeedConnectionChange,
  );
  websocketService.connect();
  // A socket that is already open gets no further open event, so it is
  // subscribed here; one that is still connecting is subscribed by the
  // connection handler the moment it opens.
  deploymentFeedConnection = websocketService.isConnected()
    ? "connected"
    : "connecting";
  sendDeploymentFeedSubscribe();
}

function releaseDeploymentFeed(): void {
  deploymentFeedConsumers -= 1;
  if (deploymentFeedConsumers > 0) return;

  websocketService.send({
    type: "unsubscribe_mcp_deployment_statuses",
    payload: {},
  });
  deploymentFeedSocketUnsubscribe?.();
  deploymentFeedSocketUnsubscribe = null;
  deploymentFeedConnectionUnsubscribe?.();
  deploymentFeedConnectionUnsubscribe = null;
  deploymentFeedHasStatuses = false;
  deploymentFeedConnection = "connecting";
  deploymentFeedServersSignature = null;
  deploymentFeedUserId = null;
  deploymentFeed = {
    statuses: NO_DEPLOYMENT_STATUSES,
    state: "loading",
  };
}

/**
 * Re-subscribe when the set of installed servers changes. The backend resolves
 * which servers the caller may see once, when the subscription is created, so
 * a server installed afterwards would otherwise never appear in the feed.
 */
function refreshDeploymentFeedForServers(signature: string): void {
  if (deploymentFeedConsumers === 0) return;

  const previousSignature = deploymentFeedServersSignature;
  deploymentFeedServersSignature = signature;
  // The first signature we see is the list the backend resolved for us at
  // subscribe time, so only a later change is worth another round trip.
  if (previousSignature === null || previousSignature === signature) return;

  sendDeploymentFeedSubscribe();
}

/**
 * Drop everything the feed holds when the signed-in user changes. The statuses
 * carry pod names and runtime error messages for the servers the previous user
 * could see, and a sign-out/sign-in without a page reload leaves this module
 * loaded, so they would otherwise be shown to whoever signs in next.
 */
function resetDeploymentFeedForUser(userId: string): void {
  if (deploymentFeedUserId === userId) return;

  const previousUserId = deploymentFeedUserId;
  deploymentFeedUserId = userId;
  if (previousUserId === null || deploymentFeedConsumers === 0) return;

  deploymentFeedHasStatuses = false;
  deploymentFeedServersSignature = null;
  publishDeploymentFeed(NO_DEPLOYMENT_STATUSES);
  // The live socket still holds the previous user's subscription; the backend
  // re-resolves the accessible servers when it is asked again.
  sendDeploymentFeedSubscribe();
}

/**
 * The ids of every installed server the query cache already knows about. Read
 * from the cache rather than fetched: `useMcpDeploymentStatuses` is mounted for
 * the whole session, and a query of its own under the `mcp-servers` key would
 * race the server-rendered data the registry page primes that key with.
 */
function cachedMcpServersSignature(queryClient: QueryClient): string | null {
  const serverIds = new Set<string>();
  let sawServerList = false;

  for (const [queryKey, servers] of queryClient.getQueriesData<
    archestraApiTypes.GetMcpServersResponses["200"]
  >({ queryKey: ["mcp-servers"] })) {
    // The same prefix also keys per-server tool lists and the auto-mode agent
    // list; only the two-element key with a filter object is a server list.
    if (queryKey.length !== 2 || typeof queryKey[1] !== "object") continue;
    if (!Array.isArray(servers)) continue;
    sawServerList = true;
    for (const server of servers) {
      serverIds.add(server.id);
    }
  }

  return sawServerList ? [...serverIds].sort().join(",") : null;
}

// No cache exists while rendering on the server, and the feed only runs in the
// browser anyway.
const noCachedMcpServersSignature = () => null;

/**
 * Subscribe to real-time MCP deployment statuses via WebSocket.
 *
 * The underlying subscription is shared and reference counted, so several
 * components can read the feed at once and it outlives any one of them
 * unmounting. Only subscribes when the K8s runtime feature flag is enabled;
 * everywhere else the returned state is "disabled" and never "loading".
 */
export function useMcpDeploymentStatuses(): McpDeploymentStatusFeed {
  const isK8sEnabled = useFeature("orchestratorK8sRuntime");
  const { data: session } = useSession();
  const sessionUserId = session?.user?.id ?? null;
  const [feed, setFeed] = useState(deploymentFeed);

  useEffect(() => {
    if (isK8sEnabled !== true) return;

    const listener = () => setFeed(deploymentFeed);
    deploymentFeedListeners.add(listener);
    retainDeploymentFeed();
    // A feed retained by an earlier consumer already holds statuses; adopt
    // them instead of rendering "loading" until the next push.
    setFeed(deploymentFeed);

    return () => {
      deploymentFeedListeners.delete(listener);
      releaseDeploymentFeed();
    };
  }, [isK8sEnabled]);

  useEffect(() => {
    if (isK8sEnabled !== true || sessionUserId === null) return;
    resetDeploymentFeedForUser(sessionUserId);
  }, [isK8sEnabled, sessionUserId]);

  if (isK8sEnabled === undefined) return CONFIG_PENDING_DEPLOYMENT_FEED;
  if (!isK8sEnabled) return DISABLED_DEPLOYMENT_FEED;
  return feed;
}

/**
 * Keeps the backend's subscription pointed at the servers this session can
 * actually see: it captures the accessible list once per subscribe, so a newly
 * installed server is invisible until we re-subscribe.
 *
 * Mounted ONCE, by the app shell. Watching the query cache from every consumer
 * meant a cache write during one component's render pushed a store update into
 * another's; the driver's notifications are deferred one microtask for the
 * same reason, which React requires before reporting a new external-store
 * snapshot.
 */
export function useMcpDeploymentFeedDriver(): void {
  const isK8sEnabled = useFeature("orchestratorK8sRuntime");
  const queryClient = useQueryClient();
  const subscribeToQueryCache = useCallback(
    (onCacheChange: () => void) => {
      let active = true;
      let queued = false;
      const unsubscribe = queryClient.getQueryCache().subscribe(() => {
        if (queued) return;
        queued = true;
        queueMicrotask(() => {
          queued = false;
          if (active) onCacheChange();
        });
      });
      return () => {
        active = false;
        unsubscribe();
      };
    },
    [queryClient],
  );
  const readServersSignature = useCallback(
    () => cachedMcpServersSignature(queryClient),
    [queryClient],
  );
  const serversSignature = useSyncExternalStore(
    subscribeToQueryCache,
    readServersSignature,
    noCachedMcpServersSignature,
  );

  useEffect(() => {
    if (isK8sEnabled !== true || serversSignature === null) return;
    refreshDeploymentFeedForServers(serversSignature);
  }, [isK8sEnabled, serversSignature]);
}

// Server ids whose async ("runtime") install failure was already sent to
// analytics. Module-level so the capture happens once regardless of how many
// components have `useMcpInstallationStatusCacheSync` mounted.
const runtimeInstallErrorsAlreadyTracked = new Set<string>();
// The first ready event follows the page's own fresh loads; only a reconnect
// can have missed lifecycle events and needs a full cache resync.
const websocketReadySyncedClients = new WeakSet<QueryClient>();

function invalidateExternalMcpSkillQueries(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: externalMcpSkillsQueryKey });
}

function removeExternalMcpSkillCachesForSources(params: {
  queryClient: QueryClient;
  serverIds?: string[];
  catalogIds?: string[];
}) {
  const serverIds = new Set(params.serverIds ?? []);
  const catalogIds = new Set(params.catalogIds ?? []);
  params.queryClient.setQueriesData<
    archestraApiTypes.GetExternalMcpSkillsResponses["200"]
  >(
    { queryKey: externalMcpSkillsQueryKey },
    (skills) =>
      skills?.filter(
        (skill) =>
          !serverIds.has(skill.mcpServerId) && !catalogIds.has(skill.catalogId),
      ) ?? skills,
  );
  params.queryClient.setQueriesData<
    archestraApiTypes.GetExternalMcpSkillResponses["200"] | null
  >({ queryKey: externalMcpSkillDetailQueryKey }, (skill) => {
    if (!skill) return skill;
    return serverIds.has(skill.mcpServerId) || catalogIds.has(skill.catalogId)
      ? null
      : skill;
  });
}

function removeMcpServersFromCache(params: {
  queryClient: QueryClient;
  serverIds: string[];
  catalogIds: string[];
}) {
  const serverIds = new Set(params.serverIds);
  const catalogIds = new Set(params.catalogIds);
  params.queryClient.setQueriesData<
    archestraApiTypes.GetMcpServersResponses["200"]
  >({ queryKey: ["mcp-servers"] }, (servers) =>
    Array.isArray(servers)
      ? servers.filter(
          (server) =>
            !serverIds.has(server.id) && !catalogIds.has(server.catalogId),
        )
      : servers,
  );
}
