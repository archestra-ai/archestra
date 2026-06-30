"use client";

import {
  ARCHESTRA_MCP_CATALOG_ID,
  isPlaywrightCatalogItem,
  MCP_CATALOG_REAUTH_QUERY_PARAM,
  MCP_CATALOG_SERVER_QUERY_PARAM,
} from "@archestra/shared";
import { Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  LabelFilterBadges,
  LabelKeyRowBase,
  LabelSelect,
  parseLabelsParam,
  serializeLabels,
} from "@/components/label-select";
import {
  OAuthConfirmationDialog,
  type OAuthInstallResult,
} from "@/components/oauth-confirmation-dialog";
import { SearchInput } from "@/components/search-input";
import { Button } from "@/components/ui/button";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useInitiateOAuth } from "@/lib/auth/oauth.query";
import {
  setOAuthCatalogId,
  setOAuthMcpServerId,
  setOAuthReturnUrl,
  setOAuthScope,
  setOAuthState,
  setOAuthTeamId,
} from "@/lib/auth/oauth-session";
import { useEnvironments } from "@/lib/environment.query";
import { useDialogs } from "@/lib/hooks/use-dialog";
import {
  useInternalMcpCatalog,
  useMcpCatalogLabelKeys,
  useMcpCatalogLabelValues,
  useReinstallInternalMcpCatalogItem,
} from "@/lib/mcp/internal-mcp-catalog.query";
import {
  useMcpDeploymentStatuses,
  useMcpInstallationStatusCacheSync,
  useMcpServers,
  useReauthenticateMcpServer,
  useReinstallMcpServer,
} from "@/lib/mcp/mcp-server.query";
import { buildRemoteInstallCredentialPayload } from "@/lib/mcp/remote-install-payload";
import { useDefaultEnvironment } from "@/lib/organization.query";
import { resolveCatalogEnvironmentLabel } from "../../_parts/catalog-environment-label";
import { CustomServerRequestDialog } from "../../_parts/custom-server-request-dialog";
import {
  LocalServerInstallDialog,
  type LocalServerInstallResult,
} from "../../_parts/local-server-install-dialog";
import { ReinstallConfirmationDialog } from "../../_parts/reinstall-confirmation-dialog";
import {
  RemoteServerInstallDialog,
  type RemoteServerInstallResult,
} from "../../_parts/remote-server-install-dialog";
import type { McpServerInstallScope } from "../../_parts/select-mcp-server-credential-type-and-teams";
import { ManageUsersDialog } from "./manage-users-dialog";
import {
  type CatalogItem,
  type InstalledServer,
  McpServerCard,
} from "./mcp-server-card";
import {
  emptyRegistryFilters,
  type FilterGroup,
  type FilterOption,
  RegistryFilterChips,
  RegistryFilterDropdown,
  type RegistryFilters,
  RegistrySortMenu,
  type SortKey,
  STATUS_OPTIONS,
} from "./registry-list-controls";
import { useCatalogInstall } from "./use-catalog-install";

export function InternalMCPCatalog({
  initialData,
  installedServers: initialInstalledServers,
}: {
  initialData?: CatalogItem[];
  installedServers?: InstalledServer[];
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Get search query from URL
  const searchQueryFromUrl = searchParams.get("search") || "";

  const { data: catalogItems } = useInternalMcpCatalog({
    initialData,
  });
  const { data: installedServers } = useMcpServers({
    initialData: initialInstalledServers,
  });
  useMcpInstallationStatusCacheSync();

  // Shared install flow (install / add-personal / add-shared / add-org,
  // remote / local / no-auth, OAuth, enterprise guard). Reinstall and reauth
  // live below and reuse the polling set + installingItemId exposed here.
  const install = useCatalogInstall();
  const {
    installingItemId,
    installingServerIds,
    setInstallingServerIds,
    setInstallingItemId,
  } = install;

  const reinstallMutation = useReinstallMcpServer();
  // When the card requests an admin combined reinstall, remember which
  // catalog id needs its shared pod recreated *after* the per-install
  // mutation finishes. Cleared in finally blocks below.
  const [pendingCatalogReinstallId, setPendingCatalogReinstallId] = useState<
    string | null
  >(null);
  const reinstallCatalogMutation = useReinstallInternalMcpCatalogItem();
  const reauthMutation = useReauthenticateMcpServer();
  const initiateOAuthMutation = useInitiateOAuth();
  const deploymentStatuses = useMcpDeploymentStatuses();
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const { data: environmentList } = useEnvironments();
  const defaultEnvironment = useDefaultEnvironment();

  const [sort, setSort] = useState<SortKey>("name-asc");
  const [filters, setFilters] = useState<RegistryFilters>(emptyRegistryFilters);
  const toggleFilter = useCallback((group: FilterGroup, value: string) => {
    setFilters((prev) => {
      const next = new Set(prev[group]);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return { ...prev, [group]: next };
    });
  }, []);
  const removeFilter = useCallback((group: FilterGroup, value: string) => {
    setFilters((prev) => {
      const next = new Set(prev[group]);
      next.delete(value);
      return { ...prev, [group]: next };
    });
  }, []);
  const clearAdvancedFilters = useCallback(
    () => setFilters(emptyRegistryFilters()),
    [],
  );

  const { isDialogOpened, openDialog, closeDialog } = useDialogs<
    | "custom-request"
    | "remote-install"
    | "local-install"
    | "oauth"
    | "reinstall"
    | "manage"
  >();

  // Deep-link manage connections dialog state
  const [manageCatalogId, setManageCatalogId] = useState<string | null>(null);

  // Update URL when search query changes (debounced via DebouncedInput)
  const handleSearchChange = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value.trim()) {
        params.set("search", value);
      } else {
        params.delete("search");
      }
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );
  const [selectedCatalogItem, setSelectedCatalogItem] =
    useState<CatalogItem | null>(null);
  const [catalogItemForReinstall, setCatalogItemForReinstall] =
    useState<CatalogItem | null>(null);
  // When reinstalling via the card, this holds every install flagged for
  // reinstall — so handleReinstallConfirm can fan out instead of only
  // reinstalling a single install.
  const [reinstallFlaggedTargets, setReinstallFlaggedTargets] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [localServerCatalogItem, setLocalServerCatalogItem] =
    useState<CatalogItem | null>(null);
  // Track server ID when reinstalling (vs new installation)
  const [reinstallServerId, setReinstallServerId] = useState<string | null>(
    null,
  );
  // Track the team ID of the server being reinstalled (to pre-select credential type)
  const [reinstallServerTeamId, setReinstallServerTeamId] = useState<
    string | null
  >(null);
  // Track the scope of the server being reinstalled (to pre-select scope)
  const [reinstallServerScope, setReinstallServerScope] = useState<
    McpServerInstallScope | undefined
  >(undefined);
  // Track server ID for re-authentication (preserves tool assignments)
  const [reauthServerId, setReauthServerId] = useState<string | null>(null);

  const { data: _userIsMcpServerAdmin } = useHasPermissions({
    mcpServerInstallation: ["admin"],
  });

  // Deep-link: auto-open install dialog when ?install={catalogId} is present.
  // Optional &scope=personal|team|org (and &team={teamId} for team scope)
  // pre-target the connection — used by the item detail page's add-connection
  // actions. Owned by the shared install hook.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only trigger on searchParams/catalogItems changes, installFromSearchParams is a stable callback
  useEffect(() => {
    install.installFromSearchParams();
  }, [searchParams, catalogItems]);

  // Deep-link: handle ?reauth={catalogId} with optional ?server={serverId}
  // When server param is present, go straight to re-authentication (preserves tool assignments).
  // When only reauth param is present, open the manage connections dialog.
  // Uses window.history.replaceState instead of router.replace to avoid triggering
  // a searchParams change that would re-fire the effect and race with state updates.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only trigger on searchParams changes, other deps are stable callbacks
  useEffect(() => {
    const reauthCatalogIdParam = searchParams.get(
      MCP_CATALOG_REAUTH_QUERY_PARAM,
    );
    if (!reauthCatalogIdParam) return;

    // Extract highlight param before clearing URL
    const serverIdParam = searchParams.get(MCP_CATALOG_SERVER_QUERY_PARAM);

    // Clear the manage/highlight params from URL without triggering a React re-render
    const params = new URLSearchParams(searchParams.toString());
    params.delete(MCP_CATALOG_REAUTH_QUERY_PARAM);
    params.delete(MCP_CATALOG_SERVER_QUERY_PARAM);
    const newUrl = params.toString()
      ? `${pathname}?${params.toString()}`
      : pathname;
    window.history.replaceState(null, "", newUrl);

    // When highlight param is present, skip manage dialog and go straight to reauth
    if (serverIdParam) {
      handleDeepLinkReauth(reauthCatalogIdParam, serverIdParam);
      return;
    }

    // Open the manage connections dialog
    setManageCatalogId(reauthCatalogIdParam);
    openDialog("manage");
  }, [searchParams]);

  const handleManageDialogClose = () => {
    closeDialog("manage");
    setManageCatalogId(null);
  };

  // Called to re-authenticate a highlighted credential in-place (preserves tool assignments)
  const handleDeepLinkReauth = (catalogId: string, serverId: string) => {
    const catalogItem = catalogItems?.find((item) => item.id === catalogId);
    if (!catalogItem) return;

    setReauthServerId(serverId);

    if (catalogItem.oauthConfig) {
      // OAuth server: go through OAuth flow with reauth context
      const hasUserConfig =
        catalogItem.userConfig &&
        Object.keys(catalogItem.userConfig).length > 0;

      if (!hasUserConfig) {
        // Pure OAuth — set reauth context and open OAuth confirmation
        setOAuthMcpServerId(serverId);
        setOAuthReturnUrl(window.location.href);
        setSelectedCatalogItem(catalogItem);
        openDialog("oauth");
        return;
      }

      // OAuth + user config fields: open remote install dialog in reauth mode
      setSelectedCatalogItem(catalogItem);
      openDialog("remote-install");
      return;
    }

    // Non-OAuth servers: open the appropriate dialog in reauth mode
    if (catalogItem.serverType === "local") {
      setLocalServerCatalogItem(catalogItem);
      openDialog("local-install");
    } else {
      setSelectedCatalogItem(catalogItem);
      openDialog("remote-install");
    }
  };

  // OAuth confirm for re-authentication (install OAuth lives in useCatalogInstall).
  const handleReauthOAuthConfirm = async (result: OAuthInstallResult) => {
    if (!selectedCatalogItem) return;

    try {
      const { authorizationUrl, state } =
        await initiateOAuthMutation.mutateAsync({
          catalogId: selectedCatalogItem.id,
        });

      setOAuthState(state);
      setOAuthCatalogId(selectedCatalogItem.id);
      setOAuthTeamId(result.scope === "team" ? (result.teamId ?? null) : null);
      setOAuthScope(result.scope);

      if (reauthServerId) {
        setOAuthMcpServerId(reauthServerId);
        setOAuthReturnUrl(window.location.href);
        setReauthServerId(null);
      }

      window.location.href = authorizationUrl;
    } catch {
      toast.error("Failed to initiate OAuth flow");
    }
  };

  // Re-authentication confirm for local servers (reuses the local install dialog).
  const handleLocalServerReauthOrReinstallConfirm = async (
    installResult: LocalServerInstallResult,
  ) => {
    if (!localServerCatalogItem) return;

    // Re-authentication mode: update existing server credentials in-place
    if (reauthServerId) {
      await reauthMutation.mutateAsync({
        id: reauthServerId,
        name: localServerCatalogItem.name,
        environmentValues: installResult.environmentValues,
        userConfigValues: installResult.userConfigValues,
        isByosVault: installResult.isByosVault,
      });

      closeDialog("local-install");
      setLocalServerCatalogItem(null);
      setReauthServerId(null);
      return;
    }

    // Reinstall mode - apply the submitted values to every flagged install
    // in the preset family (or just the single one if the card didn't pass a
    // list). Same env/userConfig bag is applied to each — operators can edit
    // per-install secrets afterwards from Manage credentials.
    if (reinstallServerId) {
      const targetIds =
        reinstallFlaggedTargets.length > 0
          ? reinstallFlaggedTargets.map((t) => t.id)
          : [reinstallServerId];
      const targets = (installedServers ?? []).filter((s) =>
        targetIds.includes(s.id),
      );

      setInstallingItemId(localServerCatalogItem.id);
      setInstallingServerIds((prev) => {
        const next = new Set(prev);
        for (const t of targets) next.add(t.id);
        return next;
      });
      closeDialog("local-install");
      const catalogItemName = localServerCatalogItem.name;
      setLocalServerCatalogItem(null);
      setReinstallServerId(null);
      setReinstallServerTeamId(null);
      setReinstallServerScope(undefined);

      try {
        await Promise.all(
          targets.map((t) =>
            reinstallMutation.mutateAsync({
              id: t.id,
              name: catalogItemName,
              environmentValues: installResult.environmentValues,
              userConfigValues: installResult.userConfigValues,
              isByosVault: installResult.isByosVault,
              serviceAccount: installResult.serviceAccount,
            }),
          ),
        );
        if (pendingCatalogReinstallId) {
          // Per-install mutation persisted the admin's new prompted
          // values; now recreate the shared pod and cascade tool sync
          // to every tenant. If this step fails, the catalog flag stays
          // set and the next click will retry it directly (no modal,
          // since the admin's reinstall_required is already cleared).
          await reinstallCatalogMutation.mutateAsync(pendingCatalogReinstallId);
        }
      } finally {
        setInstallingItemId(null);
        setInstallingServerIds((prev) => {
          const next = new Set(prev);
          for (const t of targets) next.delete(t.id);
          return next;
        });
        setReinstallFlaggedTargets([]);
        setPendingCatalogReinstallId(null);
      }
    }
  };

  const handleRemoteServerReauthOrReinstallConfirm = async (
    catalogItem: CatalogItem,
    result: RemoteServerInstallResult,
  ) => {
    const credentialPayload = buildRemoteInstallCredentialPayload(result);

    // Re-authentication mode: update existing server credentials in-place
    if (reauthServerId) {
      await reauthMutation.mutateAsync({
        id: reauthServerId,
        name: catalogItem.name,
        ...credentialPayload,
      });

      closeDialog("remote-install");
      setSelectedCatalogItem(null);
      setReauthServerId(null);
      return;
    }

    // Reinstall mode. Scope and team are fixed on the existing row, so
    // result.scope / result.teamId from the dialog are dropped here.
    if (reinstallServerId) {
      const target = (installedServers ?? []).find(
        (s) => s.id === reinstallServerId,
      );
      const targetId = reinstallServerId;
      setInstallingItemId(catalogItem.id);
      setInstallingServerIds((prev) => new Set(prev).add(targetId));
      closeDialog("remote-install");
      setSelectedCatalogItem(null);
      setReinstallServerId(null);

      try {
        await reinstallMutation.mutateAsync({
          id: targetId,
          name: target?.name ?? catalogItem.name,
          ...credentialPayload,
        });
      } finally {
        setInstallingItemId(null);
        setInstallingServerIds((prev) => {
          const next = new Set(prev);
          next.delete(targetId);
          return next;
        });
      }
    }
  };

  // Aggregate all installations of the same catalog item
  const getAggregatedInstallation = (catalogId: string) => {
    const servers = installedServers?.filter(
      (server) => server.catalogId === catalogId,
    );

    if (!servers || servers.length === 0) return undefined;

    // If only one server, return it as-is
    if (servers.length === 1) {
      return servers[0];
    }

    // Find current user's specific installation to use as base
    const currentUserServer = servers.find((s) => s.ownerId === currentUserId);

    // Prefer current user's server as base, otherwise use first server with users, or just first server
    const baseServer =
      currentUserServer ||
      servers.find((s) => s.users && s.users.length > 0) ||
      servers[0];

    // Aggregate multiple servers
    const aggregated = { ...baseServer };

    // Combine all unique users
    const allUsers = new Set<string>();
    const allUserDetails: Array<{
      userId: string;
      email: string;
      createdAt: string;
      serverId: string; // Track which server this user belongs to
    }> = [];

    for (const server of servers) {
      if (server.users) {
        for (const userId of server.users) {
          allUsers.add(userId);
        }
      }
      if (server.userDetails) {
        for (const userDetail of server.userDetails) {
          // Only add if not already present
          if (!allUserDetails.some((ud) => ud.userId === userDetail.userId)) {
            allUserDetails.push({
              ...userDetail,
              serverId: server.id, // Include the actual server ID
            });
          }
        }
      }
    }

    aggregated.users = Array.from(allUsers);
    aggregated.userDetails = allUserDetails;
    // Note: teamDetails is now a single object per server (many-to-one),
    // so we use the base server's teamDetails as-is

    return aggregated;
  };

  const handleReinstall = async (
    catalogItem: CatalogItem,
    flaggedInstalls?: Array<{
      id: string;
      name: string;
    }>,
    options?: { alsoReinstallCatalog?: boolean },
  ) => {
    // The card passes every flagged install so the confirm step can fan out.
    // If the caller didn't supply any, fall back to the parent install.
    const flagged =
      flaggedInstalls && flaggedInstalls.length > 0
        ? (installedServers ?? []).filter((s) =>
            flaggedInstalls.some((f) => f.id === s.id),
          )
        : [];

    let installedServer: InstalledServer | undefined =
      flagged.find((s) => s.catalogId === catalogItem.id) ?? flagged[0];

    if (!installedServer) {
      if (catalogItem.serverType === "local" && currentUserId) {
        installedServer = installedServers?.find(
          (server) =>
            server.catalogId === catalogItem.id &&
            server.ownerId === currentUserId,
        );
      } else {
        installedServer = installedServers?.find(
          (server) => server.catalogId === catalogItem.id,
        );
      }
    }

    if (!installedServer) {
      toast.error("Server not found, cannot reinstall");
      return;
    }

    if (options?.alsoReinstallCatalog) {
      setPendingCatalogReinstallId(catalogItem.id);
    }

    setReinstallFlaggedTargets(
      flaggedInstalls && flaggedInstalls.length > 0
        ? flaggedInstalls
        : [
            {
              id: installedServer.id,
              name: installedServer.name,
            },
          ],
    );

    // Open the install dialog in reinstall mode whenever there are prompted
    // fields the user owes values for — otherwise the simple "Reinstall
    // Required" confirmation modal is enough. Filters mirror each dialog's
    // own render filters so the two stay in sync; if they drift, the user
    // can be left clicking a confirm dialog when they actually owe input.
    const hasPromptedUserConfig = Object.values(
      catalogItem.userConfig ?? {},
    ).some((field) => field.promptOnInstallation !== false);

    if (catalogItem.serverType === "local") {
      const hasPromptedEnv =
        !catalogItem.multitenant &&
        (catalogItem.localConfig?.environment?.some(
          (env) => env.promptOnInstallation !== false,
        ) ??
          false);

      if (hasPromptedEnv || hasPromptedUserConfig) {
        setLocalServerCatalogItem(catalogItem);
        setReinstallServerId(installedServer.id);
        setReinstallServerTeamId(installedServer.teamId ?? null);
        setReinstallServerScope(
          (installedServer as unknown as { scope?: McpServerInstallScope })
            .scope,
        );
        openDialog("local-install");
      } else {
        setCatalogItemForReinstall(catalogItem);
        openDialog("reinstall");
      }
    } else if (hasPromptedUserConfig) {
      setSelectedCatalogItem(catalogItem);
      setReinstallServerId(installedServer.id);
      setReinstallServerTeamId(installedServer.teamId ?? null);
      setReinstallServerScope(
        (installedServer as unknown as { scope?: McpServerInstallScope }).scope,
      );
      openDialog("remote-install");
    } else {
      setCatalogItemForReinstall(catalogItem);
      openDialog("reinstall");
    }
  };

  const handleReinstallConfirm = async () => {
    if (!catalogItemForReinstall) return;

    // Resolve targets. If the card passed flagged ids, reinstall every one of
    // them; otherwise fall back to the parent install only.
    const targets =
      reinstallFlaggedTargets.length > 0
        ? (installedServers ?? []).filter((s) =>
            reinstallFlaggedTargets.some((t) => t.id === s.id),
          )
        : (() => {
            const fallback =
              catalogItemForReinstall.serverType === "local" && currentUserId
                ? installedServers?.find(
                    (server) =>
                      server.catalogId === catalogItemForReinstall.id &&
                      server.ownerId === currentUserId,
                  )
                : installedServers?.find(
                    (server) => server.catalogId === catalogItemForReinstall.id,
                  );
            return fallback ? [fallback] : [];
          })();

    if (targets.length === 0) {
      toast.error("Server not found, cannot reinstall");
      closeDialog("reinstall");
      setCatalogItemForReinstall(null);
      setReinstallFlaggedTargets([]);
      return;
    }

    closeDialog("reinstall");

    setInstallingItemId(catalogItemForReinstall.id);
    setInstallingServerIds((prev) => {
      const next = new Set(prev);
      for (const t of targets) next.add(t.id);
      return next;
    });

    try {
      await Promise.all(
        targets.map((t) =>
          reinstallMutation.mutateAsync({
            id: t.id,
            name: t.name,
          }),
        ),
      );
      if (pendingCatalogReinstallId) {
        await reinstallCatalogMutation.mutateAsync(pendingCatalogReinstallId);
      }
    } finally {
      setInstallingItemId(null);
      setInstallingServerIds((prev) => {
        const next = new Set(prev);
        for (const t of targets) next.delete(t.id);
        return next;
      });
      setCatalogItemForReinstall(null);
      setReinstallFlaggedTargets([]);
      setPendingCatalogReinstallId(null);
    }
  };

  const filterCatalogItems = (items: CatalogItem[], query: string) => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return items;

    return items.filter((item) =>
      item.name.toLowerCase().includes(normalizedQuery),
    );
  };

  const labelsParam = searchParams.get("labels");
  const parsedLabels = useMemo(
    () => parseLabelsParam(labelsParam),
    [labelsParam],
  );

  const filterByLabels = (
    items: CatalogItem[],
    labels: Record<string, string[]> | null,
  ) => {
    if (!labels || Object.keys(labels).length === 0) return items;
    return items.filter((item) =>
      Object.entries(labels).every(([key, values]) =>
        item.labels.some((l) => l.key === key && values.includes(l.value)),
      ),
    );
  };

  // Live connection status (vs the stable snapshot used for the default sort).
  const connectedCatalogIds = useMemo(
    () =>
      new Set(
        (installedServers ?? [])
          .map((s) => s.catalogId)
          .filter(Boolean) as string[],
      ),
    [installedServers],
  );
  const envLabelByCatalog = useMemo(() => {
    const envs = environmentList?.environments ?? [];
    const map = new Map<string, string | null>();
    for (const it of catalogItems ?? []) {
      map.set(
        it.id,
        it.serverType === "builtin"
          ? null
          : (resolveCatalogEnvironmentLabel({
              environmentId: it.environmentId,
              environments: envs,
              defaultEnvironmentName: defaultEnvironment.name,
            }) ?? defaultEnvironment.name),
      );
    }
    return map;
  }, [catalogItems, environmentList, defaultEnvironment.name]);

  const environmentOptions: FilterOption[] = useMemo(() => {
    const set = new Set<string>();
    envLabelByCatalog.forEach((label) => {
      if (label) set.add(label);
    });
    return [...set].sort().map((value) => ({ value, label: value }));
  }, [envLabelByCatalog]);
  const authorOptions: FilterOption[] = useMemo(() => {
    const set = new Set<string>();
    for (const it of catalogItems ?? []) {
      if (it.authorName) set.add(it.authorName);
    }
    return [...set].sort().map((value) => ({ value, label: value }));
  }, [catalogItems]);
  const matchesAdvancedFilters = (item: CatalogItem) => {
    if (filters.status.size > 0) {
      const installed = connectedCatalogIds.has(item.id);
      const ok =
        (installed && filters.status.has("installed")) ||
        (!installed && filters.status.has("not-installed"));
      if (!ok) return false;
    }
    if (filters.environment.size > 0) {
      const env = envLabelByCatalog.get(item.id);
      if (!env || !filters.environment.has(env)) return false;
    }
    if (
      filters.author.size > 0 &&
      (!item.authorName || !filters.author.has(item.authorName))
    ) {
      return false;
    }
    return true;
  };

  const sortItems = (list: CatalogItem[]) => {
    switch (sort) {
      case "name-desc":
        return [...list].sort((a, b) => b.name.localeCompare(a.name));
      case "newest":
        return [...list].sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
      case "oldest":
        return [...list].sort(
          (a, b) =>
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        );
      case "most-tools":
        return [...list].sort(
          (a, b) => (b.toolCount ?? 0) - (a.toolCount ?? 0),
        );
      default:
        return [...list].sort((a, b) => a.name.localeCompare(b.name));
    }
  };

  const allFilteredItems = sortItems(
    filterByLabels(
      filterCatalogItems(catalogItems || [], searchQueryFromUrl),
      parsedLabels,
    )
      .filter((item) => item.id !== ARCHESTRA_MCP_CATALOG_ID)
      .filter(matchesAdvancedFilters),
  );

  const personalItems = allFilteredItems.filter(
    (item) => item.scope === "personal",
  );
  const sharedItems = allFilteredItems.filter(
    (item) => item.scope !== "personal",
  );

  const getInstalledServerInfo = (item: CatalogItem) => {
    const installedServer = getAggregatedInstallation(item.id);
    const isInstallInProgress =
      installedServer && installingServerIds.has(installedServer.id);

    // For local servers, count installations and check ownership
    const localServers =
      installedServers?.filter(
        (server) =>
          server.serverType === "local" && server.catalogId === item.id,
      ) || [];
    const currentUserLocalServerInstallation = currentUserId
      ? localServers.find((server) => server.ownerId === currentUserId)
      : undefined;
    const currentUserInstalledLocalServer = Boolean(
      currentUserLocalServerInstallation,
    );

    return {
      installedServer,
      isInstallInProgress,
      currentUserInstalledLocalServer,
    };
  };

  const handleRemoveLabel = useCallback(
    (key: string, value: string) => {
      if (!parsedLabels) return;
      const updated = { ...parsedLabels };
      updated[key] = updated[key].filter((v) => v !== value);
      if (updated[key].length === 0) {
        delete updated[key];
      }
      const params = new URLSearchParams(searchParams.toString());
      const serialized = serializeLabels(updated);
      if (serialized) {
        params.set("labels", serialized);
      } else {
        params.delete("labels");
      }
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [parsedLabels, searchParams, router, pathname],
  );

  const handleClearFilters = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("search");
    params.delete("labels");
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [searchParams, router, pathname]);

  const hasLabelFilters = parsedLabels && Object.keys(parsedLabels).length > 0;
  const hasActiveFilters = Boolean(
    searchQueryFromUrl.trim() || hasLabelFilters,
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <SearchInput
          objectNamePlural="MCP servers"
          searchFields={["name"]}
          value={searchQueryFromUrl}
          onSearchChange={handleSearchChange}
          syncQueryParams={false}
          debounceMs={300}
          inputClassName="w-full bg-background/50 backdrop-blur-sm border-border/50 focus:border-primary/50 transition-colors pl-9"
        />
        <McpCatalogLabelFilter />
        <RegistryFilterDropdown
          label="Status"
          options={STATUS_OPTIONS}
          selected={filters.status}
          onToggle={(value) => toggleFilter("status", value)}
        />
        {environmentOptions.length > 0 && (
          <RegistryFilterDropdown
            label="Environment"
            options={environmentOptions}
            selected={filters.environment}
            onToggle={(value) => toggleFilter("environment", value)}
          />
        )}
        {authorOptions.length > 0 && (
          <RegistryFilterDropdown
            label="Author"
            options={authorOptions}
            selected={filters.author}
            onToggle={(value) => toggleFilter("author", value)}
          />
        )}
        <RegistrySortMenu value={sort} onChange={setSort} />
      </div>
      {hasLabelFilters && (
        <LabelFilterBadges onRemoveLabel={handleRemoveLabel} />
      )}
      <RegistryFilterChips
        selected={filters}
        onRemove={removeFilter}
        onClearAll={clearAdvancedFilters}
      />
      <div className="space-y-6">
        {personalItems.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
              Personal
            </h3>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {personalItems.map((item) => {
                const serverInfo = getInstalledServerInfo(item);
                return (
                  <McpServerCard
                    variant={
                      item.serverType === "builtin"
                        ? "builtin"
                        : item.serverType === "remote"
                          ? "remote"
                          : "local"
                    }
                    key={item.id}
                    item={item}
                    installedServer={serverInfo.installedServer}
                    installingItemId={installingItemId}
                    installationStatus={
                      serverInfo.installedServer?.localInstallationStatus ||
                      undefined
                    }
                    deploymentStatuses={deploymentStatuses}
                    onInstallRemoteServer={() => install.installRemote(item)}
                    onInstallLocalServer={() =>
                      isPlaywrightCatalogItem(item.id)
                        ? install.installPlaywright(item)
                        : install.installLocal(item)
                    }
                    onReinstall={(flagged, options) =>
                      handleReinstall(item, flagged, options)
                    }
                    onCancelInstallation={install.cancelInstallation}
                    isBuiltInPlaywright={isPlaywrightCatalogItem(item.id)}
                  />
                );
              })}
            </div>
          </div>
        )}

        {sharedItems.length > 0 ? (
          <div className="space-y-3">
            {personalItems.length > 0 && (
              <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                Shared
              </h3>
            )}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {sharedItems.map((item) => {
                const serverInfo = getInstalledServerInfo(item);
                return (
                  <McpServerCard
                    variant={
                      item.serverType === "builtin"
                        ? "builtin"
                        : item.serverType === "remote"
                          ? "remote"
                          : "local"
                    }
                    key={item.id}
                    item={item}
                    installedServer={serverInfo.installedServer}
                    installingItemId={installingItemId}
                    installationStatus={
                      serverInfo.installedServer?.localInstallationStatus ||
                      undefined
                    }
                    deploymentStatuses={deploymentStatuses}
                    onInstallRemoteServer={() => install.installRemote(item)}
                    onInstallLocalServer={() =>
                      isPlaywrightCatalogItem(item.id)
                        ? install.installPlaywright(item)
                        : install.installLocal(item)
                    }
                    onReinstall={(flagged, options) =>
                      handleReinstall(item, flagged, options)
                    }
                    onCancelInstallation={install.cancelInstallation}
                    isBuiltInPlaywright={isPlaywrightCatalogItem(item.id)}
                  />
                );
              })}
            </div>
          </div>
        ) : (
          personalItems.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              {hasActiveFilters ? (
                <>
                  <Search className="mb-4 h-10 w-10 text-muted-foreground" />
                  <p className="text-muted-foreground">
                    No MCP servers match your filters. Try adjusting your
                    search.
                  </p>
                  <Button
                    variant="outline"
                    className="mt-4"
                    onClick={handleClearFilters}
                  >
                    Clear filters
                  </Button>
                </>
              ) : (
                <p className="text-muted-foreground">No MCP servers found.</p>
              )}
            </div>
          )
        )}
      </div>

      <CustomServerRequestDialog
        isOpen={isDialogOpened("custom-request")}
        onClose={() => closeDialog("custom-request")}
      />

      {/* Shared install-mode dialogs (remote, OAuth, no-auth, local). */}
      {install.dialogs}

      {/* Reinstall + reauth reuse the install dialog components but keep their
          own instances/state so they stay independent of the install flow. */}
      <RemoteServerInstallDialog
        isOpen={isDialogOpened("remote-install")}
        onClose={() => {
          closeDialog("remote-install");
          setSelectedCatalogItem(null);
          setReauthServerId(null);
          setReinstallServerId(null);
          setReinstallServerTeamId(null);
          setReinstallServerScope(undefined);
        }}
        onConfirm={handleRemoteServerReauthOrReinstallConfirm}
        catalogItem={selectedCatalogItem}
        isInstalling={reauthMutation.isPending || reinstallMutation.isPending}
        isReauth={!!reauthServerId}
        isReinstall={!!reinstallServerId && !reauthServerId}
        existingTeamId={reinstallServerTeamId}
        existingScope={reinstallServerScope}
      />

      <OAuthConfirmationDialog
        open={isDialogOpened("oauth")}
        onOpenChange={(open) => {
          if (!open) {
            closeDialog("oauth");
          }
        }}
        serverName={selectedCatalogItem?.name || ""}
        onConfirm={handleReauthOAuthConfirm}
        onCancel={() => {
          closeDialog("oauth");
          setSelectedCatalogItem(null);
          setReauthServerId(null);
        }}
        catalogId={selectedCatalogItem?.id}
      />

      <ReinstallConfirmationDialog
        isOpen={isDialogOpened("reinstall")}
        onClose={() => {
          closeDialog("reinstall");
          setCatalogItemForReinstall(null);
          setReinstallFlaggedTargets([]);
        }}
        onConfirm={handleReinstallConfirm}
        serverName={catalogItemForReinstall?.name || ""}
        isReinstalling={reinstallMutation.isPending}
        targets={reinstallFlaggedTargets}
      />

      {localServerCatalogItem && (
        <LocalServerInstallDialog
          isOpen={isDialogOpened("local-install")}
          onClose={() => {
            closeDialog("local-install");
            setLocalServerCatalogItem(null);
            setReinstallServerId(null);
            setReinstallServerTeamId(null);
            setReinstallServerScope(undefined);
            setReauthServerId(null);
          }}
          onConfirm={handleLocalServerReauthOrReinstallConfirm}
          catalogItem={localServerCatalogItem}
          isInstalling={reinstallMutation.isPending || reauthMutation.isPending}
          isReinstall={!!reinstallServerId}
          existingTeamId={reinstallServerTeamId}
          existingScope={reinstallServerScope}
          isReauth={!!reauthServerId}
        />
      )}

      {manageCatalogId && (
        <ManageUsersDialog
          isOpen={isDialogOpened("manage")}
          onClose={handleManageDialogClose}
          catalogId={manageCatalogId}
          onAddPersonalConnection={() => {
            const catalogItem = catalogItems?.find(
              (item) => item.id === manageCatalogId,
            );
            if (!catalogItem) return;
            install.addPersonalConnection(catalogItem);
          }}
          onAddSharedConnection={(teamId) => {
            const catalogItem = catalogItems?.find(
              (item) => item.id === manageCatalogId,
            );
            if (!catalogItem) return;
            install.addSharedConnection(catalogItem, teamId);
          }}
          onAddOrgConnection={() => {
            const catalogItem = catalogItems?.find(
              (item) => item.id === manageCatalogId,
            );
            if (!catalogItem) return;
            install.addOrgConnection(catalogItem);
          }}
        />
      )}
    </div>
  );
}

function McpCatalogLabelFilter() {
  const { data: labelKeys } = useMcpCatalogLabelKeys();
  return (
    <LabelSelect
      labelKeys={labelKeys}
      LabelKeyRowComponent={McpCatalogLabelKeyRow}
    />
  );
}

function McpCatalogLabelKeyRow({
  labelKey,
  selectedValues,
  onToggleValue,
}: {
  labelKey: string;
  selectedValues: string[];
  onToggleValue: (key: string, value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { data: values } = useMcpCatalogLabelValues({
    key: open ? labelKey : undefined,
  });
  return (
    <LabelKeyRowBase
      labelKey={labelKey}
      selectedValues={selectedValues}
      onToggleValue={onToggleValue}
      values={values}
      onOpenChange={setOpen}
    />
  );
}
