"use client";

import {
  ARCHESTRA_MCP_CATALOG_ID,
  isPlaywrightCatalogItem,
  MCP_CATALOG_REAUTH_QUERY_PARAM,
  MCP_CATALOG_SERVER_QUERY_PARAM,
  type McpDeploymentStatusEntry,
} from "@archestra/shared";
import { useQueryClient } from "@tanstack/react-query";
import type { OnChangeFn, RowSelectionState } from "@tanstack/react-table";
import { AlertTriangle, CheckCircle2, Route, Trash2 } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { OAuthConfirmationDialog } from "@/components/oauth-confirmation-dialog";
import {
  RESOURCE_ACCESS_FILTER_PARAMS,
  ResourceAccessFilter,
} from "@/components/resource-access-filter";
import { useScopeFilterParams } from "@/components/resource-scope-filter";
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
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
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
import { useControlledRowSelection } from "@/lib/hooks/use-bulk-selection";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { useDialogs } from "@/lib/hooks/use-dialog";
import { useDialogUrlParam } from "@/lib/hooks/use-dialog-url-param";
import {
  useMcpCatalogLabelKeys,
  useMcpCatalogLabelValues,
  useReinstallInternalMcpCatalogItem,
} from "@/lib/mcp/internal-mcp-catalog.query";
import {
  fetchInternalMcpCatalogItem,
  type McpRegistryListQuery,
  useInternalMcpCatalogItem,
  useMcpRegistryIssueIndex,
  useMcpRegistryMatchingIds,
  useMcpRegistryPage,
  useMcpServersForCatalogs,
} from "@/lib/mcp/mcp-registry.query";
import {
  type McpDeploymentFeedState,
  useBulkUninstallMcpServers,
  useMcpDeploymentStatuses,
  useMcpInstallationStatusCacheSync,
  useReauthenticateMcpServer,
  useReinstallMcpServer,
} from "@/lib/mcp/mcp-server.query";
import {
  attentionCatalogIds,
  attentionRankTiers,
  type McpServerAttentionFacet,
  type McpServerIssue,
} from "@/lib/mcp/mcp-server-issues";
import { buildRemoteInstallCredentialPayload } from "@/lib/mcp/remote-install-payload";
import { useCanReauthenticateInputsReady } from "@/lib/mcp/use-can-reauthenticate";
import { useMcpServerIssues } from "@/lib/mcp/use-mcp-server-issues";
import { resolveCatalogEnvironmentLabel } from "./catalog-environment-label";
import {
  LocalServerInstallDialog,
  type LocalServerInstallResult,
} from "./local-server-install-dialog";
import { ManageUsersDialog } from "./manage-users-dialog";
import { mcpRegistryInstallPriority } from "./mcp-registry-visibility";
import { McpServerAttentionList } from "./mcp-server-attention-list";
import {
  type CatalogItem,
  type InstalledServer,
  McpServerCard,
  type RegistryListItem,
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
import { MCP_REGISTRY_VIEW_STORAGE_KEY } from "./registry-list-params";
import {
  buildRegistryListQuery,
  MAX_REGISTRY_SEARCH_LENGTH,
  registryPageFromParams,
  registryQueryInputs,
  sameRankTiers,
  sortKeyFromParams,
  sortParamsForKey,
  withoutOrder,
} from "./registry-list-query";
import { RegistryPageServersProvider } from "./registry-page-servers";
import { ReinstallConfirmationDialog } from "./reinstall-confirmation-dialog";
import { decideReinstallDialog } from "./reinstall-dialog-decision";
import {
  RemoteServerInstallDialog,
  type RemoteServerInstallResult,
} from "./remote-server-install-dialog";
import type { McpServerInstallScope } from "./select-mcp-server-credential-type-and-teams";
import { useCatalogInstall } from "./use-catalog-install";

/** The pause in typing after which the registry asks the server. */
const REGISTRY_SEARCH_DEBOUNCE_MS = 300;

export function InternalMCPCatalog() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const ownershipFilters = useScopeFilterParams();

  // Get search query from URL
  const searchQueryFromUrl = searchParams.get("search") || "";
  // The box writes every keystroke to the URL, as it always did, so the rows
  // on screen narrow at once (below). The server is asked once typing pauses.
  const requestSearch = useDebouncedValue(
    searchQueryFromUrl,
    REGISTRY_SEARCH_DEBOUNCE_MS,
  );
  const listSearchParams = useMemo(() => {
    if (requestSearch === searchQueryFromUrl) return searchParams;
    const params = new URLSearchParams(searchParams.toString());
    if (requestSearch.trim()) {
      params.set("search", requestSearch);
    } else {
      params.delete("search");
    }
    return params;
  }, [searchParams, requestSearch, searchQueryFromUrl]);
  const { pageIndex, pageSize } = registryPageFromParams(searchParams);
  const sort = sortKeyFromParams(searchParams);

  // Every visible item and install, reduced to what the issue rule, the
  // facet counts and the Environment/Author options read.
  const { data: issueIndex, isError: isIssueIndexError } =
    useMcpRegistryIssueIndex();
  const indexServers = issueIndex?.servers;
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

  // The order lives in the URL with the filters, as the API's sortBy and
  // sortDirection, so a shared link reopens the same page.
  const setSort = useCallback(
    (key: SortKey) => {
      const params = new URLSearchParams(searchParams.toString());
      const { sortBy, sortDirection } = sortParamsForKey(key);
      params.set("sortBy", sortBy);
      params.set("sortDirection", sortDirection);
      params.delete("page");
      replaceRegistryListUrl(`${pathname}?${params.toString()}`);
    },
    [searchParams, pathname],
  );
  const sortOptions = SORT_OPTIONS;
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
      params.delete("page");
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
  // The item may sit on any page, so it is loaded by id.
  const manageUsersIdFromUrl = searchParams.get("manageUsers");
  const { data: manageCatalogItemFromUrl = null } =
    useInternalMcpCatalogItem(manageUsersIdFromUrl);
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
      params.delete("page");
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

  const { data: userIsMcpServerAdmin } = useHasPermissions(
    { mcpRegistry: ["update"] },
    "*",
  );

  // Deep-link: auto-open install dialog when ?install={catalogId} is present.
  // Optional &scope=personal|team|org (and &team={teamId} for team scope)
  // pre-target the connection — used by the item detail page's add-connection
  // actions. Owned by the shared install hook.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only trigger on searchParams changes, installFromSearchParams is a stable callback
  useEffect(() => {
    install.installFromSearchParams();
  }, [searchParams]);

  // Deep-link: handle ?reauth={catalogId} with optional ?server={serverId}.
  // With a server, go straight to re-authentication (preserves tool
  // assignments). Without one, hand off to the manage-connections dialog by
  // writing ?manageUsers={catalogId}; its URL-param hook auto-opens once the
  // catalog loads. router.replace propagates the rewrite to useSearchParams
  // (Next integrates history updates with the router), so the hook sees the
  // param; deleting the reauth param first makes the re-fired effect
  // early-return instead of looping.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run only on searchParams and issue-index changes; router/pathname are stable and handleDeepLinkReauth is a stable closure
  useEffect(() => {
    const reauthCatalogIdParam = searchParams.get(
      MCP_CATALOG_REAUTH_QUERY_PARAM,
    );
    if (!reauthCatalogIdParam) return;

    // Extract highlight param before clearing URL
    const serverIdParam = searchParams.get(MCP_CATALOG_SERVER_QUERY_PARAM);
    // The highlighted connection's scope and team come from the issue index;
    // resolving before it loads would open a team connection as Personal.
    if (serverIdParam && !issueIndex && !isIssueIndexError) return;

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
      void handleDeepLinkReauth(
        reauthCatalogIdParam,
        serverIdParam,
        issueIndex?.servers.find((server) => server.id === serverIdParam),
      );
    }
  }, [searchParams, issueIndex, isIssueIndexError]);

  // Called to re-authenticate a highlighted credential in-place (preserves tool assignments)
  const handleDeepLinkReauth = async (
    catalogId: string,
    serverId: string,
    targetServer: { teamId: string | null; scope: string } | undefined,
  ) => {
    const catalogItem = await fetchInternalMcpCatalogItem(
      queryClient,
      catalogId,
    );
    if (!catalogItem) return;

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
  const handleReauthOAuthConfirm = async () => {
    if (!selectedCatalogItem) return;

    try {
      const { authorizationUrl, state } =
        await initiateOAuthMutation.mutateAsync({
          catalogId: selectedCatalogItem.id,
        });

      setOAuthState(state);
      setOAuthCatalogId(selectedCatalogItem.id);
      const scope =
        targetServerScope ?? (targetServerTeamId ? "team" : "personal");
      setOAuthTeamId(scope === "team" ? targetServerTeamId : null);
      setOAuthScope(scope);

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
      // The ids and names captured when the reinstall started: the row may
      // have moved off this page (a live re-rank) since.
      const targets =
        reinstallFlaggedTargets.length > 0
          ? reinstallFlaggedTargets
          : [{ id: reinstallServerId, name: localServerCatalogItem.name }];

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
      const target = reinstallFlaggedTargets.find(
        (t) => t.id === reinstallServerId,
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
    const targets: Array<{ id: string; name: string }> =
      reinstallFlaggedTargets.length > 0
        ? reinstallFlaggedTargets
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

  const labelsParam = searchParams.get("labels");
  const parsedLabels = useMemo(
    () => parseLabelsParam(labelsParam),
    [labelsParam],
  );

  // Outstanding issues per catalog item, from the same signals every registry
  // surface renders. This feeds the audience facets, Issue filter and table.
  const { issuesByCatalog, facetCounts } =
    useMcpServerIssues(deploymentStatuses);
  const selectedFacet = selectedAttentionFacet(filters.status);
  useEffect(() => {
    if (userIsMcpServerAdmin && selectedFacet === "others") {
      selectFacet("you");
    }
  }, [userIsMcpServerAdmin, selectedFacet, selectFacet]);
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

  // The server ranks the attention order itself, from the same rule over the
  // same signals, so the first page does not wait for the issue index. Once
  // the browser holds the index and the live feed, it checks the server's
  // ranking against its own and, if they ever disagree (a feed push the
  // server's copy had not seen), sends its live tiers from then on.
  const liveAttentionTiers = useMemo(
    () => attentionRankTiers(issuesByCatalog),
    [issuesByCatalog],
  );
  // Comparable only once every input of the live rule is real: the index,
  // a connected feed (a disabled or dropped one holds no statuses, so its
  // tiers would lack every runtime fault), and the viewer's teams and rights.
  const reauthInputsReady = useCanReauthenticateInputsReady();
  const liveTiersReady =
    !!issueIndex && deploymentFeedState === "ready" && reauthInputsReady;
  const [sendLiveAttentionTiers, setSendLiveAttentionTiers] = useState(false);

  // Everything that narrows and orders the list, with the page left out: the
  // visible page and "every matching row" differ only by limit and offset.
  const environments = environmentList?.environments;
  const listQuery = useMemo(
    () =>
      buildRegistryListQuery({
        searchParams: listSearchParams,
        access: {
          access: ownershipFilters.access,
          sharedWith: ownershipFilters.sharedWith,
          owner: ownershipFilters.owner,
        },
        environments: environments ?? [],
        authors: issueIndex?.catalogItems ?? [],
        issuesByCatalog,
        attentionTiers: sendLiveAttentionTiers ? liveAttentionTiers : undefined,
      }),
    [
      listSearchParams,
      ownershipFilters.access,
      ownershipFilters.sharedWith,
      ownershipFilters.owner,
      environments,
      issueIndex,
      issuesByCatalog,
      sendLiveAttentionTiers,
      liveAttentionTiers,
    ],
  );
  // Hold the request until everything the URL's names and facets map
  // through has loaded: an environment filter sent before the environments
  // arrive, or a facet before the first deployment-feed push, would ask for
  // the wrong rows (and the page clamp below would act on them).
  const { needsEnvironments, needsIssueIndex, needsIssues } =
    registryQueryInputs(searchParams);
  const queryInputsReady =
    (!needsIssueIndex || !!issueIndex || isIssueIndexError) &&
    (!needsEnvironments || environmentList !== undefined) &&
    (!needsIssues || deploymentFeedState !== "loading");
  const {
    data: registryPage,
    isPlaceholderData: isPagePlaceholder,
    isError: isPageError,
    isFetching: isPageFetching,
    refetch: refetchPage,
  } = useMcpRegistryPage(
    { ...listQuery, limit: pageSize, offset: pageIndex * pageSize },
    {
      enabled: queryInputsReady,
      placeholderScope: selectedFacet ?? "all",
    },
  );
  const serverAttentionTiers = registryPage?.attentionTiers;
  useEffect(() => {
    if (
      !sendLiveAttentionTiers &&
      liveTiersReady &&
      serverAttentionTiers &&
      !sameRankTiers(serverAttentionTiers, liveAttentionTiers)
    ) {
      setSendLiveAttentionTiers(true);
    }
  }, [
    sendLiveAttentionTiers,
    liveTiersReady,
    serverAttentionTiers,
    liveAttentionTiers,
  ]);
  const pageItems = registryPage?.data ?? [];
  // While a search settles (the pause before the request, then the request
  // itself), the rows already on screen narrow by name at once, with the
  // same match the server applies; the server's page replaces them when it
  // answers. Only what is drawn narrows: installs and labels still follow
  // the page, so a keystroke sends nothing.
  const typedSearch = searchQueryFromUrl.trim().toLowerCase();
  const searchSettling =
    requestSearch !== searchQueryFromUrl || isPagePlaceholder;
  const visibleItems = useMemo(
    () =>
      searchSettling && typedSearch
        ? pageItems.filter((item) =>
            item.name.toLowerCase().includes(typedSearch),
          )
        : pageItems,
    [pageItems, searchSettling, typedSearch],
  );
  const totalItems = registryPage?.pagination.total ?? 0;

  const handlePaginationChange = useCallback(
    (next: { pageIndex: number; pageSize: number }) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("page", String(next.pageIndex + 1));
      params.set("pageSize", String(next.pageSize));
      replaceRegistryListUrl(`${pathname}?${params.toString()}`);
    },
    [searchParams, pathname],
  );
  // A filter, an uninstall or another session can shrink the list under a
  // later page; land on the last page that still exists.
  // Only from a result for exactly this request: a placeholder still holds
  // the previous request's total.
  useEffect(() => {
    if (!registryPage || isPagePlaceholder || !queryInputsReady) return;
    const lastPageIndex = Math.max(0, Math.ceil(totalItems / pageSize) - 1);
    if (pageIndex > lastPageIndex) {
      handlePaginationChange({ pageIndex: lastPageIndex, pageSize });
    }
  }, [
    registryPage,
    isPagePlaceholder,
    queryInputsReady,
    totalItems,
    pageSize,
    pageIndex,
    handlePaginationChange,
  ]);

  // The installs of the items on this page, and nothing else.
  const { data: installedServers } = useMcpServersForCatalogs(
    pageItems.map((item) => item.id),
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
  const envLabelByCatalog = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const it of pageItems) {
      map.set(
        it.id,
        it.serverType === "builtin"
          ? null
          : (resolveCatalogEnvironmentLabel({
              environmentId: it.environmentId,
              environments: environments ?? [],
            }) ?? null),
      );
    }
    return map;
  }, [pageItems, environments]);

  // Filter options span every visible item, not just this page, so they come
  // from the issue index. Values stay names, as links have always used them.
  const environmentOptions: FilterOption[] = useMemo(() => {
    const set = new Set<string>();
    for (const it of issueIndex?.catalogItems ?? []) {
      if (it.serverType === "builtin" || it.id === ARCHESTRA_MCP_CATALOG_ID)
        continue;
      const label = resolveCatalogEnvironmentLabel({
        environmentId: it.environmentId,
        environments: environments ?? [],
      });
      if (label) set.add(label);
    }
    return [...set].sort().map((value) => ({ value, label: value }));
  }, [issueIndex, environments]);
  const authorOptions: FilterOption[] = useMemo(() => {
    const set = new Set<string>();
    for (const it of issueIndex?.catalogItems ?? []) {
      if (it.id === ARCHESTRA_MCP_CATALOG_ID) continue;
      if (it.authorName) set.add(it.authorName);
    }
    return [...set].sort().map((value) => ({ value, label: value }));
  }, [issueIndex]);

  // Load the full item (configuration included) for a flow the row starts.
  const withFullItem =
    <Args extends unknown[]>(
      action: (item: CatalogItem, ...args: Args) => unknown,
    ) =>
    async (row: RegistryListItem, ...args: Args) => {
      const item = await fetchInternalMcpCatalogItem(queryClient, row.id);
      if (item) await action(item, ...args);
    };
  const handleRowReinstall = withFullItem(handleReinstall);

  function getInstalledServerInfo(item: RegistryListItem) {
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
  const handleTableInstall = withFullItem((item: CatalogItem) => {
    if (item.serverType === "remote") return install.installRemote(item);
    if (isPlaywrightCatalogItem(item.id)) return;
    return install.installLocal(item);
  });

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
      params.delete("page");
      replaceRegistryListUrl(`${pathname}?${params.toString()}`);
    },
    [parsedLabels, searchParams, pathname],
  );

  const handleClearFilters = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("search");
    params.delete("labels");
    params.delete("page");
    replaceRegistryListUrl(`${pathname}?${params.toString()}`);
  }, [searchParams, pathname]);

  // Everything except the facet. Offered when a facet is selected and the
  // other filters have emptied it: the reader asked "what needs my action",
  // so the way out is to drop the search and the chips, not the question.
  const clearFiltersKeepingFacet = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("search");
    params.delete("labels");
    params.delete("page");
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
    params.delete("page");
    for (const group of FILTER_GROUPS) params.delete(group);
    for (const group of [
      "scope",
      "teamIds",
      "authorIds",
      "excludeAuthorIds",
      ...RESOURCE_ACCESS_FILTER_PARAMS,
    ]) {
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
    (indexServers ?? [])
      .map((server) => server.catalogId)
      .filter((id): id is string => !!id && id !== ARCHESTRA_MCP_CATALOG_ID),
  ).size;

  return (
    <TableCardView
      storageKey={MCP_REGISTRY_VIEW_STORAGE_KEY}
      defaultMode="table"
    >
      <RegistryPageServersProvider servers={installedServers}>
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
                  {!selectedFacet && <TableCardViewToggle />}
                </>
              }
              search={
                <SearchInput
                  objectNamePlural="MCP servers"
                  searchFields={["name"]}
                  value={searchQueryFromUrl}
                  onSearchChange={handleSearchChange}
                  syncQueryParams={false}
                  debounceMs={0}
                  maxLength={MAX_REGISTRY_SEARCH_LENGTH}
                  isLoading={isPageFetching}
                  className={filterSearchClass}
                  inputClassName="w-full bg-background/50 backdrop-blur-sm border-border/50 focus:border-primary/50 transition-colors pl-9"
                />
              }
            >
              <ResourceAccessFilter
                resource="mcpRegistry"
                noun="MCP servers"
                navigate={replaceRegistryListUrl}
              />
              <McpCatalogLabelFilter active={Boolean(hasLabelFilters)} />

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
          {!registryPage ? (
            // The shell stays: a refused or failed request must not take the
            // search box and filters with it, or nobody could undo it.
            isPageError ? (
              <InlineNotice variant="error">
                <AlertTriangle />
                <span className="font-medium">
                  MCP servers could not be loaded
                </span>
                <InlineNoticeText>
                  Change the filters or try again.
                </InlineNoticeText>
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto"
                  onClick={() => void refetchPage()}
                >
                  Try again
                </Button>
              </InlineNotice>
            ) : null
          ) : selectedFacet ? (
            visibleItems.length === 0 ? (
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
                key={attentionListKey(listSearchParams)}
                items={visibleItems}
                issuesByCatalog={issuesByCatalog}
                servers={installedServers ?? []}
                facet={selectedFacet}
                pagination={{ pageIndex, pageSize, total: totalItems }}
                onPaginationChange={handlePaginationChange}
                tableContext={{
                  getServerInfo: getInstalledServerInfo,
                  envLabelByCatalog,
                  deploymentFeedState,
                  deploymentStatuses,
                  installingItemId,
                  onInstall: handleTableInstall,
                  onCancelInstallation: install.cancelInstallation,
                }}
                onReinstall={handleRowReinstall}
              />
            )
          ) : (
            <div className="space-y-6">
              {visibleItems.length > 0 ? (
                <McpServerCatalogSection
                  items={visibleItems}
                  listQuery={listQuery}
                  selectableTotal={registryPage.selectableTotal}
                  pagination={{ pageIndex, pageSize, total: totalItems }}
                  onPaginationChange={handlePaginationChange}
                  getServerInfo={getInstalledServerInfo}
                  envLabelByCatalog={envLabelByCatalog}
                  issuesByCatalog={issuesByCatalog}
                  deploymentFeedState={deploymentFeedState}
                  deploymentStatuses={deploymentStatuses}
                  installingItemId={installingItemId}
                  onInstall={handleTableInstall}
                  onReinstall={handleRowReinstall}
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
            isInstalling={
              reauthMutation.isPending || reinstallMutation.isPending
            }
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
            isReauth
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
      </RegistryPageServersProvider>
    </TableCardView>
  );
}

/**
 * Changing a URL-owned filter remounts the attention list and clears its
 * selection; paging does not remount it (it clears its own selection then).
 */
function attentionListKey(
  searchParams: URLSearchParams | { toString(): string },
) {
  const params = new URLSearchParams(searchParams.toString());
  params.delete("page");
  params.delete("pageSize");
  return params.toString();
}

/** The page's own selection state already knows which rows are on screen. */
function noopPageRowIds(_ids: string[]) {}

function replaceRegistryListUrl(url: string) {
  window.history.replaceState(null, "", url);
}

function McpServerCatalogSection({
  items,
  listQuery,
  selectableTotal,
  pagination,
  onPaginationChange,
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
  /** The current page. */
  items: RegistryListItem[];
  /** The list's filters and order, for selecting every matching row. */
  listQuery: McpRegistryListQuery;
  selectableTotal: number;
  pagination: { pageIndex: number; pageSize: number; total: number };
  onPaginationChange: (next: { pageIndex: number; pageSize: number }) => void;
  getServerInfo: (item: RegistryListItem) => {
    installedServer?: InstalledServer;
    isInstallInProgress?: boolean;
    currentUserHasPersonalInstallation: boolean;
  };
  envLabelByCatalog: Map<string, string | null>;
  issuesByCatalog: Map<string, McpServerIssue[]>;
  deploymentFeedState: McpDeploymentFeedState;
  deploymentStatuses: Record<string, McpDeploymentStatusEntry>;
  installingItemId: string | null;
  onInstall: (item: RegistryListItem) => void;
  onReinstall: (
    item: RegistryListItem,
    flaggedInstalls?: Array<{ id: string; name: string }>,
    options?: { alsoReinstallCatalog?: boolean },
  ) => void | Promise<void>;
  onCancelInstallation: (serverId: string) => void;
  isBuiltInPlaywright: (catalogId: string) => boolean;
}) {
  const canSelect = (item: RegistryListItem) => {
    if (isBuiltInPlaywright(item.id)) return false;
    const serverInfo = getServerInfo(item);
    return (
      item.install.visibleCount > 0 &&
      installingItemId !== item.id &&
      !serverInfo.isInstallInProgress
    );
  };
  /**
   * Selections are remembered for the filters they were made under, so a
   * filter change drops them rather than re-pointing "all 40" at a different
   * 40. The order is left out: a live re-rank must not cancel a selection.
   */
  const matchQuery = withoutOrder(listQuery);
  const filterSignature = `mcp-registry:${JSON.stringify(matchQuery)}`;
  const [escalatedFor, setEscalatedFor] = useState<string | null>(null);
  const allMatchingSelected = escalatedFor === filterSignature;
  const {
    data: allMatching,
    isFetching: isAllMatchingFetching,
    isError: isAllMatchingError,
  } = useMcpRegistryMatchingIds(matchQuery, { enabled: allMatchingSelected });

  // Rows ticked on one page stay selected, and counted, on the next. Each
  // keeps the name and install it was selected with, so the action does not
  // depend on the page it was ticked on still being loaded.
  const [selectedRows, setSelectedRows] = useState<
    ReadonlyMap<string, { id: string; name: string; serverId: string | null }>
  >(new Map());
  const [selectionSignature, setSelectionSignature] = useState(filterSignature);
  if (selectionSignature !== filterSignature) {
    setSelectionSignature(filterSignature);
    setSelectedRows(new Map());
  }
  const storedRowSelection: RowSelectionState = Object.fromEntries(
    [...selectedRows.keys()].map((id) => [id, true]),
  );
  const setStoredRowSelection: OnChangeFn<RowSelectionState> = (updater) => {
    setSelectedRows((current) => {
      const currentSelection = Object.fromEntries(
        [...current.keys()].map((id) => [id, true]),
      );
      const nextSelection =
        typeof updater === "function" ? updater(currentSelection) : updater;
      const next = new Map<
        string,
        { id: string; name: string; serverId: string | null }
      >();
      for (const [id, isSelected] of Object.entries(nextSelection)) {
        if (!isSelected) continue;
        const kept = current.get(id);
        if (kept) {
          next.set(id, kept);
          continue;
        }
        const item = items.find((row) => row.id === id);
        if (!item || !canSelect(item)) continue;
        next.set(id, {
          id,
          name: item.name,
          serverId:
            getServerInfo(item).installedServer?.id ??
            item.install.primaryServerId,
        });
      }
      return next;
    });
  };
  const clearEscalation = useCallback(() => setEscalatedFor(null), []);
  const { effectiveRowSelection, onRowSelectionChange, rangeSelection } =
    useControlledRowSelection({
      rowSelection: storedRowSelection,
      setRowSelection: setStoredRowSelection,
      rows: items,
      getRowId: (item) => item.id,
      canSelect,
      allMatchingSelected,
      clearEscalation,
    });
  const clearSelection = () => {
    setSelectedRows(new Map());
    setEscalatedFor(null);
  };
  const selectedToUninstall = allMatchingSelected
    ? (allMatching?.data ?? [])
        .filter((row) => !isBuiltInPlaywright(row.id))
        .map((row) => ({ id: row.primaryServerId, name: row.name }))
    : [...selectedRows.values()].flatMap((row) =>
        row.serverId && !isBuiltInPlaywright(row.id)
          ? [{ id: row.serverId, name: row.name }]
          : [],
      );
  const selectedCount = allMatchingSelected
    ? (allMatching?.data.length ?? selectableTotal)
    : selectedRows.size;
  const pageSelectableIds = items.filter(canSelect).map((item) => item.id);
  const selectAllMatching: SelectAllMatching = {
    total: selectableTotal,
    pageFullySelected:
      pageSelectableIds.length > 0 &&
      pageSelectableIds.every((id) => effectiveRowSelection[id]),
    active: allMatchingSelected,
    onSelectAll: () => setEscalatedFor(filterSignature),
    matchDescription: "match the current filters",
  };

  const cardSelection = useBulkCardSelection({
    rows: items,
    getRowId: (item) => item.id,
    rowSelection: effectiveRowSelection,
    setRowSelection: onRowSelectionChange,
    canSelect,
    rangeSelection,
  });

  const renderCard = (item: RegistryListItem) => {
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
          disabledTooltip:
            item.install.visibleCount === 0
              ? "Install this server before selecting it"
              : "Wait for installation to finish",
        }}
      />
    );
  };

  return (
    <div className="space-y-3">
      <McpServerBulkActions
        count={selectedCount}
        selectedToUninstall={selectedToUninstall}
        clearSelection={clearSelection}
        busy={
          allMatchingSelected && (isAllMatchingFetching || isAllMatchingError)
        }
        selectAllMatching={selectAllMatching}
      />
      <TableCardViewContent
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
            pagination={pagination}
            onPaginationChange={onPaginationChange}
            selection={{
              rowSelection: effectiveRowSelection,
              onRowSelectionChange,
              onPageRowIdsChange: noopPageRowIds,
              rangeSelection,
            }}
          />
        }
        cards={
          <TableCardSelectionScope
            rowIds={pageSelectableIds}
            onVisibleRowIdsChange={noopPageRowIds}
          >
            <div className="space-y-4">
              <TableCardGrid>{items.map(renderCard)}</TableCardGrid>
              {pagination.total > pagination.pageSize ? (
                <TablePagination
                  pageIndex={pagination.pageIndex}
                  pageSize={pagination.pageSize}
                  total={pagination.total}
                  onPaginationChange={onPaginationChange}
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
  count,
  selectedToUninstall,
  clearSelection,
  busy,
  selectAllMatching,
}: {
  count: number;
  selectedToUninstall: Array<{ id: string; name: string }>;
  clearSelection: () => void;
  busy: boolean;
  selectAllMatching: SelectAllMatching;
}) {
  const [bulkUninstallOpen, setBulkUninstallOpen] = useState(false);
  const bulkUninstall = useBulkUninstallMcpServers();

  return (
    <>
      <BulkActions
        count={count}
        noun="server"
        onClear={clearSelection}
        busy={busy || bulkUninstall.isPending}
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
            {countSuffix(selectedToUninstall.length, count)}
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
