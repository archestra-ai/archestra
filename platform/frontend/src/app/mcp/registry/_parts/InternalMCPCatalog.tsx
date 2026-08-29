"use client";

import {
  ARCHESTRA_MCP_CATALOG_ID,
  isPlaywrightCatalogItem,
  MCP_CATALOG_REAUTH_QUERY_PARAM,
  MCP_CATALOG_SERVER_QUERY_PARAM,
  type McpDeploymentStatusEntry,
} from "@archestra/shared";
import { CheckCircle2, Route, Trash2 } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import {
  CollectionFilters,
  FilterBar,
  filterControlClass,
  filterSearchClass,
} from "@/components/filter-bar";
import {
  LabelFilterBadges,
  LabelKeyRowBase,
  LabelSelect,
  parseLabelsParam,
  serializeLabels,
} from "@/components/label-select";
import { LoadingState } from "@/components/loading";
import {
  OAuthConfirmationDialog,
  type OAuthInstallResult,
} from "@/components/oauth-confirmation-dialog";
import {
  ResourceScopeFilter,
  useScopeFilterParams,
} from "@/components/resource-scope-filter";
import { SearchInput } from "@/components/search-input";
import {
  TableCardGrid,
  TableCardSelectionScope,
  TableCardView,
  TableCardViewContent,
  TableCardViewToggle,
} from "@/components/table-card-view";
import {
  BulkActions,
  type SelectAllMatching,
} from "@/components/ui/bulk-actions-bar";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { PermissionButton } from "@/components/ui/permission-button";
import { TablePagination } from "@/components/ui/table-pagination";
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
import { reportBulkOutcome } from "@/lib/bulk-action";
import { useFeature } from "@/lib/config/config.query";
import { useEnvironments } from "@/lib/environment.query";
import { useBulkCardSelection } from "@/lib/hooks/use-bulk-card-selection";
import { useBulkSelection } from "@/lib/hooks/use-bulk-selection";
import { useDialogs } from "@/lib/hooks/use-dialog";
import { useDialogUrlParam } from "@/lib/hooks/use-dialog-url-param";
import {
  useInternalMcpCatalog,
  useMcpCatalogLabelKeys,
  useMcpCatalogLabelValues,
  useReinstallInternalMcpCatalogItem,
} from "@/lib/mcp/internal-mcp-catalog.query";
import {
  type McpDeploymentFeedState,
  useBulkUninstallMcpServers,
  useMcpDeploymentStatuses,
  useMcpInstallationStatusCacheSync,
  useMcpServers,
  useReauthenticateMcpServer,
  useReinstallMcpServer,
} from "@/lib/mcp/mcp-server.query";
import {
  attentionCatalogIds,
  attentionSortRank,
  facetIssues,
  type McpServerAttentionFacet,
  type McpServerIssue,
} from "@/lib/mcp/mcp-server-issues";
import { buildRemoteInstallCredentialPayload } from "@/lib/mcp/remote-install-payload";
import { useMcpServerIssues } from "@/lib/mcp/use-mcp-server-issues";

import { resolveCatalogEnvironmentLabel } from "./catalog-environment-label";
import {
  LocalServerInstallDialog,
  type LocalServerInstallResult,
} from "./local-server-install-dialog";
import { ManageUsersDialog } from "./manage-users-dialog";
import {
  hasMcpRegistryInstallForViewer,
  matchesMcpRegistryOwnershipFilters,
  mcpRegistryInstallPriority,
} from "./mcp-registry-visibility";
import { McpServerAttentionList } from "./mcp-server-attention-list";
import {
  type CatalogItem,
  type InstalledServer,
  McpServerCard,
} from "./mcp-server-card";
import { McpServerTable } from "./mcp-server-table";
import {
  emptyRegistryFilters,
  FILTER_GROUPS,
  type FilterGroup,
  type FilterOption,
  INSTALLED_STATUS_VALUE,
  ISSUE_OPTIONS,
  NOT_INSTALLED_STATUS_VALUE,
  REGISTRY_STATUS_PARAM,
  RegistryDismissedFilter,
  RegistryFilterChips,
  RegistryFilterDropdown,
  type RegistryFilters,
  RegistrySortMenu,
  SORT_OPTIONS,
  type SortKey,
  STATUS_OPTIONS,
  selectedAttentionFacet,
  withAttentionFacet,
} from "./registry-list-controls";
import { ReinstallConfirmationDialog } from "./reinstall-confirmation-dialog";
import { decideReinstallDialog } from "./reinstall-dialog-decision";
import {
  RemoteServerInstallDialog,
  type RemoteServerInstallResult,
} from "./remote-server-install-dialog";
import type { McpServerInstallScope } from "./select-mcp-server-credential-type-and-teams";
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
  const ownershipFilters = useScopeFilterParams();

  // Get search query from URL
  const searchQueryFromUrl = searchParams.get("search") || "";

  const {
    data: catalogItems,
    isPending: isCatalogPending,
    isFetching: isCatalogFetching,
  } = useInternalMcpCatalog({
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
  const { statuses: deploymentStatuses, state: deploymentFeedState } =
    useMcpDeploymentStatuses();
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const { data: environmentList } = useEnvironments();
  const byosEnabled = Boolean(useFeature("byosEnabled"));
  const alertingFeature = useFeature("mcpServerAlertingEnabled");
  const alertingEnabled = alertingFeature === true;

  const [sort, setSort] = useState<SortKey>("attention");
  const sortOptions =
    alertingFeature === false
      ? SORT_OPTIONS.filter((option) => option.key !== "attention")
      : SORT_OPTIONS;
  useEffect(() => {
    if (alertingFeature === false && sort === "attention") {
      setSort("name-asc");
    }
  }, [alertingFeature, sort]);
  // The filters live in the URL, not in component state: the sidebar badge
  // and the retired `?tab=attention` links both have to be able to point at a
  // filtered list, and Back has to undo a filter change rather than leave the
  // URL and the list disagreeing. Repeated params rather than one joined
  // string, so an environment or author name containing a comma survives.
  const filters = useMemo<RegistryFilters>(() => {
    const next = emptyRegistryFilters();
    for (const group of FILTER_GROUPS) {
      next[group] = new Set(searchParams.getAll(group));
    }
    return next;
  }, [searchParams]);
  const writeFilters = useCallback(
    (next: RegistryFilters) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const group of FILTER_GROUPS) {
        params.delete(group);
        for (const value of next[group]) params.append(group, value);
      }
      const qs = params.toString();
      replaceRegistryListUrl(qs ? `${pathname}?${qs}` : pathname);
    },
    [searchParams, pathname],
  );
  const toggleFilter = useCallback(
    (group: FilterGroup, value: string) => {
      const next = new Set(filters[group]);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      writeFilters({ ...filters, [group]: next });
    },
    [filters, writeFilters],
  );
  const removeFilter = useCallback(
    (group: FilterGroup, value: string) => {
      const next = new Set(filters[group]);
      next.delete(value);
      writeFilters({ ...filters, [group]: next });
    },
    [filters, writeFilters],
  );
  // "Clear all" sits under the chips and clears what the chips show. The
  // facet is view state rather than one of those chips, so taking it here
  // would undo a selection the button never claimed to hold.
  const clearAdvancedFilters = useCallback(
    () =>
      writeFilters({
        ...emptyRegistryFilters(),
        status: withAttentionFacet(
          new Set(),
          selectedAttentionFacet(filters.status),
        ),
      }),
    [writeFilters, filters.status],
  );
  const selectFacet = useCallback(
    (facet: McpServerAttentionFacet | null) =>
      writeFilters({
        ...filters,
        status: withAttentionFacet(filters.status, facet),
        issue: facet ? filters.issue : new Set(),
      }),
    [filters, writeFilters],
  );

  const { isDialogOpened, openDialog, closeDialog } = useDialogs<
    "remote-install" | "local-install" | "oauth" | "reinstall"
  >();

  // Deep-link manage connections dialog state
  const manageUsersIdFromUrl = searchParams.get("manageUsers");
  const manageCatalogItemFromUrl = useMemo(
    () =>
      catalogItems?.find((item) => item.id === manageUsersIdFromUrl) ?? null,
    [catalogItems, manageUsersIdFromUrl],
  );
  const { entity: manageCatalogItem, close: closeManageDialog } =
    useDialogUrlParam({
      paramName: "manageUsers",
      entityFromUrl: manageCatalogItemFromUrl,
    });

  // Update URL when search query changes (debounced via DebouncedInput)
  const handleSearchChange = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value.trim()) {
        params.set("search", value);
      } else {
        params.delete("search");
      }
      replaceRegistryListUrl(`${pathname}?${params.toString()}`);
    },
    [searchParams, pathname],
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
  // Track the existing target's scope so reinstall and reauth dialogs do not
  // misleadingly default an organization/team connection to Personal.
  const [targetServerTeamId, setTargetServerTeamId] = useState<string | null>(
    null,
  );
  const [targetServerScope, setTargetServerScope] = useState<
    McpServerInstallScope | undefined
  >(undefined);
  // Track server ID for re-authentication (preserves tool assignments)
  const [reauthServerId, setReauthServerId] = useState<string | null>(null);

  const { data: userIsMcpServerAdmin } = useHasPermissions({
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

  // Deep-link: handle ?reauth={catalogId} with optional ?server={serverId}.
  // With a server, go straight to re-authentication (preserves tool
  // assignments). Without one, hand off to the manage-connections dialog by
  // writing ?manageUsers={catalogId}; its URL-param hook auto-opens once the
  // catalog loads. router.replace propagates the rewrite to useSearchParams
  // (Next integrates history updates with the router), so the hook sees the
  // param; deleting the reauth param first makes the re-fired effect
  // early-return instead of looping.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run only on searchParams changes; router/pathname are stable and handleDeepLinkReauth is a stable closure
  useEffect(() => {
    const reauthCatalogIdParam = searchParams.get(
      MCP_CATALOG_REAUTH_QUERY_PARAM,
    );
    if (!reauthCatalogIdParam) return;

    // Extract highlight param before clearing URL
    const serverIdParam = searchParams.get(MCP_CATALOG_SERVER_QUERY_PARAM);

    // Drop the reauth/highlight params (and, when unhandled, hand off to the
    // manage dialog) before writing the URL back.
    const params = new URLSearchParams(searchParams.toString());
    params.delete(MCP_CATALOG_REAUTH_QUERY_PARAM);
    params.delete(MCP_CATALOG_SERVER_QUERY_PARAM);
    if (!serverIdParam) {
      // Without a highlighted server, hand off to the manage connections
      // dialog's URL param so it auto-opens once the catalog loads.
      params.set("manageUsers", reauthCatalogIdParam);
    }
    const newUrl = params.toString()
      ? `${pathname}?${params.toString()}`
      : pathname;
    router.replace(newUrl, { scroll: false });

    // When highlight param is present, skip manage dialog and go straight to reauth
    if (serverIdParam) {
      handleDeepLinkReauth(reauthCatalogIdParam, serverIdParam);
    }
  }, [searchParams]);

  // Called to re-authenticate a highlighted credential in-place (preserves tool assignments)
  const handleDeepLinkReauth = (catalogId: string, serverId: string) => {
    const catalogItem = catalogItems?.find((item) => item.id === catalogId);
    if (!catalogItem) return;
    const targetServer = installedServers?.find(
      (server) => server.id === serverId,
    );

    setReauthServerId(serverId);
    setTargetServerTeamId(targetServer?.teamId ?? null);
    setTargetServerScope(
      (targetServer as unknown as { scope?: McpServerInstallScope } | undefined)
        ?.scope,
    );

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
      } else {
        // A fresh install must state that it is not a re-authentication, so a
        // stale ID from an earlier re-auth in this tab cannot divert it.
        setOAuthMcpServerId(null);
      }

      window.location.href = authorizationUrl;
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to initiate OAuth flow",
      );
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
      setTargetServerTeamId(null);
      setTargetServerScope(undefined);

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
  const getAggregatedInstallation = (catalogId: string) =>
    aggregatedInstallationsByCatalog.get(catalogId);

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
      if (options?.alsoReinstallCatalog) {
        setPendingCatalogReinstallId(catalogItem.id);
        setReinstallFlaggedTargets([]);
        setCatalogItemForReinstall(catalogItem);
        openDialog("reinstall");
        return;
      }
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

    // Open the install dialog in reinstall mode only when the flagged
    // installs actually owe prompted values (`reinstallReason: "new-input"`,
    // or no reason to trust a skip) — a restart-only flag gets the simple
    // confirmation modal whose empty-body reinstall reuses stored secrets.
    // Prompted-field filters mirror each dialog's own render filters so the
    // two stay in sync; if they drift, the user can be left clicking a
    // confirm dialog when they actually owe input.
    const hasPromptedUserConfig = Object.values(
      catalogItem.userConfig ?? {},
    ).some((field) => field.promptOnInstallation !== false);
    const hasSensitivePromptedUserConfig = Object.values(
      catalogItem.userConfig ?? {},
    ).some((field) => field.sensitive && field.promptOnInstallation !== false);

    const dialogTargets = flagged.length > 0 ? flagged : [installedServer];
    const flaggedForDecision = dialogTargets.map((s) => ({
      reinstallRequired: s.reinstallRequired,
      reinstallReason: s.reinstallReason ?? null,
    }));

    if (catalogItem.serverType === "local") {
      const hasPromptedEnv =
        !catalogItem.multitenant &&
        (catalogItem.localConfig?.environment?.some(
          (env) => env.promptOnInstallation !== false,
        ) ??
          false);
      const hasSecretPromptedEnv =
        !catalogItem.multitenant &&
        (catalogItem.localConfig?.environment?.some(
          (env) => env.promptOnInstallation !== false && env.type === "secret",
        ) ??
          false);

      const dialogKind = decideReinstallDialog({
        hasPromptedFields: hasPromptedEnv || hasPromptedUserConfig,
        byosCollectsSecrets:
          byosEnabled &&
          (hasSecretPromptedEnv || hasSensitivePromptedUserConfig),
        flaggedInstalls: flaggedForDecision,
      });

      if (dialogKind === "collect-input") {
        setLocalServerCatalogItem(catalogItem);
        setReinstallServerId(installedServer.id);
        setTargetServerTeamId(installedServer.teamId ?? null);
        setTargetServerScope(
          (installedServer as unknown as { scope?: McpServerInstallScope })
            .scope,
        );
        openDialog("local-install");
      } else {
        setCatalogItemForReinstall(catalogItem);
        openDialog("reinstall");
      }
    } else if (
      decideReinstallDialog({
        hasPromptedFields: hasPromptedUserConfig,
        byosCollectsSecrets: byosEnabled && hasSensitivePromptedUserConfig,
        flaggedInstalls: flaggedForDecision,
      }) === "collect-input"
    ) {
      setSelectedCatalogItem(catalogItem);
      setReinstallServerId(installedServer.id);
      setTargetServerTeamId(installedServer.teamId ?? null);
      setTargetServerScope(
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

    if (targets.length === 0 && !pendingCatalogReinstallId) {
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
  const serversByCatalog = useMemo(() => {
    const map = new Map<string, InstalledServer[]>();
    for (const server of installedServers ?? []) {
      if (!server.catalogId) continue;
      map.set(server.catalogId, [...(map.get(server.catalogId) ?? []), server]);
    }
    return map;
  }, [installedServers]);
  const aggregatedInstallationsByCatalog = useMemo(
    () =>
      new Map(
        [...serversByCatalog].map(([catalogId, servers]) => [
          catalogId,
          aggregateInstallations(servers, currentUserId),
        ]),
      ),
    [serversByCatalog, currentUserId],
  );
  const installedForViewerCatalogIds = useMemo(
    () =>
      new Set(
        (installedServers ?? [])
          .filter((server) =>
            hasMcpRegistryInstallForViewer([server], currentUserId),
          )
          .map((server) => server.catalogId)
          .filter(Boolean) as string[],
      ),
    [installedServers, currentUserId],
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
            }) ?? null),
      );
    }
    return map;
  }, [catalogItems, environmentList]);

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
  // Outstanding issues per catalog item, from the same signals every registry
  // surface renders. This feeds the audience facets, Issue filter and table.
  const { issuesByCatalog, facetCounts } =
    useMcpServerIssues(deploymentStatuses);
  const selectedFacet = alertingEnabled
    ? selectedAttentionFacet(filters.status)
    : null;
  useEffect(() => {
    const requestedFacet = selectedAttentionFacet(filters.status);
    if (alertingFeature === false && requestedFacet) {
      selectFacet(null);
    } else if (userIsMcpServerAdmin && selectedFacet === "others") {
      selectFacet("you");
    }
  }, [
    alertingFeature,
    filters.status,
    userIsMcpServerAdmin,
    selectedFacet,
    selectFacet,
  ]);
  // The facet's membership and its count come out of the same call, so the
  // number on the button is always the number of rows below it.
  const facetCatalogIds = useMemo(
    () =>
      selectedFacet
        ? new Set(
            attentionCatalogIds(issuesByCatalog, { audience: selectedFacet }),
          )
        : null,
    [issuesByCatalog, selectedFacet],
  );
  const matchesAdvancedFilters = (item: CatalogItem) => {
    if (
      !matchesMcpRegistryOwnershipFilters({
        item,
        servers: serversByCatalog.get(item.id) ?? [],
        filters: ownershipFilters,
        currentUserId,
      })
    ) {
      return false;
    }
    if (facetCatalogIds && !facetCatalogIds.has(item.id)) return false;
    if (filters.issue.size > 0) {
      const itemIssues = issuesByCatalog.get(item.id) ?? [];
      const visibleIssues = selectedFacet
        ? facetIssues(itemIssues, selectedFacet)
        : itemIssues;
      if (!visibleIssues.some((issue) => filters.issue.has(issue.kind))) {
        return false;
      }
    }
    const wantsInstalled = filters.status.has(INSTALLED_STATUS_VALUE);
    const wantsNotInstalled = filters.status.has(NOT_INSTALLED_STATUS_VALUE);
    if (wantsInstalled || wantsNotInstalled) {
      const installed = connectedCatalogIds.has(item.id);
      if (!((installed && wantsInstalled) || (!installed && wantsNotInstalled)))
        return false;
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
      case "attention":
        return [...list].sort(
          (a, b) =>
            attentionSortRank(issuesByCatalog.get(a.id)) -
              attentionSortRank(issuesByCatalog.get(b.id)) ||
            Number(installedForViewerCatalogIds.has(b.id)) -
              Number(installedForViewerCatalogIds.has(a.id)) ||
            a.name.localeCompare(b.name),
        );
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
      case "issue-age":
        // Oldest outstanding issue first. Items whose issues carry no start
        // time (only re-authentication records one) sort after the dated ones
        // rather than pretending to be brand new.
        return [...list].sort(
          (a, b) =>
            (oldestIssueTime(issuesByCatalog.get(a.id)) ?? Number.MAX_VALUE) -
            (oldestIssueTime(issuesByCatalog.get(b.id)) ?? Number.MAX_VALUE),
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

  function getInstalledServerInfo(item: CatalogItem) {
    const installedServer = getAggregatedInstallation(item.id);
    const isInstallInProgress =
      installedServer && installingServerIds.has(installedServer.id);

    // For local servers, count installations and check ownership
    const catalogServers = serversByCatalog.get(item.id) ?? [];
    const localServers = catalogServers.filter(
      (server) => server.serverType === "local",
    );
    const currentUserHasPersonalInstallation = Boolean(
      currentUserId &&
        catalogServers.some(
          (server) => server.ownerId === currentUserId && !server.teamId,
        ),
    );
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
      currentUserHasPersonalInstallation,
    };
  }

  // Install entry point for the table view, which has no per-variant card
  // buttons: route to the same flows the cards use.
  const handleTableInstall = (item: CatalogItem) => {
    if (item.serverType === "remote") return install.installRemote(item);
    if (isPlaywrightCatalogItem(item.id))
      return install.installPlaywright(item);
    return install.installLocal(item);
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
      replaceRegistryListUrl(`${pathname}?${params.toString()}`);
    },
    [parsedLabels, searchParams, pathname],
  );

  const handleClearFilters = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("search");
    params.delete("labels");
    replaceRegistryListUrl(`${pathname}?${params.toString()}`);
  }, [searchParams, pathname]);

  // Everything except the facet. Offered when a facet is selected and the
  // other filters have emptied it: the reader asked "what needs my action",
  // so the way out is to drop the search and the chips, not the question.
  const clearFiltersKeepingFacet = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("search");
    params.delete("labels");
    for (const group of FILTER_GROUPS) params.delete(group);
    for (const value of withAttentionFacet(
      new Set(),
      selectedAttentionFacet(filters.status),
    )) {
      params.append(REGISTRY_STATUS_PARAM, value);
    }
    const qs = params.toString();
    replaceRegistryListUrl(qs ? `${pathname}?${qs}` : pathname);
  }, [searchParams, pathname, filters.status]);

  const hasLabelFilters = parsedLabels && Object.keys(parsedLabels).length > 0;
  const hasActiveFilters = Boolean(
    ownershipFilters.hasActiveScopeFilters ||
      searchQueryFromUrl.trim() ||
      hasLabelFilters,
  );
  // A selected attention facet is the list's current view, not an applied
  // control within the bar. Keep it in place when clearing the narrower
  // search, label, issue, installation, environment and author filters.
  const hasAppliedBarFilters =
    hasActiveFilters ||
    filters.issue.size > 0 ||
    filters.environment.size > 0 ||
    filters.author.size > 0 ||
    filters.status.has(INSTALLED_STATUS_VALUE) ||
    filters.status.has(NOT_INSTALLED_STATUS_VALUE);
  const handleClearAllFilters = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("search");
    params.delete("labels");
    for (const group of FILTER_GROUPS) params.delete(group);
    for (const group of ["scope", "teamIds", "authorIds", "excludeAuthorIds"]) {
      params.delete(group);
    }
    const qs = params.toString();
    replaceRegistryListUrl(qs ? `${pathname}?${qs}` : pathname);
  }, [searchParams, pathname]);
  const handleClearBarFilters = selectedFacet
    ? clearFiltersKeepingFacet
    : handleClearAllFilters;

  // The healthy-fleet line counts servers somebody actually installed. Over
  // the catalog it read "All 40 MCP servers are healthy" on a deployment with
  // three connections and thirty-seven entries nobody had ever touched.
  const installedCatalogCount = new Set(
    (installedServers ?? [])
      .map((server) => server.catalogId)
      .filter((id): id is string => !!id && id !== ARCHESTRA_MCP_CATALOG_ID),
  ).size;

  if (
    (isCatalogPending || isCatalogFetching) &&
    (catalogItems?.length ?? 0) === 0
  ) {
    return <LoadingState label="Loading MCP servers…" variant="page" />;
  }

  return (
    <TableCardView storageKey="archestra-mcp-registry-view" defaultMode="table">
      <div>
        <CollectionFilters>
          <FilterBar
            leading
            onClearFilters={
              hasAppliedBarFilters ? handleClearBarFilters : undefined
            }
            actions={
              <>
                <RegistrySortMenu
                  value={sort}
                  onChange={setSort}
                  options={sortOptions}
                />
                {!selectedFacet && (
                  <TableCardViewToggle order={["table", "cards"]} />
                )}
              </>
            }
          >
            <SearchInput
              objectNamePlural="MCP servers"
              searchFields={["name"]}
              value={searchQueryFromUrl}
              onSearchChange={handleSearchChange}
              syncQueryParams={false}
              debounceMs={0}
              className={filterSearchClass}
              inputClassName="w-full bg-background/50 backdrop-blur-sm border-border/50 focus:border-primary/50 transition-colors pl-9"
            />
            <McpCatalogLabelFilter active={Boolean(hasLabelFilters)} />
            {!selectedFacet && (
              <ResourceScopeFilter
                adminPermission={{ mcpServerInstallation: ["admin"] }}
                ownerLabelPlural="connections"
                allLabel="All scopes"
                navigate={replaceRegistryListUrl}
              />
            )}
            {selectedFacet ? (
              <RegistryFilterDropdown
                label="Issue"
                options={ISSUE_OPTIONS}
                selected={filters.issue}
                onToggle={(value) => toggleFilter("issue", value)}
              />
            ) : (
              <RegistryFilterDropdown
                label="Status"
                options={STATUS_OPTIONS}
                selected={filters.status}
                onToggle={(value) => toggleFilter("status", value)}
              />
            )}
            {/* Dismissed alerts are the same question with the silenced ones
                instead of without them, so they narrow this list rather than
                occupying a tab of their own. Offered while there is something
                to see and while the reader is looking at it, so the way back
                off never disappears under them. */}
            {(selectedFacet === "you" || selectedFacet === "muted") &&
              (facetCounts.muted > 0 || selectedFacet === "muted") && (
                <RegistryDismissedFilter
                  count={facetCounts.muted}
                  pressed={selectedFacet === "muted"}
                  onToggle={() =>
                    selectFacet(selectedFacet === "muted" ? "you" : "muted")
                  }
                />
              )}
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
          </FilterBar>
          {hasLabelFilters && (
            <LabelFilterBadges onRemoveLabel={handleRemoveLabel} />
          )}
          <RegistryFilterChips
            selected={filters}
            onRemove={removeFilter}
            onClearAll={clearAdvancedFilters}
          />
        </CollectionFilters>
        {selectedFacet ? (
          allFilteredItems.length === 0 ? (
            // A clean fleet is only claimable when the facet itself is empty.
            // With rows in the facet and a search or a chip that matched none of
            // them, the count on the button above is right and the list is
            // right; what is missing is the reason they disagree.
            facetCatalogIds?.size === 0 ? (
              <div className="py-8" data-testid="mcp-registry-attention-list">
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <CheckCircle2 className="text-muted-foreground" />
                    </EmptyMedia>
                    <EmptyTitle>
                      {selectedFacet === "muted"
                        ? "You have not dismissed any alerts"
                        : selectedFacet === "others"
                          ? "No alerts need action by another user"
                          : installedCatalogCount === 1
                            ? "Your installed MCP server is healthy"
                            : `All ${installedCatalogCount} installed MCP servers are healthy`}
                    </EmptyTitle>
                    <EmptyDescription>
                      {selectedFacet === "muted"
                        ? "Alerts you dismiss stay listed here, so a dismissed problem is never invisible."
                        : selectedFacet === "others"
                          ? "This view contains unresolved issues owned by someone you can identify only when your role permits it."
                          : "Servers that fail to start, stop running, or need re-authentication show up here."}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
            ) : (
              <div data-testid="mcp-registry-attention-list">
                <EmptyState
                  icon={Route}
                  title="No MCP servers match your filters"
                  onClearFilters={clearFiltersKeepingFacet}
                />
              </div>
            )
          ) : (
            <McpServerAttentionList
              // Match Guardrails: changing URL-owned filters clears selection.
              // Live issue refetches keep the component mounted so failed
              // targets survive a partial bulk action.
              key={searchParams.toString()}
              items={allFilteredItems}
              issuesByCatalog={issuesByCatalog}
              servers={installedServers ?? []}
              facet={selectedFacet}
              tableContext={{
                getServerInfo: getInstalledServerInfo,
                envLabelByCatalog,
                deploymentFeedState,
                deploymentStatuses,
                installingItemId,
                onInstall: handleTableInstall,
                onCancelInstallation: install.cancelInstallation,
              }}
              onReinstall={handleReinstall}
            />
          )
        ) : (
          <div className="space-y-6">
            {allFilteredItems.length > 0 ? (
              <McpServerCatalogSection
                items={allFilteredItems}
                getServerInfo={getInstalledServerInfo}
                envLabelByCatalog={envLabelByCatalog}
                issuesByCatalog={issuesByCatalog}
                deploymentFeedState={deploymentFeedState}
                deploymentStatuses={deploymentStatuses}
                installingItemId={installingItemId}
                onInstall={handleTableInstall}
                onReinstall={handleReinstall}
                onCancelInstallation={install.cancelInstallation}
                isBuiltInPlaywright={isPlaywrightCatalogItem}
              />
            ) : (
              <EmptyState
                icon={Route}
                title={
                  hasActiveFilters
                    ? "No MCP servers match your filters"
                    : "No MCP servers found"
                }
                onClearFilters={
                  hasActiveFilters ? handleClearFilters : undefined
                }
              />
            )}
          </div>
        )}

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
            setTargetServerTeamId(null);
            setTargetServerScope(undefined);
          }}
          onConfirm={handleRemoteServerReauthOrReinstallConfirm}
          catalogItem={selectedCatalogItem}
          isInstalling={reauthMutation.isPending || reinstallMutation.isPending}
          isReauth={!!reauthServerId}
          isReinstall={!!reinstallServerId && !reauthServerId}
          existingTeamId={targetServerTeamId}
          existingScope={targetServerScope}
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
          isReinstalling={
            reinstallMutation.isPending || reinstallCatalogMutation.isPending
          }
          targets={reinstallFlaggedTargets}
        />

        {localServerCatalogItem && (
          <LocalServerInstallDialog
            isOpen={isDialogOpened("local-install")}
            onClose={() => {
              closeDialog("local-install");
              setLocalServerCatalogItem(null);
              setReinstallServerId(null);
              setTargetServerTeamId(null);
              setTargetServerScope(undefined);
              setReauthServerId(null);
            }}
            onConfirm={handleLocalServerReauthOrReinstallConfirm}
            catalogItem={localServerCatalogItem}
            isInstalling={
              reinstallMutation.isPending || reauthMutation.isPending
            }
            isReinstall={!!reinstallServerId}
            existingTeamId={targetServerTeamId}
            existingScope={targetServerScope}
            isReauth={!!reauthServerId}
          />
        )}

        {manageCatalogItem && (
          <ManageUsersDialog
            isOpen={!!manageCatalogItem}
            onClose={closeManageDialog}
            catalogId={manageCatalogItem.id}
            onAddPersonalConnection={() => {
              install.addPersonalConnection(manageCatalogItem);
            }}
            onAddSharedConnection={(teamId) => {
              install.addSharedConnection(manageCatalogItem, teamId);
            }}
            onAddOrgConnection={() => {
              install.addOrgConnection(manageCatalogItem);
            }}
          />
        )}
      </div>
    </TableCardView>
  );
}

function replaceRegistryListUrl(url: string) {
  window.history.replaceState(null, "", url);
}

function McpServerCatalogSection({
  items,
  getServerInfo,
  envLabelByCatalog,
  issuesByCatalog,
  deploymentFeedState,
  deploymentStatuses,
  installingItemId,
  onInstall,
  onReinstall,
  onCancelInstallation,
  isBuiltInPlaywright,
}: {
  items: CatalogItem[];
  getServerInfo: (item: CatalogItem) => {
    installedServer?: InstalledServer;
    isInstallInProgress?: boolean;
    currentUserHasPersonalInstallation: boolean;
  };
  envLabelByCatalog: Map<string, string | null>;
  issuesByCatalog: Map<string, McpServerIssue[]>;
  deploymentFeedState: McpDeploymentFeedState;
  deploymentStatuses: Record<string, McpDeploymentStatusEntry>;
  installingItemId: string | null;
  onInstall: (item: CatalogItem) => void;
  onReinstall: (
    item: CatalogItem,
    flaggedInstalls?: Array<{ id: string; name: string }>,
    options?: { alsoReinstallCatalog?: boolean },
  ) => void | Promise<void>;
  onCancelInstallation: (serverId: string) => void;
  isBuiltInPlaywright: (catalogId: string) => boolean;
}) {
  const canSelect = (item: CatalogItem) => {
    const serverInfo = getServerInfo(item);
    return (
      !!serverInfo.installedServer &&
      installingItemId !== item.id &&
      !serverInfo.isInstallInProgress
    );
  };
  const filterSignature = `mcp-registry:${items
    .map((item) => item.id)
    .join(",")}`;
  const {
    rowSelection,
    setRowSelection,
    onPageRowIdsChange,
    clearSelection,
    selected,
    selectAllMatching,
    rangeSelection,
  } = useBulkSelection({
    rows: items,
    getId: (item) => item.id,
    canSelect,
    filterSignature,
    matchDescription: "match the current filters",
  });
  const selectedToUninstall = selected
    .map((item) => ({ item, server: getServerInfo(item).installedServer }))
    .filter((entry) => entry.server)
    .map(({ item, server }) => ({
      id: server?.id ?? item.id,
      name: item.name,
    }));

  // Table and cards consume the same filtered and sorted sequence. Do not add
  // a card-only priority bucket: it would override the user's active sort.
  const orderedCardItems = items;
  const [cardPagination, setCardPagination] = useState({
    pageIndex: 0,
    pageSize: 10,
  });
  const maxCardPageIndex = Math.max(
    0,
    Math.ceil(orderedCardItems.length / cardPagination.pageSize) - 1,
  );
  const cardPageIndex = Math.min(cardPagination.pageIndex, maxCardPageIndex);
  const cardPageItems = orderedCardItems.slice(
    cardPageIndex * cardPagination.pageSize,
    (cardPageIndex + 1) * cardPagination.pageSize,
  );
  const cardSelection = useBulkCardSelection({
    rows: cardPageItems,
    getRowId: (item) => item.id,
    rowSelection,
    setRowSelection,
    canSelect,
    rangeSelection,
  });
  const tablePageRowIds = useRef<string[]>([]);
  const cardPageRowIds = useRef<string[]>([]);
  const recordTablePageRowIds = useCallback((ids: string[]) => {
    tablePageRowIds.current = ids;
  }, []);
  const recordCardPageRowIds = useCallback((ids: string[]) => {
    cardPageRowIds.current = ids;
  }, []);
  const syncVisiblePageSelection = useCallback(
    (mode: "cards" | "table") => {
      // With no selection there is no page-selection affordance to update.
      // Skipping this state write keeps the view toggle a CSS-only operation.
      if (selected.length === 0) return;
      onPageRowIdsChange(
        mode === "cards" ? cardPageRowIds.current : tablePageRowIds.current,
      );
    },
    [onPageRowIdsChange, selected.length],
  );

  const renderCard = (item: CatalogItem) => {
    const serverInfo = getServerInfo(item);
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
          serverInfo.installedServer?.localInstallationStatus || undefined
        }
        deploymentStatuses={deploymentStatuses}
        deploymentFeedState={deploymentFeedState}
        issues={issuesByCatalog.get(item.id)}
        onInstallRemoteServer={() => onInstall(item)}
        onInstallLocalServer={() => onInstall(item)}
        onReinstall={(flagged, options) => onReinstall(item, flagged, options)}
        onCancelInstallation={onCancelInstallation}
        isBuiltInPlaywright={isBuiltInPlaywright(item.id)}
        selection={{
          ...cardSelection(item),
          disabled: !canSelect(item),
          disabledTooltip: !serverInfo.installedServer
            ? "Install this server before selecting it"
            : "Wait for installation to finish",
        }}
      />
    );
  };

  return (
    <div className="space-y-3">
      <McpServerBulkActions
        selected={selected}
        selectedToUninstall={selectedToUninstall}
        clearSelection={clearSelection}
        selectAllMatching={selectAllMatching}
      />
      <TableCardViewContent
        onModeChange={syncVisiblePageSelection}
        table={
          <McpServerTable
            items={items}
            getServerInfo={getServerInfo}
            envLabelByCatalog={envLabelByCatalog}
            issuesByCatalog={issuesByCatalog}
            deploymentFeedState={deploymentFeedState}
            deploymentStatuses={deploymentStatuses}
            installingItemId={installingItemId}
            onInstall={onInstall}
            onReinstall={onReinstall}
            onCancelInstallation={onCancelInstallation}
            selection={{
              rowSelection,
              onRowSelectionChange: setRowSelection,
              onPageRowIdsChange: recordTablePageRowIds,
              rangeSelection,
            }}
          />
        }
        cards={
          <TableCardSelectionScope
            rowIds={cardPageItems.filter(canSelect).map((item) => item.id)}
            onVisibleRowIdsChange={recordCardPageRowIds}
          >
            <div className="space-y-4">
              <TableCardGrid>{cardPageItems.map(renderCard)}</TableCardGrid>
              {orderedCardItems.length > cardPagination.pageSize ? (
                <TablePagination
                  pageIndex={cardPageIndex}
                  pageSize={cardPagination.pageSize}
                  total={orderedCardItems.length}
                  onPaginationChange={setCardPagination}
                />
              ) : null}
            </div>
          </TableCardSelectionScope>
        }
      />
    </div>
  );
}

function McpServerBulkActions({
  selected,
  selectedToUninstall,
  clearSelection,
  selectAllMatching,
}: {
  selected: readonly CatalogItem[];
  selectedToUninstall: Array<{ id: string; name: string }>;
  clearSelection: () => void;
  selectAllMatching: SelectAllMatching;
}) {
  const [bulkUninstallOpen, setBulkUninstallOpen] = useState(false);
  const bulkUninstall = useBulkUninstallMcpServers();

  return (
    <>
      <BulkActions
        count={selected.length}
        noun="server"
        onClear={clearSelection}
        busy={bulkUninstall.isPending}
        selectAllMatching={selectAllMatching}
      >
        <PermissionButton
          permissions={{ mcpServerInstallation: ["delete"] }}
          variant="destructive"
          size="sm"
          disabled={selectedToUninstall.length === 0}
          tooltip={
            selectedToUninstall.length === 0
              ? "None of the selected servers are installed."
              : undefined
          }
          onClick={() => setBulkUninstallOpen(true)}
        >
          <Trash2 className="h-4 w-4" />
          <span>
            Uninstall
            {countSuffix(selectedToUninstall.length, selected.length)}
          </span>
        </PermissionButton>
      </BulkActions>

      {bulkUninstallOpen && (
        <DeleteConfirmDialog
          open={bulkUninstallOpen}
          onOpenChange={setBulkUninstallOpen}
          title="Uninstall MCP servers"
          description={`Uninstall ${selectedToUninstall.length} ${
            selectedToUninstall.length === 1 ? "server" : "servers"
          }? Agents using their tools lose access.`}
          isPending={bulkUninstall.isPending}
          onConfirm={() => {
            bulkUninstall.mutate(selectedToUninstall, {
              onSuccess: (outcome) => {
                reportBulkOutcome({
                  outcome,
                  verb: "Uninstalled",
                  failureVerb: "uninstall",
                  noun: "server",
                });
                setBulkUninstallOpen(false);
                if (outcome.failed.length === 0) clearSelection();
              },
            });
          }}
          confirmLabel="Uninstall servers"
          pendingLabel="Uninstalling..."
        />
      )}
    </>
  );
}

/**
 * The start of the oldest issue on an item, or null when none of them records
 * one. Only re-authentication failures carry a timestamp today.
 */
function oldestIssueTime(issues: McpServerIssue[] | undefined): number | null {
  let oldest: number | null = null;
  for (const issue of issues ?? []) {
    if (!issue.since) continue;
    const at = new Date(issue.since).getTime();
    if (Number.isNaN(at)) continue;
    if (oldest === null || at < oldest) oldest = at;
  }
  return oldest;
}

function McpCatalogLabelFilter({ active }: { active: boolean }) {
  const { data: labelKeys } = useMcpCatalogLabelKeys();
  return (
    <LabelSelect
      labelKeys={labelKeys}
      LabelKeyRowComponent={McpCatalogLabelKeyRow}
      className={filterControlClass({ active })}
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

function countSuffix(applicable: number, selected: number): string {
  return applicable > 0 && applicable < selected ? ` (${applicable})` : "";
}

function aggregateInstallations(
  servers: InstalledServer[],
  currentUserId: string | undefined,
): InstalledServer {
  if (servers.length === 1) return servers[0];

  const baseServer = [...servers].sort(
    (a, b) =>
      mcpRegistryInstallPriority(a, currentUserId) -
      mcpRegistryInstallPriority(b, currentUserId),
  )[0];
  const aggregated = { ...baseServer };
  const allUsers = new Set<string>();
  const allUserDetails: Array<{
    userId: string;
    email: string;
    createdAt: string;
    serverId: string;
  }> = [];

  for (const server of servers) {
    for (const userId of server.users ?? []) allUsers.add(userId);
    for (const userDetail of server.userDetails ?? []) {
      if (
        !allUserDetails.some((detail) => detail.userId === userDetail.userId)
      ) {
        allUserDetails.push({ ...userDetail, serverId: server.id });
      }
    }
  }

  aggregated.users = [...allUsers];
  aggregated.userDetails = allUserDetails;
  return aggregated;
}
