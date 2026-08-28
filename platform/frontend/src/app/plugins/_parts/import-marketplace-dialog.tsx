"use client";

import {
  PLUGIN_MARKETPLACE_IMPORT_LIMIT,
  POPULAR_PLUGIN_MARKETPLACES,
  type ResourceVisibilityScope,
} from "@archestra/shared";
import type { RowSelectionState } from "@tanstack/react-table";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Eye,
  Loader2,
  PackageSearch,
  SearchX,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ConnectionClientMultiSelect } from "@/app/connection/client-multi-select";
import { CONNECT_CLIENTS, type ConnectClient } from "@/app/connection/clients";
import {
  CONNECT_PLATFORM_OPTIONS,
  type ConnectPlatformOption,
} from "@/app/connection/platform.utils";
import { ConnectionPlatformMultiSelect } from "@/app/connection/platform-select";
import {
  GithubAuthConfigFields,
  type GithubAuthMethod,
} from "@/components/github-auth-config-fields";
import { SearchInput } from "@/components/search-input";
import { StandardDialog } from "@/components/standard-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SecretInput } from "@/components/ui/secret-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BulkRangeSelectionController } from "@/lib/bulk-range-selection";
import { useGithubAppConfigs } from "@/lib/github-app-config.query";
import { useCreateGithubPat, useGithubPats } from "@/lib/github-pat.query";
import {
  type GithubPluginMarketplace,
  useDiscoverGithubPluginMarketplace,
  useImportGithubPluginMarketplace,
  usePlugins,
  usePreviewGithubPlugin,
} from "@/lib/plugins/plugin.query";
import { cn } from "@/lib/utils";
import { PluginClientIcon } from "./plugin-client-icon";
import { PluginPreviewDialog } from "./plugin-preview-dialog";
import { PluginScopeSelector } from "./plugin-scope-selector";

type MarketplaceEntry = GithubPluginMarketplace["entries"][number];

const CLIENT_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  "copilot-cli": "Copilot CLI",
  codex: "Codex",
  cursor: "Cursor",
};

/**
 * The marketplace import dialog: point at a GitHub repository with a plugin
 * marketplace manifest, pick which of its plugins to add, and import them all
 * pinned to the reviewed commit. Mirrors the skills import dialog — repository
 * URL, pull schedule and visibility up front, authentication and the tracked
 * ref behind the fold; discovery swaps the form for a selectable entry list.
 */
export function ImportMarketplaceDialog({
  open,
  onOpenChange,
  onImported,
  initialRepoUrl = "",
  autoDiscover = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported?: () => void;
  initialRepoUrl?: string;
  autoDiscover?: boolean;
}) {
  const discover = useDiscoverGithubPluginMarketplace();
  const importMarketplace = useImportGithubPluginMarketplace();
  const { data: githubAppConfigs = [] } = useGithubAppConfigs();
  const { data: githubPats = [] } = useGithubPats();
  const createPat = useCreateGithubPat();
  const previewPlugin = usePreviewGithubPlugin();
  const { data: existingPlugins = [] } = usePlugins();

  const [repoUrl, setRepoUrl] = useState(initialRepoUrl);
  const [ref, setRef] = useState("");
  const [authMethod, setAuthMethod] = useState<GithubAuthMethod>("pat");
  const [githubToken, setGithubToken] = useState("");
  // "" = paste a one-time token; otherwise the id of a saved token
  const [githubPatId, setGithubPatId] = useState("");
  const [githubAppConfigId, setGithubAppConfigId] = useState("");
  const [marketplace, setMarketplace] =
    useState<GithubPluginMarketplace | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const rangeSelection = useRef(new BulkRangeSelectionController()).current;
  const [search, setSearch] = useState("");
  const [previewEntry, setPreviewEntry] = useState<MarketplaceEntry | null>(
    null,
  );
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  // scope applies to every plugin selected in this import
  const [scope, setScope] = useState<ResourceVisibilityScope>("personal");
  const [teamIds, setTeamIds] = useState<string[]>([]);
  // people every plugin in this import is shared with directly
  const [userIds, setUserIds] = useState<string[]>([]);
  // check cadence for every plugin selected in this import: new commits become
  // review candidates and never replace approved bytes automatically.
  const [syncInterval, setSyncInterval] = useState<"15m" | "1h" | "1d">("1d");
  // Generic marketplaces do not declare setup OS compatibility. Curated
  // marketplaces can narrow the available targets when compatibility is known.
  const [platforms, setPlatforms] = useState<ConnectPlatformOption[]>(() => [
    ...CONNECT_PLATFORM_OPTIONS,
  ]);
  const [clients, setClients] = useState<ConnectClient[]>([]);
  // name under which a newly pasted token is saved (Settings -> GitHub)
  const [newTokenName, setNewTokenName] = useState("");
  // ref + authentication live behind this fold; opened automatically when a
  // discover failure looks like a missing-auth problem.
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // auth methods are mutually exclusive; the backend rejects combinations
  const githubAuthFields =
    authMethod === "github_app"
      ? githubAppConfigId
        ? { githubAppConfigId }
        : {}
      : githubPatId
        ? { githubPatId }
        : githubToken.trim()
          ? { githubToken: githubToken.trim() }
          : {};

  const importedMarketplacePlugins = useMemo(
    () =>
      new Set(
        existingPlugins
          .filter(
            (plugin) =>
              plugin.sourceMarketplaceRepo &&
              plugin.sourceMarketplacePluginName,
          )
          .map(
            (plugin) =>
              `${normalizeRepository(plugin.sourceMarketplaceRepo as string)}::${plugin.sourceMarketplacePluginName?.toLowerCase()}`,
          ),
      ),
    [existingPlugins],
  );

  const reset = () => {
    setRepoUrl("");
    setRef("");
    setAuthMethod("pat");
    setGithubToken("");
    setGithubPatId("");
    setGithubAppConfigId("");
    setMarketplace(null);
    setSelected(new Set());
    setSearch("");
    setPreviewEntry(null);
    previewPlugin.reset();
    setDiscoverError(null);
    setScope("personal");
    setTeamIds([]);
    setUserIds([]);
    setSyncInterval("1d");
    setPlatforms([...CONNECT_PLATFORM_OPTIONS]);
    setClients([]);
    setNewTokenName("");
    setAdvancedOpen(false);
  };

  const backToDiscover = () => {
    setMarketplace(null);
    setSearch("");
    setPreviewEntry(null);
    previewPlugin.reset();
  };

  const handleClose = (isOpen: boolean) => {
    if (!isOpen) reset();
    onOpenChange(isOpen);
  };

  const handleAuthMethodChange = (value: GithubAuthMethod) => {
    setAuthMethod(value);
    if (value === "pat") {
      setGithubAppConfigId("");
    } else {
      setGithubPatId("");
      setGithubToken("");
      setNewTokenName("");
    }
  };

  const handleDiscover = async (overrideRepoUrl?: string) => {
    setDiscoverError(null);
    const { data, errorMessage } = await discover.mutateAsync({
      repoUrl: overrideRepoUrl ?? repoUrl,
      ...(ref.trim() && { ref: ref.trim() }),
      ...githubAuthFields,
    });
    if (data && !data.reason) {
      setMarketplace(data);
      setPlatforms(marketplacePlatformOptions(data.repoUrl));
      setClients(marketplaceClientOptions(data.entries));
      setSelected(
        new Set(
          data.entries
            .filter(
              (entry) =>
                entry.supported &&
                !importedMarketplacePlugins.has(
                  marketplaceEntryKey(data.repoUrl, entry.name),
                ),
            )
            .slice(0, PLUGIN_MARKETPLACE_IMPORT_LIMIT)
            .map((entry) => entry.name),
        ),
      );
    } else {
      const message = errorMessage ?? data?.reason ?? null;
      if (message) {
        setDiscoverError(message);
        // a private repo without credentials is the most common failure — put
        // the auth fields in front of the user
        if (!hasGithubAuth) setAdvancedOpen(true);
      }
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: only fire on open
  useEffect(() => {
    if (!open) return;
    setRepoUrl(initialRepoUrl);
    if (autoDiscover && initialRepoUrl) handleDiscover(initialRepoUrl);
  }, [open]);

  const handleImport = async () => {
    if (!marketplace?.marketplacePath) return;
    // a pasted token is saved as a stored credential first, so the periodic
    // checks it backs stay authenticated (transient tokens are never stored)
    let patId = githubPatId;
    if (authMethod === "pat" && !patId && githubToken.trim()) {
      const created = await createPat.mutateAsync({
        name:
          newTokenName.trim() ||
          `${repoSlug?.split("/").pop() || "GitHub"} token`,
        token: githubToken.trim(),
      });
      if (!created) return;
      patId = created.id;
      setGithubPatId(created.id);
    }

    const entries = marketplace.entries.filter(
      (entry) => selected.has(entry.name) && entry.supported,
    );
    const result = await importMarketplace.mutateAsync({
      repoUrl,
      ...(ref.trim() && { ref: ref.trim() }),
      marketplacePath: marketplace.marketplacePath as
        | ".claude-plugin/marketplace.json"
        | ".github/plugin/marketplace.json"
        | ".agents/plugins/marketplace.json"
        | ".cursor-plugin/marketplace.json"
        | "marketplace.json",
      approvedCommitSha: marketplace.commitSha,
      trackingRef: marketplace.ref,
      ...(authMethod === "github_app"
        ? githubAppConfigId
          ? { githubAppConfigId }
          : {}
        : patId
          ? { githubPatId: patId }
          : {}),
      selected: entries.map((entry) => ({
        name: entry.name,
        displayName: entry.name,
        description: entry.description,
        clientType: entry.clientType ?? "claude-code",
        supportedPlatforms: platforms.map((platform) =>
          platform === "windows" ? "windows" : "posix",
        ),
        sourceRepoUrl: entry.sourceRepoUrl ?? marketplace.repoUrl,
        sourceRef: entry.sourceRef,
        sourceSubdir: entry.sourceSubdir,
        approvedSourceSha: entry.sourceCommitSha ?? marketplace.commitSha,
        exclude: [],
      })),
      scope,
      teamIds: scope === "team" ? teamIds : [],
      userIds: scope === "personal" ? userIds : [],
      syncInterval,
    });
    // only leave the dialog when something was actually created; a zero-create
    // result means every selected entry was skipped or failed and the
    // mutation's toasts already said so.
    if (result && result.created.length > 0) {
      handleClose(false);
      onImported?.();
    }
  };

  const toggle = (name: string, range: boolean) => {
    setSelected((prev) => {
      const current = toRowSelectionState(prev);
      const orderedIds = selectableFiltered
        .filter(
          (entry) =>
            prev.has(entry.name) || prev.size < PLUGIN_MARKETPLACE_IMPORT_LIMIT,
        )
        .map((entry) => entry.name);
      const next = rangeSelection.update({
        current,
        orderedIds,
        targetId: name,
        range,
      });

      if (!current[name]) {
        const additions = orderedIds.filter((id) => next[id] && !current[id]);
        const remaining = Math.max(
          0,
          PLUGIN_MARKETPLACE_IMPORT_LIMIT - prev.size,
        );
        for (const id of additions.slice(remaining)) {
          delete next[id];
        }
      }
      return toSelectionSet(next);
    });
  };

  const handleClientsChange = (nextClients: ConnectClient[]) => {
    setClients(nextClients);
    const allowedClientIds = new Set(nextClients.map((client) => client.id));
    const entriesByName = new Map(
      (marketplace?.entries ?? []).map((entry) => [entry.name, entry]),
    );
    setSelected(
      (current) =>
        new Set(
          [...current].filter((name) => {
            const entry = entriesByName.get(name);
            return entry && allowedClientIds.has(entry.clientType);
          }),
        ),
    );
  };

  const handlePreview = (entry: MarketplaceEntry) => {
    if (!entry.sourceRepoUrl || !entry.sourceCommitSha) return;
    setPreviewEntry(entry);
    previewPlugin.reset();
    previewPlugin.mutate({
      repoUrl: entry.sourceRepoUrl,
      ref: entry.sourceCommitSha,
      subdir: entry.sourceSubdir,
      exclude: [],
      ...githubAuthFields,
    });
  };

  const filteredEntries = useMemo(() => {
    if (!marketplace) return [];
    const q = search.trim().toLowerCase();
    return marketplace.entries.filter(
      (entry) =>
        clients.some((client) => client.id === entry.clientType) &&
        (!q ||
          entry.name.toLowerCase().includes(q) ||
          entry.description?.toLowerCase().includes(q)),
    );
  }, [clients, marketplace, search]);

  const availableClients = useMemo(
    () => marketplaceClientOptions(marketplace?.entries ?? []),
    [marketplace],
  );

  const selectableFiltered = useMemo(
    () =>
      filteredEntries.filter(
        (entry) =>
          entry.supported &&
          !importedMarketplacePlugins.has(
            marketplaceEntryKey(marketplace?.repoUrl ?? repoUrl, entry.name),
          ),
      ),
    [filteredEntries, importedMarketplacePlugins, marketplace, repoUrl],
  );

  const allFilteredSelected =
    selectableFiltered.length > 0 &&
    selectableFiltered.every((entry) => selected.has(entry.name));

  const someFilteredSelected =
    !allFilteredSelected &&
    selectableFiltered.some((entry) => selected.has(entry.name));

  const selectedFilteredCount = selectableFiltered.filter((entry) =>
    selected.has(entry.name),
  ).length;
  const selectionLimitReached =
    selected.size >= PLUGIN_MARKETPLACE_IMPORT_LIMIT;

  const toggleAllFiltered = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (
        allFilteredSelected ||
        (next.size >= PLUGIN_MARKETPLACE_IMPORT_LIMIT &&
          selectedFilteredCount > 0)
      ) {
        for (const entry of selectableFiltered) next.delete(entry.name);
      } else {
        for (const entry of selectableFiltered) {
          if (next.size >= PLUGIN_MARKETPLACE_IMPORT_LIMIT) break;
          next.add(entry.name);
        }
      }
      return next;
    });
  };

  const isSelectStep = marketplace !== null;
  const isAutoDiscovering = autoDiscover && !isSelectStep && !discoverError;
  const hasGithubAuth =
    authMethod === "github_app"
      ? githubAppConfigId.length > 0
      : githubPatId.length > 0 || githubToken.trim().length > 0;

  // what the collapsed Advanced fold is configured with, e.g. "saved token, ref"
  const advancedSummary = [
    authMethod === "github_app" && githubAppConfigId
      ? "GitHub App"
      : githubPatId
        ? "saved token"
        : githubToken.trim()
          ? "one-time token"
          : null,
    ref.trim() ? "ref" : null,
  ]
    .filter(Boolean)
    .join(", ");

  const repoSlug = repoUrl
    .replace(/^https?:\/\//, "")
    .replace(/^github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  const repoOwner = repoSlug.split("/")[0];

  const totalImportable =
    marketplace?.entries.filter(
      (entry) =>
        entry.supported &&
        !importedMarketplacePlugins.has(
          marketplaceEntryKey(marketplace.repoUrl, entry.name),
        ),
    ).length ?? 0;
  const totalImported =
    marketplace?.entries.filter((entry) =>
      importedMarketplacePlugins.has(
        marketplaceEntryKey(marketplace.repoUrl, entry.name),
      ),
    ).length ?? 0;
  const totalUnsupported =
    marketplace?.entries.filter((entry) => !entry.supported).length ?? 0;
  const availablePlatforms = marketplacePlatformOptions(
    marketplace?.repoUrl ?? repoUrl,
  );

  return (
    <StandardDialog
      open={open}
      onOpenChange={handleClose}
      title={
        isAutoDiscovering ? (
          "Scanning repository"
        ) : isSelectStep ? (
          autoDiscover ? (
            <span>Select plugins to import</span>
          ) : (
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={backToDiscover}
                aria-label="Go back"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <span>Select plugins to import</span>
            </div>
          )
        ) : (
          "Import plugins from GitHub"
        )
      }
      description={
        isAutoDiscovering
          ? "Looking for a plugin marketplace manifest in the repository."
          : isSelectStep
            ? "Choose which plugins to add to your organization."
            : "Point at a repository containing a plugin marketplace manifest."
      }
      size="medium"
      bodyClassName={isSelectStep ? "p-0" : undefined}
      footer={
        isAutoDiscovering ? (
          <Button variant="outline" onClick={() => handleClose(false)}>
            Cancel
          </Button>
        ) : isSelectStep ? (
          <>
            {autoDiscover ? (
              <Button variant="outline" onClick={() => handleClose(false)}>
                Cancel
              </Button>
            ) : (
              <Button variant="outline" onClick={backToDiscover}>
                Back
              </Button>
            )}
            <Button
              onClick={handleImport}
              disabled={
                selected.size === 0 ||
                selected.size > PLUGIN_MARKETPLACE_IMPORT_LIMIT ||
                importMarketplace.isPending
              }
            >
              {importMarketplace.isPending
                ? "Importing..."
                : `Import ${selected.size > 0 ? `(${selected.size})` : ""}`}
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={() => handleClose(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => handleDiscover()}
              disabled={!repoUrl.trim() || discover.isPending}
            >
              {discover.isPending ? "Discovering..." : "Discover"}
            </Button>
          </>
        )
      }
    >
      {isAutoDiscovering ? (
        <div className="flex flex-col items-center justify-center gap-4 py-10">
          <Avatar className="size-14">
            <AvatarImage
              src={`https://github.com/${repoOwner}.png?size=128`}
              alt=""
            />
            <AvatarFallback>
              <PackageSearch className="size-6 text-muted-foreground" />
            </AvatarFallback>
          </Avatar>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            <span className="font-mono text-foreground">{repoSlug}</span>
          </div>
        </div>
      ) : isSelectStep ? (
        <div className="flex flex-col">
          {marketplace.entries.length === 0 ? (
            <>
              <MarketplaceRepoHeader
                repoOwner={repoOwner}
                repoSlug={repoSlug}
                autoDiscover={autoDiscover}
                onChangeSource={backToDiscover}
              />
              <div className="px-4 py-8">
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <SearchX />
                    </EmptyMedia>
                    <EmptyTitle>No plugins found</EmptyTitle>
                    <EmptyDescription>
                      This repository doesn’t contain a recognized plugin
                      marketplace manifest. Try a different repository or ref.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
            </>
          ) : (
            <>
              <div className="sticky top-0 z-10 border-b bg-background">
                <MarketplaceRepoHeader
                  repoOwner={repoOwner}
                  repoSlug={repoSlug}
                  autoDiscover={autoDiscover}
                  onChangeSource={backToDiscover}
                />
                <div className="space-y-3 px-4 py-3">
                  {totalImportable > 0 && (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="marketplace-clients">Clients</Label>
                        <ConnectionClientMultiSelect
                          id="marketplace-clients"
                          ariaLabel="Filter marketplace clients"
                          value={clients}
                          onValueChange={handleClientsChange}
                          options={availableClients}
                          renderIcon={(client) => (
                            <PluginClientIcon
                              clientType={client.id}
                              size={18}
                            />
                          )}
                        />
                        <p className="text-xs text-muted-foreground">
                          All detected clients are selected by default. Hiding a
                          client removes its plugins from this batch.
                        </p>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="marketplace-platforms">Platforms</Label>
                        <ConnectionPlatformMultiSelect
                          id="marketplace-platforms"
                          value={platforms}
                          onValueChange={setPlatforms}
                          options={availablePlatforms}
                        />
                        <p className="text-xs text-muted-foreground">
                          Applies to every selected plugin. Only supported setup
                          platforms are available.
                        </p>
                      </div>
                    </div>
                  )}
                  <SearchInput
                    value={search}
                    onSearchChange={setSearch}
                    syncQueryParams={false}
                    placeholder="Search by name or description"
                    className="relative w-full"
                  />
                  {selectionLimitReached &&
                    totalImportable > PLUGIN_MARKETPLACE_IMPORT_LIMIT && (
                      <Alert>
                        <AlertTriangle />
                        <AlertTitle>
                          {PLUGIN_MARKETPLACE_IMPORT_LIMIT}-plugin import limit
                        </AlertTitle>
                        <AlertDescription>
                          For this beta, import up to{" "}
                          {PLUGIN_MARKETPLACE_IMPORT_LIMIT} plugins at a time.
                          Finish this import, reopen the marketplace, and select
                          the next batch. Imported plugins will be marked and
                          excluded from the next batch.
                        </AlertDescription>
                      </Alert>
                    )}
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="import-plugins-select-all"
                        checked={
                          allFilteredSelected
                            ? true
                            : someFilteredSelected
                              ? "indeterminate"
                              : false
                        }
                        disabled={
                          selectableFiltered.length === 0 ||
                          (selectionLimitReached && selectedFilteredCount === 0)
                        }
                        onCheckedChange={toggleAllFiltered}
                      />
                      <label
                        htmlFor="import-plugins-select-all"
                        className="cursor-pointer text-xs font-medium text-muted-foreground select-none hover:text-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-50 peer-disabled:hover:text-muted-foreground"
                      >
                        {allFilteredSelected
                          ? "Deselect all"
                          : selectionLimitReached && selectedFilteredCount > 0
                            ? "Clear selected batch"
                            : search.trim()
                              ? `Select visible (up to ${PLUGIN_MARKETPLACE_IMPORT_LIMIT})`
                              : `Select up to ${PLUGIN_MARKETPLACE_IMPORT_LIMIT}`}
                      </label>
                    </div>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {selected.size} of {totalImportable} selected
                      {totalImportable > PLUGIN_MARKETPLACE_IMPORT_LIMIT &&
                        ` · ${PLUGIN_MARKETPLACE_IMPORT_LIMIT} max per import`}
                      {totalImported > 0 && ` · ${totalImported} imported`}
                      {totalUnsupported > 0 &&
                        ` · ${totalUnsupported} unsupported`}
                    </span>
                  </div>
                </div>
              </div>
              {filteredEntries.length === 0 ? (
                <div className="px-4 py-8">
                  <Empty>
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <SearchX />
                      </EmptyMedia>
                      <EmptyTitle>No matches</EmptyTitle>
                      <EmptyDescription>
                        No plugins match “{search}”.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                </div>
              ) : (
                <ul className="divide-y">
                  {filteredEntries.map((entry) => (
                    <MarketplaceEntryRow
                      key={`${entry.marketplacePath}:${entry.name}:${entry.sourceRepoUrl}:${entry.sourceSubdir}`}
                      entry={entry}
                      exists={importedMarketplacePlugins.has(
                        marketplaceEntryKey(marketplace.repoUrl, entry.name),
                      )}
                      checked={selected.has(entry.name)}
                      selectionDisabled={
                        selectionLimitReached && !selected.has(entry.name)
                      }
                      onToggle={(range) => toggle(entry.name, range)}
                      onPreview={() => handlePreview(entry)}
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="marketplace-repo-url">Repository URL</Label>
            <Input
              id="marketplace-repo-url"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="github.com/owner/repo"
              autoFocus
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
            />
            <p className="text-sm text-muted-foreground">
              A marketplace manifest lists every importable plugin in the
              repository.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="marketplace-sync-interval">Keep in sync</Label>
            <Select
              value={syncInterval}
              onValueChange={(value) =>
                setSyncInterval(value as typeof syncInterval)
              }
            >
              <SelectTrigger id="marketplace-sync-interval" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="15m">Every 15 minutes</SelectItem>
                <SelectItem value="1h">Every hour</SelectItem>
                <SelectItem value="1d">Once a day</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">
              Checked against the repository on this schedule; new commits
              become review candidates and never replace approved plugin bytes
              automatically.
            </p>
          </div>
          <PluginScopeSelector
            scope={scope}
            onScopeChange={setScope}
            teamIds={teamIds}
            onTeamIdsChange={setTeamIds}
            userIds={userIds}
            onUserIdsChange={setUserIds}
          />
          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
              <ChevronRight
                className={cn(
                  "h-4 w-4 shrink-0 transition-transform",
                  advancedOpen && "rotate-90",
                )}
              />
              Authentication & ref
              {!advancedOpen && advancedSummary && (
                <span className="font-normal text-xs">· {advancedSummary}</span>
              )}
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-5 pt-4">
              <GithubAuthConfigFields
                authMethod={authMethod}
                onAuthMethodChange={handleAuthMethodChange}
                githubAppConfigId={githubAppConfigId}
                onGithubAppConfigIdChange={setGithubAppConfigId}
                githubAppConfigs={githubAppConfigs}
                authLabel="Authentication"
                authOptional
                authDescription={null}
                configuredDescription={
                  <>
                    Mints a short-lived installation token for this import.
                    Manage configurations in
                  </>
                }
                patFields={
                  <>
                    {githubPats.length > 0 && (
                      <Select
                        value={githubPatId || "new"}
                        onValueChange={(value) => {
                          setGithubPatId(value === "new" ? "" : value);
                          if (value !== "new") {
                            setGithubToken("");
                            setNewTokenName("");
                          }
                        }}
                      >
                        <SelectTrigger
                          className="w-full"
                          aria-label="Saved token"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {githubPats.map((pat) => (
                            <SelectItem key={pat.id} value={pat.id}>
                              {pat.name}
                            </SelectItem>
                          ))}
                          <SelectItem value="new">New token…</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                    {githubPatId ? (
                      <p className="text-sm text-muted-foreground">
                        Scheduled checks stay authenticated with this saved
                        token. Manage saved tokens in{" "}
                        <a
                          href="/settings/github"
                          className="font-medium text-primary underline-offset-4 hover:underline"
                        >
                          Settings → GitHub
                        </a>
                        .
                      </p>
                    ) : (
                      <>
                        <SecretInput
                          id="marketplace-github-token"
                          value={githubToken}
                          onChange={(e) => setGithubToken(e.target.value)}
                          placeholder="ghp_…"
                        />
                        {githubToken.trim() && (
                          <Input
                            value={newTokenName}
                            onChange={(e) => setNewTokenName(e.target.value)}
                            placeholder={`Token name — e.g. ${repoSlug || "marketplace repo"} token`}
                            aria-label="Token name"
                            autoComplete="off"
                            data-1p-ignore
                            data-lpignore="true"
                          />
                        )}
                        <p className="text-sm text-muted-foreground">
                          Needed for private repositories. Saved to{" "}
                          <a
                            href="/settings/github"
                            className="font-medium text-primary underline-offset-4 hover:underline"
                          >
                            Settings → GitHub
                          </a>{" "}
                          on import so scheduled checks stay authenticated.{" "}
                          <a
                            href="https://github.com/settings/personal-access-tokens/new"
                            target="_blank"
                            rel="noreferrer"
                            className="font-medium text-primary underline-offset-4 hover:underline"
                          >
                            Create a token
                          </a>
                          .
                        </p>
                      </>
                    )}
                  </>
                }
              />
              <div className="space-y-2">
                <Label htmlFor="marketplace-ref">
                  Branch, tag, or commit
                  <span className="text-muted-foreground font-normal">
                    {" "}
                    (optional)
                  </span>
                </Label>
                <Input
                  id="marketplace-ref"
                  value={ref}
                  onChange={(e) => setRef(e.target.value)}
                  placeholder="Default branch"
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                />
                <p className="text-sm text-muted-foreground">
                  Discover and track a specific ref instead of the repository’s
                  default branch.
                </p>
              </div>
            </CollapsibleContent>
          </Collapsible>
          {discoverError && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>Couldn’t reach that repository</AlertTitle>
              <AlertDescription>
                <p>{discoverError}</p>
                {!hasGithubAuth && (
                  <p>
                    If the repository is private, add GitHub authentication
                    above and try again.
                  </p>
                )}
              </AlertDescription>
            </Alert>
          )}
        </div>
      )}
      <PluginPreviewDialog
        pluginName={previewEntry?.name ?? null}
        preview={previewPlugin.data ?? null}
        isLoading={previewPlugin.isPending}
        hasError={previewPlugin.isError}
        open={previewEntry !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            setPreviewEntry(null);
            previewPlugin.reset();
          }
        }}
      />
    </StandardDialog>
  );
}

function MarketplaceRepoHeader({
  repoOwner,
  repoSlug,
  autoDiscover,
  onChangeSource,
}: {
  repoOwner: string;
  repoSlug: string;
  autoDiscover: boolean;
  onChangeSource: () => void;
}) {
  return (
    <div className="flex items-center gap-3 border-b bg-muted/30 px-4 py-2.5">
      <Avatar className="size-7 shrink-0">
        <AvatarImage
          src={`https://github.com/${repoOwner}.png?size=64`}
          alt=""
        />
        <AvatarFallback className="text-xs">
          {repoOwner.slice(0, 2).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1 truncate font-mono text-sm font-medium">
        {repoSlug}
      </div>
      {!autoDiscover && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onChangeSource}
          className="shrink-0"
        >
          Change source
        </Button>
      )}
    </div>
  );
}

function MarketplaceEntryRow({
  entry,
  exists,
  checked,
  selectionDisabled,
  onToggle,
  onPreview,
}: {
  entry: MarketplaceEntry;
  exists: boolean;
  checked: boolean;
  selectionDisabled: boolean;
  onToggle: (range: boolean) => void;
  onPreview: () => void;
}) {
  const clientLabel = entry.clientType
    ? (CLIENT_LABELS[entry.clientType] ?? entry.clientType)
    : null;
  return (
    <li
      className={cn(
        "group relative flex items-center gap-3 px-4 py-3 transition-colors",
        !entry.supported
          ? "bg-muted/20"
          : exists
            ? "bg-muted/20"
            : checked
              ? "bg-primary/5"
              : "hover:bg-muted/40",
      )}
    >
      <label
        htmlFor={exists ? undefined : `import-plugin-${entry.name}`}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-3 text-left",
          entry.supported && !exists && !selectionDisabled
            ? "cursor-pointer"
            : "cursor-not-allowed",
        )}
      >
        {exists ? (
          <CheckCircle2
            className="size-4 shrink-0 text-muted-foreground"
            aria-label={`${entry.name} is already imported`}
          />
        ) : entry.supported ? (
          <Checkbox
            id={`import-plugin-${entry.name}`}
            checked={checked}
            disabled={selectionDisabled}
            onClick={(event) => {
              event.preventDefault();
              onToggle(event.shiftKey);
            }}
            className="shrink-0"
            aria-label={
              checked
                ? `Deselect ${entry.name}`
                : selectionDisabled
                  ? `Selection limit reached for ${entry.name}`
                  : `Select ${entry.name}`
            }
          />
        ) : (
          <SearchX
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "truncate text-sm font-medium",
                !entry.supported && "text-muted-foreground",
              )}
            >
              {entry.name || "Unnamed plugin"}
            </span>
            {clientLabel && (
              <Badge variant="outline" className="shrink-0 font-normal">
                {clientLabel}
              </Badge>
            )}
            {entry.version && (
              <Badge variant="secondary" className="shrink-0 font-normal">
                v{entry.version}
              </Badge>
            )}
            {!entry.supported && (
              <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
                Unsupported
              </span>
            )}
            {exists && (
              <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
                Imported
              </span>
            )}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {entry.description || (
              <span className="italic">No description</span>
            )}
          </div>
          {!entry.supported && entry.reason && (
            <div className="truncate text-xs text-destructive">
              {entry.reason}
            </div>
          )}
        </div>
      </label>
      <div className="flex shrink-0 items-center gap-3">
        <span className="text-xs tabular-nums text-muted-foreground">
          {entry.supported && entry.fileCount === 0
            ? "Files checked on import"
            : `${entry.fileCount} ${entry.fileCount === 1 ? "file" : "files"}`}
        </span>
        {entry.supported && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs text-muted-foreground opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100"
            onClick={onPreview}
            aria-label={`Preview ${entry.name}`}
          >
            <Eye className="size-3.5" />
            Preview
          </Button>
        )}
      </div>
    </li>
  );
}

function marketplaceEntryKey(repo: string, pluginName: string): string {
  return `${normalizeRepository(repo)}::${pluginName.toLowerCase()}`;
}

function marketplacePlatformOptions(repo: string): ConnectPlatformOption[] {
  const marketplace = POPULAR_PLUGIN_MARKETPLACES.find(
    (item) => normalizeRepository(item.repo) === normalizeRepository(repo),
  );
  return (marketplace?.supportedPlatforms ?? ["posix", "windows"]).map(
    (platform) => (platform === "windows" ? "windows" : "macos"),
  );
}

function marketplaceClientOptions(
  entries: readonly MarketplaceEntry[],
): ConnectClient[] {
  return CONNECT_CLIENTS.filter((client) =>
    entries.some((entry) => entry.clientType === client.id),
  );
}

function normalizeRepository(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^github\.com\//, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
}

function toRowSelectionState(selected: Set<string>): RowSelectionState {
  return Object.fromEntries([...selected].map((id) => [id, true]));
}

function toSelectionSet(selection: RowSelectionState): Set<string> {
  return new Set(
    Object.entries(selection)
      .filter(([, selected]) => selected)
      .map(([id]) => id),
  );
}
