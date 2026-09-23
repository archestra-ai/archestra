"use client";

import { DocsPage, getDocsUrl } from "@archestra/shared";
import { useQueryClient } from "@tanstack/react-query";
import type { ColumnDef, Row } from "@tanstack/react-table";
import {
  AlertTriangle,
  BatteryCharging,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  GitPullRequestArrow,
  Link2,
  Loader2,
  LockKeyhole,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useState } from "react";
import {
  siCloudflare,
  siDatabricks,
  siGithub,
  siHuggingface,
  siLinear,
  siNotion,
  siPagerduty,
  siPosthog,
} from "simple-icons";
import { AgentNameCell } from "@/components/agent-name-cell";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { FileDropInput } from "@/components/files/file-drop-input";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterSearchClass,
} from "@/components/filter-bar";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { QueryLoadError } from "@/components/query-load-error";
import { SearchInput } from "@/components/search-input";
import { StandardFormDialog } from "@/components/standard-dialog";
import { TableRowActions } from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import {
  useMcpServers,
  useReloadMcpServerTools,
} from "@/lib/mcp/mcp-server.query";
import {
  ATTACH_NOTES,
  type BatterySummary,
  batteryMatchesQueryKey,
  type PolicyBattery,
  type PolicyDeclarations,
  useAcceptHeldPull,
  useBatteries,
  useBatteryMatches,
  useCreateBatteryInstall,
  useDeleteBatteryInstall,
  useDeleteBatteryPackage,
  usePolicyDeclarations,
  useRemoveBatteryInclude,
  useUpdateBatteryInstall,
  useUploadBatteryPackage,
} from "@/lib/openappa-batteries.query";
import { useRuntimeCredentials } from "@/lib/runtime-credentials.query";
import { BATTERY_STATUS_BADGES } from "./policy-decorations";

/**
 * What the organization's policy text includes, as the text declares it. The
 * battery list is a read of the document, not of a table: an entry is included
 * because a line spells it, and every control here edits that line.
 */
export function BatteriesUploadAction() {
  const pathname = usePathname();
  const declarations = usePolicyDeclarations();
  const { data: canBind } = useHasPermissions({
    organization: ["update"],
    toolPolicy: ["update"],
    credential: ["update"],
  });
  const [uploading, setUploading] = useState(false);
  if (
    pathname !== "/openappa/batteries" ||
    !canBind ||
    declarations.data?.managedInGithub
  )
    return null;
  return (
    <>
      <Button onClick={() => setUploading(true)}>
        <Upload className="size-4" />
        <span>Upload package</span>
      </Button>
      {uploading && <UploadPackageDialog onOpenChange={setUploading} />}
    </>
  );
}

export function BatteriesPanel() {
  const declarations = usePolicyDeclarations();
  const batteries = useBatteries();
  const catalog = useInternalMcpCatalog();
  const servers = useMcpServers();
  const { data: canManage } = useHasPermissions({
    organization: ["update"],
    toolPolicy: ["update"],
  });
  // Binding a credential hands its value to helper code, and an uploaded
  // package may carry such code, so both take the credential permission too.
  const { data: canBind } = useHasPermissions({
    organization: ["update"],
    toolPolicy: ["update"],
    credential: ["update"],
  });
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [attaching, setAttaching] = useState<BatteryTableRow | null>(null);
  const [deletingPackage, setDeletingPackage] = useState<BatterySummary | null>(
    null,
  );
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 10 });
  const resetPage = () =>
    setPagination((current) => ({ ...current, pageIndex: 0 }));
  const clearFilters = () => {
    setSearch("");
    setSourceFilter("all");
    setStatusFilter("all");
    resetPage();
  };
  const hasActiveFilters =
    !!search.trim() || sourceFilter !== "all" || statusFilter !== "all";
  if (declarations.isPending || batteries.isPending)
    return <Skeleton className="h-32 w-full" />;
  if (!declarations.data || !batteries.data)
    return (
      <QueryLoadError
        title="Could not load OpenAPPA batteries"
        onRetry={() => {
          declarations.refetch();
          batteries.refetch();
        }}
      />
    );
  const { lastError, managedInGithub, heldPull } = declarations.data;
  const included = declarations.data.batteries;
  // A composition that failed is not what the runtime enforces, whatever each
  // entry resolved to, so no entry may claim to be active.
  const enforced = lastError === null;
  // The repository owns the text while it syncs: an edit here would be undone
  // by the next pull, so the panel only reads.
  const writable = canManage === true && !managedInGithub;
  const bindable = canBind === true && !managedInGithub;
  // Unknown while the catalog loads; only a loaded catalog can say a server is gone.
  const catalogName = (catalogId: string) =>
    catalog.data
      ? (catalog.data.find((entry) => entry.id === catalogId)?.name ??
        "Removed server")
      : "";
  const installsOf = (name: string) =>
    batteries.data
      .find((battery) => battery.name === name)
      ?.installs.map((install) => ({
        id: install.id,
        catalogId: install.catalogId,
      })) ?? [];
  const includedHashes = new Set(
    included
      .map((battery) => battery.packageHash)
      .filter((hash): hash is string => hash !== null),
  );
  const rows: BatteryTableRow[] = batteries.data.map((summary) => ({
    name: summary.name,
    summary,
    included: included.find((entry) => entry.name === summary.name) ?? null,
  }));
  for (const entry of included) {
    if (!rows.some((row) => row.name === entry.name))
      rows.push({ name: entry.name, summary: null, included: entry });
  }
  const query = search.trim().toLowerCase();
  const filteredRows = rows.filter((row) => {
    const status = row.included
      ? enforced
        ? row.included.status
        : "refused"
      : "available";
    return (
      (!query ||
        [
          row.name,
          row.summary?.description ?? "",
          ...(row.summary?.namespaces ?? []),
        ].some((value) => value.toLowerCase().includes(query))) &&
      (sourceFilter === "all" ||
        (row.included?.source ?? row.summary?.source) === sourceFilter) &&
      (statusFilter === "all" ||
        (statusFilter === "included" ? !!row.included : status === "available"))
    );
  });
  const columns: ColumnDef<BatteryTableRow>[] = [
    {
      accessorKey: "name",
      header: "Battery",
      size: 370,
      cell: ({ row }) => (
        <AgentNameCell
          name={row.original.name}
          description={row.original.summary?.description}
          icon={(() => {
            const match = catalog.data?.find(
              (entry) =>
                row.original.summary?.installs.some(
                  (install) => install.catalogId === entry.id,
                ) ||
                entry.name.toLowerCase() === row.original.name.toLowerCase(),
            );
            const providerIcon = BUNDLED_PROVIDER_ICONS[row.original.name];
            return match?.icon ? (
              <McpCatalogIcon
                icon={match.icon}
                catalogId={match.id}
                size={20}
              />
            ) : row.original.summary?.source === "bundled" && providerIcon ? (
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className="size-5 shrink-0"
                fill={
                  providerIcon.hex === "000000" || providerIcon.hex === "181717"
                    ? "currentColor"
                    : `#${providerIcon.hex}`
                }
              >
                <path d={providerIcon.path} />
              </svg>
            ) : (
              <BatteryCharging className="size-5 text-muted-foreground" />
            );
          })()}
        />
      ),
    },
    {
      id: "source",
      header: "Source",
      size: 130,
      cell: ({ row }) => (
        <Badge variant="outline">
          {row.original.included?.source === "upload"
            ? `Upload ${row.original.included.packageHash?.slice(0, 12) ?? "unknown"}`
            : row.original.summary?.source === "upload"
              ? "Upload"
              : "Bundled"}
        </Badge>
      ),
    },
    {
      id: "status",
      header: "Status",
      size: 160,
      cell: ({ row }) => {
        const entry = row.original.included;
        if (!entry)
          return <span className="text-muted-foreground">Available</span>;
        const status = enforced ? entry.status : "refused";
        return (
          <Badge variant={BATTERY_STATUS_BADGES[status].variant}>
            {BATTERY_STATUS_BADGES[status].label}
          </Badge>
        );
      },
    },
    {
      id: "servers",
      header: "Servers",
      size: 110,
      cell: ({ row }) => row.original.included?.servers.length ?? 0,
    },
    {
      id: "actions",
      header: "Actions",
      size: 144,
      cell: ({ row }) => (
        <BatteryRowActions
          row={row}
          writable={writable}
          catalog={catalog.data ?? []}
          installedCatalogIds={
            servers.data
              ? new Set(servers.data.map((server) => server.catalogId))
              : null
          }
          onAttach={() => setAttaching(row.original)}
          onDelete={() =>
            row.original.summary && setDeletingPackage(row.original.summary)
          }
          packageIncluded={
            row.original.summary?.contentHash !== null &&
            row.original.summary?.contentHash !== undefined &&
            includedHashes.has(row.original.summary.contentHash)
          }
        />
      ),
    },
  ];
  return (
    <section aria-label="OpenAPPA batteries" className="space-y-4">
      {lastError !== null && (
        <InlineNotice variant="error">
          <AlertTriangle />
          <span className="font-medium">Batteries are not enforced</span>
          <InlineNoticeText>{lastError}</InlineNoticeText>
        </InlineNotice>
      )}
      {managedInGithub && (
        <InlineNotice variant="neutral">
          <LockKeyhole />
          <span className="font-medium">Managed in GitHub</span>
          <InlineNoticeText>
            The repository owns this policy. Change its batteries there.
          </InlineNoticeText>
        </InlineNotice>
      )}
      {heldPull !== null && (
        <HeldPullNotice
          heldPull={heldPull}
          canManage={canManage === true}
          canBind={canBind === true}
        />
      )}
      {writable && servers.data?.length === 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>
            There is no installed MCP server to attach a battery to yet.
          </span>
          <Button asChild variant="outline" size="sm">
            <Link href="/mcp/registry">Browse MCP servers</Link>
          </Button>
        </div>
      )}
      <CollectionFilters>
        <FilterBar
          onClearFilters={hasActiveFilters ? clearFilters : undefined}
          search={
            <SearchInput
              objectNamePlural="batteries"
              searchFields={["name", "description", "namespace"]}
              className={filterSearchClass}
              syncQueryParams={false}
              value={search}
              onSearchChange={(value) => {
                setSearch(value);
                resetPage();
              }}
            />
          }
        >
          <FilterSelect
            value={sourceFilter}
            showSearch={false}
            onValueChange={(value) => {
              setSourceFilter(value);
              resetPage();
            }}
            placeholder="Filter by source"
            items={[
              { value: "all", label: "All sources" },
              { value: "bundled", label: "Bundled" },
              { value: "upload", label: "Uploaded" },
            ]}
          />
          <FilterSelect
            value={statusFilter}
            showSearch={false}
            onValueChange={(value) => {
              setStatusFilter(value);
              resetPage();
            }}
            placeholder="Filter by status"
            items={[
              { value: "all", label: "All statuses" },
              { value: "included", label: "Included" },
              { value: "available", label: "Available" },
            ]}
          />
        </FilterBar>
      </CollectionFilters>
      <DataTable
        columns={columns}
        data={filteredRows}
        getRowId={(row) => row.name}
        pagination={{ ...pagination, total: filteredRows.length }}
        onPaginationChange={setPagination}
        hasActiveFilters={hasActiveFilters}
        onClearFilters={clearFilters}
        emptyIcon={BatteryCharging}
        emptyMessage="No batteries available"
        emptyDescription="Browse MCP servers to find batteries for your policy."
        emptyAction={
          <Button asChild variant="outline" size="sm">
            <Link href="/mcp/registry">Browse MCP servers</Link>
          </Button>
        }
        filteredEmptyMessage="No batteries match your filters"
        fixedWidthColumnIds={["source", "status", "servers", "actions"]}
        flexibleColumnIds={["name"]}
        renderSubComponent={({ row }) =>
          row.original.included ? (
            <ul className="px-5 py-2">
              <IncludedBattery
                battery={row.original.included}
                installs={installsOf(row.original.name)}
                catalogName={catalogName}
                enforced={enforced}
                writable={writable}
                bindable={bindable}
              />
            </ul>
          ) : null
        }
      />
      {attaching?.summary && (
        <AttachBatteryDialog
          battery={attaching.summary}
          included={attaching.included}
          catalog={catalog.data ?? []}
          installedCatalogIds={
            servers.data
              ? new Set(servers.data.map((server) => server.catalogId))
              : null
          }
          onClose={() => setAttaching(null)}
        />
      )}
      {deletingPackage && (
        <DeleteBatteryPackageDialog
          battery={deletingPackage}
          onClose={() => setDeletingPackage(null)}
        />
      )}
      {declarations.data.unusedAliases.length > 0 && (
        <div className="space-y-2 border-t pt-3">
          <h3 className="text-sm font-medium">Unused aliases</h3>
          {declarations.data.unusedAliases.map((alias) => (
            <div
              key={alias.namespace}
              className="flex flex-wrap items-center gap-2 text-sm"
            >
              <span className="font-mono text-xs">{alias.namespace}</span>
              <span className="text-muted-foreground">→</span>
              <span className="text-muted-foreground">
                {alias.servers.join(", ")}
              </span>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            No included battery declares this namespace.
          </p>
        </div>
      )}
    </section>
  );
}

type BatteryTableRow = {
  name: string;
  summary: BatterySummary | null;
  included: PolicyBattery | null;
};

const BUNDLED_PROVIDER_ICONS: Record<string, { path: string; hex: string }> = {
  cloudflare: siCloudflare,
  databricks: siDatabricks,
  github: siGithub,
  huggingface: siHuggingface,
  linear: siLinear,
  notion: siNotion,
  pagerduty: siPagerduty,
  posthog: siPosthog,
};

const UNBOUND = "__unbound__";

/** A battery install as this panel needs it: the row id behind one catalog. */
type InstallRef = { id: string; catalogId: string };

function HeldPullNotice({
  heldPull,
  canManage,
  canBind,
}: {
  heldPull: NonNullable<PolicyDeclarations["heldPull"]>;
  canManage: boolean;
  canBind: boolean;
}) {
  const accept = useAcceptHeldPull();
  // Publishing the held text performs what it was held for: dropping an entry
  // is a policy edit, rebinding a variable hands a credential to other code.
  const mayAccept = heldPull.reasons.includes("changes_credentials")
    ? canBind
    : canManage;
  return (
    <InlineNotice variant="warning">
      <GitPullRequestArrow />
      <span className="font-medium">Repository text held</span>
      <InlineNoticeText>
        {heldPull.reasons.map((reason) => (
          <div key={reason}>{HELD_PULL_REASONS[reason]}</div>
        ))}
      </InlineNoticeText>
      {mayAccept && (
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={accept.isPending}
          onClick={() => accept.mutate()}
        >
          <span>Accept repository text</span>
        </Button>
      )}
    </InlineNotice>
  );
}

function IncludedBattery({
  battery,
  installs,
  catalogName,
  enforced,
  writable,
  bindable,
}: {
  battery: PolicyBattery;
  installs: InstallRef[];
  catalogName: (catalogId: string) => string;
  enforced: boolean;
  writable: boolean;
  bindable: boolean;
}) {
  const remove = useRemoveBatteryInclude();
  const [removing, setRemoving] = useState(false);
  const status = enforced ? battery.status : "refused";
  const source =
    battery.source === "bundled"
      ? "Bundled"
      : `Upload ${battery.packageHash?.slice(0, 12) ?? "unknown"}`;
  return (
    <li className="space-y-2 py-3" aria-label={`${battery.name} battery`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{battery.name}</span>
        <Badge variant="outline">{source}</Badge>
        <Badge variant={BATTERY_STATUS_BADGES[status].variant}>
          {BATTERY_STATUS_BADGES[status].label}
        </Badge>
        {writable && (
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto"
            aria-label={`Remove the ${battery.name} battery`}
            onClick={() => setRemoving(true)}
          >
            <Trash2 className="size-4" />
          </Button>
        )}
      </div>
      <div className="grid gap-x-8 gap-y-2 md:grid-cols-2">
        <Section title="Governs">
          {battery.servers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No alias points this battery at a server.
            </p>
          ) : (
            battery.servers.map((server) => (
              <ServerRow
                key={server.target}
                batteryName={battery.name}
                target={server.target}
                name={
                  server.catalogId === null
                    ? "Removed server"
                    : catalogName(server.catalogId)
                }
                install={
                  installs.find(
                    ({ catalogId }) => catalogId === server.catalogId,
                  ) ?? null
                }
                writable={writable}
              />
            ))
          )}
        </Section>
        {battery.credentials.length > 0 ? (
          <Section title="Credentials">
            {battery.credentials.map((credential) => (
              <CredentialRow
                key={credential.variable}
                batteryName={battery.name}
                credential={credential}
                bindings={bindingsOf(battery)}
                install={installs[0] ?? null}
                bindable={bindable}
              />
            ))}
          </Section>
        ) : null}
      </div>
      <DeleteConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove the ${battery.name} battery?`}
        description="Its include line leaves the policy text and its guardrails stop applying to every server it governed."
        confirmLabel="Remove"
        pendingLabel="Removing…"
        isPending={remove.isPending}
        onConfirm={async () => {
          // Whatever failed, the refetch shows what is left and the dialog
          // never outlives the attempt.
          try {
            await remove.mutateAsync(battery.name);
          } finally {
            setRemoving(false);
          }
        }}
      />
    </li>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      {children}
    </div>
  );
}

/** One server the battery governs: the entry's name, then the tool prefix its alias points at. */
function ServerRow({
  batteryName,
  target,
  name,
  install,
  writable,
}: {
  batteryName: string;
  target: string;
  name: string;
  install: InstallRef | null;
  writable: boolean;
}) {
  const remove = useDeleteBatteryInstall();
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span>{name}</span>
      <span className="font-mono text-xs text-muted-foreground">
        {target}__*
      </span>
      {writable && install !== null && (
        <Button
          variant="ghost"
          size="sm"
          disabled={remove.isPending}
          aria-label={`Detach ${batteryName} from ${name}`}
          onClick={() => remove.mutate(install.id)}
        >
          <span>Detach</span>
        </Button>
      )}
    </div>
  );
}

function CredentialRow({
  batteryName,
  credential,
  bindings,
  install,
  bindable,
}: {
  batteryName: string;
  credential: PolicyBattery["credentials"][number];
  bindings: Record<string, string>;
  install: InstallRef | null;
  bindable: boolean;
}) {
  const update = useUpdateBatteryInstall();
  const [kept, setKept] = useState(false);
  const credentials = useRuntimeCredentials(bindable);
  const others = credential.readers.filter((reader) => reader !== batteryName);
  // The helper runs for the whole organization, so a personal-only
  // credential cannot be bound; it is listed as such rather than hidden.
  const options = credentials.data ?? [];
  // The policy can name a key the list does not offer — deleted, closed to
  // the organization, or a list this reader never loads — and the binding
  // still has to read as what it is.
  const unlisted =
    credential.key !== null &&
    !options.some((entry) => entry.key === credential.key)
      ? credential.key
      : null;
  const id = `${batteryName}-${credential.variable}`;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={id} className="font-mono text-xs font-normal">
          {credential.variable}
        </Label>
        <Select
          value={credential.key ?? UNBOUND}
          disabled={!bindable || install === null || update.isPending}
          onValueChange={(value) => {
            // The table is one per organization: letting go of a variable the
            // other entries read would take the key from them too, so the
            // unset is never sent and the row says why.
            if (value === UNBOUND && others.length > 0) return setKept(true);
            setKept(false);
            if (install === null) return;
            update.mutate({
              id: install.id,
              body: {
                credentialBindings: rebind(
                  bindings,
                  credential.variable,
                  value,
                ),
              },
            });
          }}
        >
          <SelectTrigger id={id} className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={UNBOUND}>Not bound</SelectItem>
            {unlisted !== null && (
              <SelectItem value={unlisted} disabled>
                {`${unlisted} (not available)`}
              </SelectItem>
            )}
            {options.map((entry) => (
              <SelectItem
                key={entry.key}
                value={entry.key}
                disabled={!entry.allowOrganization}
              >
                {!entry.allowOrganization
                  ? `${entry.name} (personal only)`
                  : entry.organizationConfigured
                    ? entry.name
                    : `${entry.name} (no organization value)`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {others.length > 0 && (
          <span className="text-xs text-muted-foreground">
            Also read by: {others.join(", ")}
          </span>
        )}
      </div>
      {kept && (
        <InlineNotice variant="neutral">
          <span className="font-medium">The key stays</span>
          <InlineNoticeText>
            {others.join(", ")} still read this variable. Remove those batteries
            to unbind it.
          </InlineNoticeText>
        </InlineNotice>
      )}
    </div>
  );
}

function BatteryRowActions({
  row,
  writable,
  catalog,
  installedCatalogIds,
  packageIncluded,
  onAttach,
  onDelete,
}: {
  row: Row<BatteryTableRow>;
  writable: boolean;
  catalog: { id: string; name: string; icon?: string | null }[];
  installedCatalogIds: Set<string> | null;
  packageIncluded: boolean;
  onAttach: () => void;
  onDelete: () => void;
}) {
  const battery = row.original.summary;
  const included = row.original.included;
  const attached = new Set(
    included?.servers
      .map((server) => server.catalogId)
      .filter((id): id is string => id !== null) ?? [],
  );
  const options = catalog.filter(
    (entry) =>
      (installedCatalogIds === null || installedCatalogIds.has(entry.id)) &&
      !attached.has(entry.id),
  );
  return (
    <TableRowActions
      actions={[
        ...(writable && battery
          ? [
              {
                icon: <Link2 className="size-4" />,
                label: `Attach the ${battery.name} battery to a server`,
                onClick: onAttach,
                disabled: options.length === 0,
                disabledTooltip: "Connect an available MCP server first",
              },
            ]
          : []),
        ...(included
          ? [
              {
                icon: row.getIsExpanded() ? (
                  <ChevronDown className="size-4" />
                ) : (
                  <ChevronRight className="size-4" />
                ),
                label: `${row.getIsExpanded() ? "Hide" : "Manage"} ${row.original.name} battery`,
                onClick: () => row.toggleExpanded(),
              },
            ]
          : []),
        ...(writable && battery?.source === "upload"
          ? [
              {
                icon: <Trash2 className="size-4" />,
                label: `Delete the ${battery.name} package`,
                onClick: onDelete,
                disabled: packageIncluded,
                disabledTooltip: "Included by the policy",
                variant: "destructive" as const,
              },
            ]
          : []),
      ]}
    />
  );
}

function AttachBatteryDialog({
  battery,
  included,
  catalog,
  installedCatalogIds,
  onClose,
}: {
  battery: BatterySummary;
  included: PolicyBattery | null;
  catalog: { id: string; name: string; icon?: string | null }[];
  installedCatalogIds: Set<string> | null;
  onClose: () => void;
}) {
  const create = useCreateBatteryInstall();
  const [catalogId, setCatalogId] = useState("");
  const readiness = useBatteryMatches(catalogId, catalogId !== "");
  const attach = readiness.data?.attach ?? null;
  const attached = new Set(
    included?.servers
      .map((server) => server.catalogId)
      .filter((id): id is string => id !== null) ?? [],
  );
  const options = catalog.filter(
    (entry) =>
      (installedCatalogIds === null || installedCatalogIds.has(entry.id)) &&
      !attached.has(entry.id),
  );
  return (
    <StandardFormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Attach ${battery.name}`}
      description="Choose the MCP server this battery should govern."
      size="small"
      isDirty={catalogId !== ""}
      onSubmit={(event) => {
        event.preventDefault();
        if (!catalogId || attach !== "ready") return;
        create.mutate(
          { batteryName: battery.name, catalogId },
          { onSuccess: onClose },
        );
      }}
      footer={
        <>
          <DialogCancelButton disabled={create.isPending} />
          <Button
            type="submit"
            disabled={!catalogId || attach !== "ready" || create.isPending}
          >
            <span>{create.isPending ? "Attaching…" : "Attach battery"}</span>
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <Label htmlFor={`battery-server-${battery.name}`}>MCP server</Label>
        <SearchableSelect
          id={`battery-server-${battery.name}`}
          ariaLabel="MCP server"
          value={catalogId}
          onValueChange={setCatalogId}
          placeholder="Select a server…"
          items={options.map((entry) => ({
            value: entry.id,
            label: entry.name,
            content: (
              <span className="flex items-center gap-2">
                <McpCatalogIcon
                  icon={entry.icon}
                  catalogId={entry.id}
                  size={16}
                />
                <span>{entry.name}</span>
              </span>
            ),
            selectedContent: (
              <span className="flex items-center gap-2">
                <McpCatalogIcon
                  icon={entry.icon}
                  catalogId={entry.id}
                  size={16}
                />
                <span>{entry.name}</span>
              </span>
            ),
          }))}
        />
        {attach !== null && attach !== "ready" && (
          <p
            role="note"
            className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
          >
            <span>{ATTACH_NOTES[attach]}</span>
            {attach === "unsynced" && <SyncToolsButton catalogId={catalogId} />}
          </p>
        )}
        {readiness.isError && (
          <p role="alert" className="text-sm text-destructive">
            <span>
              Could not check whether this server can take a battery.{" "}
            </span>
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0"
              onClick={() => readiness.refetch()}
            >
              <span>Retry</span>
            </Button>
          </p>
        )}
      </div>
    </StandardFormDialog>
  );
}

function DeleteBatteryPackageDialog({
  battery,
  onClose,
}: {
  battery: BatterySummary;
  onClose: () => void;
}) {
  const remove = useDeleteBatteryPackage();
  return (
    <DeleteConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Delete the ${battery.name} package?`}
      description="The policy can no longer include this version of the battery."
      isPending={remove.isPending}
      onConfirm={async () => {
        if (battery.contentHash) await remove.mutateAsync(battery.contentHash);
        onClose();
      }}
    />
  );
}

/**
 * Re-discover the tools of the picked server, which is what gives an alias a
 * target. The reload endpoint takes an install, not the catalog entry: the
 * newest install of the entry stands for it, and without one there is
 * nothing to sync from.
 */
function SyncToolsButton({ catalogId }: { catalogId: string }) {
  const client = useQueryClient();
  const servers = useMcpServers();
  const reload = useReloadMcpServerTools();
  const target = (servers.data ?? [])
    .filter((server) => server.catalogId === catalogId)
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )[0];
  return (
    <PermissionButton
      permissions={{ mcpServerInstallation: ["create"] }}
      variant="outline"
      size="sm"
      disabled={reload.isPending || target === undefined}
      tooltip={
        target === undefined
          ? "Connect this server first: syncing tools needs a live connection"
          : undefined
      }
      onClick={() =>
        target &&
        reload.mutate(
          { id: target.id, name: target.name, catalogId },
          {
            onSuccess: () =>
              client.invalidateQueries({
                queryKey: batteryMatchesQueryKey(catalogId),
              }),
          },
        )
      }
    >
      {reload.isPending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <RefreshCw className="size-4" />
      )}
      <span>Sync tools</span>
    </PermissionButton>
  );
}

function UploadPackageDialog({
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => void;
}) {
  const upload = useUploadBatteryPackage();
  const [name, setName] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  return (
    <StandardFormDialog
      open
      onOpenChange={onOpenChange}
      isDirty={name.trim().length > 0 || files.length > 0}
      title="Upload a battery package"
      description={
        <span>
          Pick the package folder: its manifest, policy and helper scripts.{" "}
          <a
            href={getDocsUrl(DocsPage.PlatformAiToolGuardrails, "batteries")}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 underline underline-offset-4"
          >
            <span>About batteries</span>
            <ExternalLink className="size-3.5" />
          </a>
        </span>
      }
      size="medium"
      bodyClassName="space-y-5"
      onSubmit={async (event) => {
        event.preventDefault();
        upload.mutate(
          { name: name.trim(), files: await readPackage(files) },
          { onSuccess: () => onOpenChange(false) },
        );
      }}
      footer={
        <>
          <DialogCancelButton disabled={upload.isPending} />
          <Button
            type="submit"
            disabled={upload.isPending || files.length === 0}
          >
            <span>{upload.isPending ? "Uploading…" : "Upload"}</span>
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <Label htmlFor="battery-package-name">Name</Label>
        <Input
          id="battery-package-name"
          value={name}
          required
          pattern="[a-z0-9][a-z0-9\-]*"
          placeholder="my-battery"
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="battery-package-files">Package folder</Label>
        <FileDropInput
          directory
          inputId="battery-package-files"
          inputLabel="Package folder"
          typesLabel="Select the whole package directory."
          onFiles={setFiles}
        />
        {files.length > 0 && (
          <div className="space-y-1 text-xs text-muted-foreground">
            <p>{files.length} files selected</p>
            <ul className="max-h-24 overflow-auto font-mono">
              {files.slice(0, 5).map((file) => (
                <li key={file.webkitRelativePath || file.name}>
                  {file.webkitRelativePath || file.name}
                </li>
              ))}
            </ul>
            {files.length > 5 && <p>And {files.length - 5} more files</p>}
          </div>
        )}
      </div>
    </StandardFormDialog>
  );
}

const HELD_PULL_REASONS: Record<
  NonNullable<PolicyDeclarations["heldPull"]>["reasons"][number],
  string
> = {
  drops_batteries:
    "The repository text drops batteries this deployment declared",
  changes_credentials:
    "The repository text changes which credentials batteries read",
};

/** The `[credentials]` rows this entry owns, as a PATCH body spells them. */
function bindingsOf(battery: PolicyBattery): Record<string, string> {
  return Object.fromEntries(
    battery.credentials
      .filter((credential) => credential.key !== null)
      .map((credential) => [credential.variable, credential.key as string]),
  );
}

function rebind(
  bindings: Record<string, string>,
  variable: string,
  value: string,
): Record<string, string> {
  const { [variable]: _, ...rest } = bindings;
  return value === UNBOUND ? rest : { ...rest, [variable]: value };
}

/** Package files keyed by their path inside the picked folder. */
async function readPackage(files: File[]) {
  const paths = files.map((file) => file.webkitRelativePath || file.name);
  const slash = paths[0]?.indexOf("/") ?? -1;
  const root = slash === -1 ? "" : (paths[0]?.slice(0, slash + 1) ?? "");
  const shared = root !== "" && paths.every((path) => path.startsWith(root));
  return Promise.all(
    files.map(async (file, index) => ({
      path: shared ? paths[index].slice(root.length) : paths[index],
      text: await file.text(),
    })),
  );
}
