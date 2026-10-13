"use client";

import {
  type archestraApiTypes,
  PLUGIN_MARKETPLACE_IMPORT_LIMIT,
} from "@archestra/shared";
import type { RowSelectionState } from "@tanstack/react-table";
import {
  AlertTriangle,
  CheckCircle2,
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
import { RepositoryBar, SetupStepper } from "@/components/git/git-setup-chrome";
import {
  gitAuthFields,
  resolveGitRepository,
} from "@/components/git/git-source";
import {
  GitSourceStepBody,
  GitSourceStepFooter,
  gitSourceStepDescription,
  gitSourceStepLabels,
  useGitSourceSteps,
} from "@/components/git/git-source-steps";
import type { InitialPermissionGrant } from "@/components/initial-resource-permissions";
import { ResourceAccessSection } from "@/components/resource-access-section";
import { SearchInput } from "@/components/search-input";
import { StandardDialog } from "@/components/standard-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { FieldDescription } from "@/components/ui/field-description";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BulkRangeSelectionController } from "@/lib/bulk-range-selection";
import {
  type GithubPluginMarketplace,
  useDiscoverGithubPluginMarketplace,
  useImportGithubPluginMarketplace,
  usePlugins,
  usePreviewGithubPlugin,
} from "@/lib/plugins/plugin.query";
import { cn } from "@/lib/utils/tailwind";
import { PluginClientIcon } from "./plugin-client-icon";
import { PluginPreviewDialog } from "./plugin-preview-dialog";

type MarketplaceEntry = GithubPluginMarketplace["entries"][number];
type ImportMarketplaceBody =
  archestraApiTypes.ImportGithubPluginMarketplaceData["body"];

const CLIENT_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  "copilot-cli": "Copilot CLI",
  codex: "Codex",
  cursor: "Cursor",
};

/**
 * The marketplace import dialog: pick a GitHub or GitLab repository through
 * the shared host → access → repository steps, then choose which of its
 * plugins to add and import them pinned to the reviewed commit. A repository
 * without a marketplace manifest lists its plugin folders instead.
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
  const source = useGitSourceSteps();
  const previewPlugin = usePreviewGithubPlugin();
  const { data: existingPlugins = [] } = usePlugins();

  const [marketplace, setMarketplace] =
    useState<GithubPluginMarketplace | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const rangeSelection = useRef(new BulkRangeSelectionController()).current;
  const [search, setSearch] = useState("");
  const [previewEntry, setPreviewEntry] = useState<MarketplaceEntry | null>(
    null,
  );
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [initialGrants, setInitialGrants] = useState<InitialPermissionGrant[]>(
    [],
  );
  // check cadence for every plugin selected in this import: new commits become
  // review candidates and never replace approved bytes automatically.
  const [syncInterval, setSyncInterval] = useState<"15m" | "1h" | "1d">("1d");
  // Marketplaces do not declare setup OS compatibility.
  const [platforms, setPlatforms] = useState<ConnectPlatformOption[]>(() => [
    ...CONNECT_PLATFORM_OPTIONS,
  ]);
  const [clients, setClients] = useState<ConnectClient[]>([]);

  // What the routes read: the repository, the branch to track, and the
  // provider with its credential.
  const resolved = source.resolved;
  const repositoryFields = resolved.ok
    ? {
        repoUrl: resolved.repoUrl,
        ...(resolved.ref && { ref: resolved.ref }),
        ...source.auth,
      }
    : null;

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
    source.reset();
    setMarketplace(null);
    setSelected(new Set());
    setSearch("");
    setPreviewEntry(null);
    previewPlugin.reset();
    setDiscoverError(null);
    setInitialGrants([]);
    setSyncInterval("1d");
    setPlatforms([...CONNECT_PLATFORM_OPTIONS]);
    setClients([]);
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

  const handleDiscover = async (
    fields: NonNullable<typeof repositoryFields>,
  ) => {
    setDiscoverError(null);
    const { data, errorMessage } = await discover.mutateAsync(fields);
    if (data && !data.reason) {
      setMarketplace(data);
      setPlatforms([...CONNECT_PLATFORM_OPTIONS]);
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
      if (message) setDiscoverError(message);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: only fire on open
  useEffect(() => {
    if (!open || !initialRepoUrl) return;
    // The marketplace list holds public github.com repositories: skip straight
    // past the host and access steps.
    source.startOnPublicGithub(initialRepoUrl);
    if (!autoDiscover) return;
    const initial = resolveGitRepository({
      provider: "github",
      access: { kind: "public" },
      input: initialRepoUrl,
    });
    handleDiscover({
      repoUrl: initial.ok ? initial.repoUrl : initialRepoUrl,
      ...gitAuthFields({ provider: "github", access: { kind: "public" } }),
    });
  }, [open]);

  const handleImport = async () => {
    if (!marketplace || !repositoryFields) return;
    const entries = marketplace.entries.filter(
      (entry) => selected.has(entry.name) && entry.supported,
    );
    const result = await importMarketplace.mutateAsync({
      ...repositoryFields,
      // null imports the plugin folders of a repository without a manifest.
      // The route takes null, but the generated type drops it from the enum.
      marketplacePath:
        marketplace.marketplacePath as ImportMarketplaceBody["marketplacePath"],
      approvedCommitSha: marketplace.commitSha,
      trackingRef: marketplace.ref,
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
      initialGrants: initialGrants.map(({ subject, actions }) => ({
        subject,
        actions,
      })),
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
      ...source.auth,
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
            marketplaceEntryKey(
              marketplace?.repoUrl ?? source.repository.input,
              entry.name,
            ),
          ),
      ),
    [
      filteredEntries,
      importedMarketplacePlugins,
      marketplace,
      source.repository.input,
    ],
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
  const repositoryBar = (
    <RepositoryBar
      provider={source.provider}
      label={resolved.ok ? resolved.label : source.repository.input}
      avatarUrl={resolved.ok ? resolved.avatarUrl : null}
      onChange={autoDiscover ? undefined : backToDiscover}
    />
  );

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

  return (
    <StandardDialog
      open={open}
      onOpenChange={handleClose}
      title={
        isAutoDiscovering
          ? "Scanning repository"
          : isSelectStep
            ? "Select plugins to import"
            : "Import plugins"
      }
      description={
        isAutoDiscovering
          ? "Looking for plugins."
          : isSelectStep
            ? marketplace.marketplacePath
              ? "Choose which plugins to import."
              : "No marketplace file. These are its plugin folders."
            : gitSourceStepDescription({
                step: source.step,
                provider: source.provider,
              })
      }
      size="medium"
      bodyClassName={isSelectStep ? "p-0" : undefined}
      footer={
        isAutoDiscovering ? (
          <Button variant="outline" onClick={() => handleClose(false)}>
            <span>Cancel</span>
          </Button>
        ) : isSelectStep ? (
          <>
            {autoDiscover ? (
              <Button variant="outline" onClick={() => handleClose(false)}>
                <span>Cancel</span>
              </Button>
            ) : (
              <Button variant="outline" onClick={backToDiscover}>
                <span>Back</span>
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
              {importMarketplace.isPending ? (
                <Loader2 className="animate-spin" />
              ) : null}
              <span>
                {importMarketplace.isPending
                  ? "Importing…"
                  : `Import${selected.size > 0 ? ` (${selected.size})` : ""}`}
              </span>
            </Button>
          </>
        ) : (
          <GitSourceStepFooter
            source={source}
            onCancel={() => handleClose(false)}
            findLabel="Find plugins"
            finding={discover.isPending}
            onFind={() => repositoryFields && handleDiscover(repositoryFields)}
          />
        )
      }
    >
      {isAutoDiscovering ? (
        <div className="flex flex-col items-center justify-center gap-4 py-10">
          <Avatar className="size-14">
            <AvatarImage
              src={
                resolved.ok && resolved.avatarUrl
                  ? `${resolved.avatarUrl}?size=128`
                  : undefined
              }
              alt=""
            />
            <AvatarFallback>
              <PackageSearch className="size-6 text-muted-foreground" />
            </AvatarFallback>
          </Avatar>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            <span className="font-mono text-foreground">
              {resolved.ok ? resolved.label : initialRepoUrl}
            </span>
          </div>
        </div>
      ) : isSelectStep ? (
        <div className="flex flex-col">
          {autoDiscover ? null : (
            <div className="px-4 pt-4 pb-3">
              <SetupStepper
                steps={gitSourceStepLabels({
                  provider: source.provider,
                  last: "Plugins",
                })}
                current={3}
              />
            </div>
          )}
          {marketplace.entries.length === 0 ? (
            <>
              {repositoryBar}
              <div className="px-4 py-8">
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <SearchX />
                    </EmptyMedia>
                    <EmptyTitle>No plugins found</EmptyTitle>
                    <EmptyDescription>
                      No marketplace file or plugin folders. Try another
                      repository or branch.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
            </>
          ) : (
            <>
              <div className="sticky top-0 z-10 border-b bg-background">
                {repositoryBar}
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
                        <FieldDescription>
                          All detected clients are selected by default. Hiding a
                          client removes its plugins from this batch.
                        </FieldDescription>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="marketplace-platforms">Platforms</Label>
                        <ConnectionPlatformMultiSelect
                          id="marketplace-platforms"
                          value={platforms}
                          onValueChange={setPlatforms}
                        />
                        <FieldDescription>
                          Applies to every selected plugin. Only supported setup
                          platforms are available.
                        </FieldDescription>
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
                      <InlineNotice>
                        <AlertTriangle />
                        <span className="font-medium">
                          {PLUGIN_MARKETPLACE_IMPORT_LIMIT}-plugin import limit
                        </span>
                        <InlineNoticeText>
                          For this beta, import up to{" "}
                          {PLUGIN_MARKETPLACE_IMPORT_LIMIT} plugins at a time.
                          Finish this import, reopen the marketplace, and select
                          the next batch. Imported plugins will be marked and
                          excluded from the next batch.
                        </InlineNoticeText>
                      </InlineNotice>
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
          {marketplace.entries.length > 0 ? (
            <div className="space-y-5 border-t px-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="marketplace-sync-interval">Keep in sync</Label>
                <FieldDescription>
                  New commits wait for your review.
                </FieldDescription>
                <Select
                  value={syncInterval}
                  onValueChange={(value) =>
                    setSyncInterval(value as typeof syncInterval)
                  }
                >
                  <SelectTrigger
                    id="marketplace-sync-interval"
                    className="w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="15m">Every 15 minutes</SelectItem>
                    <SelectItem value="1h">Every hour</SelectItem>
                    <SelectItem value="1d">Once a day</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <ResourceAccessSection
                resource="plugin"
                grants={initialGrants}
                onGrantsChange={setInitialGrants}
              />
            </div>
          ) : null}
        </div>
      ) : (
        <div className="space-y-5">
          <GitSourceStepBody source={source} lastLabel="Plugins" />
          {discoverError && source.step === "repo" ? (
            <InlineNotice variant="error">
              <AlertTriangle />
              <span className="font-medium">Couldn’t read that repository</span>
              <InlineNoticeText>
                <span>{discoverError}</span>
                {source.access?.kind === "public" ? (
                  <span> Private? Change the access above.</span>
                ) : null}
              </InlineNoticeText>
            </InlineNotice>
          ) : null}
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
            size="xs"
            className="text-muted-foreground opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100"
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

function marketplaceClientOptions(
  entries: readonly MarketplaceEntry[],
): ConnectClient[] {
  return CONNECT_CLIENTS.filter((client) =>
    entries.some((entry) => entry.clientType === client.id),
  );
}

/** `owner/repo` or `group/sub/project`, whatever host or form it came in. */
function normalizeRepository(value: string): string {
  const path = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  const [first, ...rest] = path.split("/");
  return first.includes(".") || first.includes(":") ? rest.join("/") : path;
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
