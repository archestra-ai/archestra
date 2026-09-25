"use client";

import { DocsPage, getDocsUrl } from "@archestra/shared";
import { useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
  AlertTriangle,
  BatteryCharging,
  ExternalLink,
  Eye,
  GitPullRequestArrow,
  KeyRound,
  Loader2,
  LockKeyhole,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Unlink,
  Upload,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
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
import {
  openRowOnPlainClick,
  RowClickShield,
} from "@/components/agent-pages/row-click-shield";
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
import {
  StandardDialog,
  StandardFormDialog,
} from "@/components/standard-dialog";
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
import { Switch } from "@/components/ui/switch";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { DEFAULT_FILTER_ALL } from "@/consts";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
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
import { useCoverageSummary } from "@/lib/openappa-coverage.query";
import {
  type RuntimeCredentialDefinition,
  useRuntimeCredentials,
} from "@/lib/runtime-credentials.query";
import { cn } from "@/lib/utils";
import {
  BATTERY_STATUS,
  BATTERY_STATUS_GROUPS,
  type BatteryStatusGroup,
} from "./battery-status";
import { batteryStatusBadge } from "./policy-decorations";

type BatteryStatus = PolicyBattery["status"];

const SOURCE_OPTIONS = [
  { value: DEFAULT_FILTER_ALL, label: "All sources" },
  { value: "bundled", label: "Bundled" },
  { value: "upload", label: "Uploaded" },
];

const STATUS_OPTIONS = [
  { value: DEFAULT_FILTER_ALL, label: "All statuses" },
  ...BATTERY_STATUS_GROUPS,
];

/**
 * Which status group a row falls in: included and enforced cleanly, included
 * with a problem, not included and fitting a server, or not included.
 */
function statusGroup(
  status: BatteryStatus | null,
  fits: boolean,
): BatteryStatusGroup {
  if (status === null) return fits ? "fits" : "other";
  return BATTERY_STATUS[status].severity === "ok" ? "active" : "broken";
}

/** A URL value the select offers, else every row: a stale link shows the table. */
const knownFilter = (
  options: { value: string }[],
  value: string | null,
): string =>
  options.some((option) => option.value === value)
    ? (value as string)
    : DEFAULT_FILTER_ALL;

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
  // The batteries that fit a server, as the overview counts them.
  const summary = useCoverageSummary();
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
  // Filters and page live in the URL, so a reload or a shared link keeps them.
  const {
    searchParams,
    pageIndex,
    pageSize,
    updateQueryParams,
    setPagination,
  } = useDataTableQueryParams();
  const search = searchParams.get("search") ?? "";
  const sourceFilter = knownFilter(SOURCE_OPTIONS, searchParams.get("source"));
  const statusFilter = knownFilter(STATUS_OPTIONS, searchParams.get("status"));
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [deletingPackage, setDeletingPackage] = useState<BatterySummary | null>(
    null,
  );
  const setFilter = (name: "source" | "status", value: string) =>
    updateQueryParams({
      [name]: value === DEFAULT_FILTER_ALL ? null : value,
      page: "1",
    });
  const clearFilters = () =>
    updateQueryParams({ search: null, source: null, status: null, page: "1" });
  const hasActiveFilters =
    !!search.trim() ||
    sourceFilter !== DEFAULT_FILTER_ALL ||
    statusFilter !== DEFAULT_FILTER_ALL;
  const needsFit = statusFilter === "fits" || statusFilter === "other";
  if (
    declarations.isPending ||
    batteries.isPending ||
    (needsFit && summary.isPending)
  )
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
  const installedCatalogIds = servers.data
    ? new Set(servers.data.map((server) => server.catalogId))
    : null;
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
  const boundCredentials = new Map(
    included.flatMap((battery) =>
      battery.credentials.map((credential) => [
        credential.variable,
        credential,
      ]),
    ),
  );
  const fitting = new Set(
    summary.data?.batteries.available.map((battery) => battery.name),
  );
  // Read from the rows each render, so the open dialog follows every write.
  const editingRow = rows.find((row) => row.name === editing) ?? null;
  const query = search.trim().toLowerCase();
  const filteredRows = rows.filter((row) => {
    const status = row.included
      ? enforced
        ? row.included.status
        : "refused"
      : null;
    return (
      (!query ||
        [
          row.name,
          row.summary?.description ?? "",
          ...(row.summary?.namespaces ?? []),
        ].some((value) => value.toLowerCase().includes(query))) &&
      (sourceFilter === DEFAULT_FILTER_ALL ||
        (row.included?.source ?? row.summary?.source) === sourceFilter) &&
      (statusFilter === DEFAULT_FILTER_ALL ||
        statusGroup(status, fitting.has(row.name)) === statusFilter)
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
          icon={<BatteryIcon row={row.original} catalog={catalog.data ?? []} />}
        />
      ),
    },
    {
      id: "source",
      header: "Source",
      size: 130,
      cell: ({ row }) => (
        <Badge variant="outline">{sourceLabel(row.original)}</Badge>
      ),
    },
    {
      id: "status",
      header: "Status",
      size: 160,
      cell: ({ row }) => {
        const entry = row.original.included;
        if (!entry)
          return (
            <span className="text-muted-foreground">
              {fitting.has(row.original.name)
                ? "Fits your servers"
                : "Available"}
            </span>
          );
        const status = enforced ? entry.status : "refused";
        const badge = batteryStatusBadge(status);
        return <Badge variant={badge.variant}>{badge.label}</Badge>;
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
      size: 96,
      cell: ({ row }) => (
        <BatteryRowActions
          row={row.original}
          writable={writable}
          onEdit={() => setEditing(row.original.name)}
          onRemove={() => setRemoving(row.original.name)}
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
            />
          }
        >
          <FilterSelect
            value={sourceFilter}
            showSearch={false}
            onValueChange={(value) => setFilter("source", value)}
            placeholder="Filter by source"
            items={SOURCE_OPTIONS}
          />
          <FilterSelect
            value={statusFilter}
            showSearch={false}
            onValueChange={(value) => setFilter("status", value)}
            placeholder="Filter by status"
            items={STATUS_OPTIONS}
          />
        </FilterBar>
      </CollectionFilters>
      <DataTable
        columns={columns}
        data={filteredRows}
        getRowId={(row) => row.name}
        pagination={{ pageIndex, pageSize, total: filteredRows.length }}
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
        onRowClick={(row, event) =>
          openRowOnPlainClick(event, () => setEditing(row.name))
        }
      />
      {editingRow && (
        <BatteryDialog
          row={editingRow}
          catalog={catalog.data ?? []}
          installedCatalogIds={installedCatalogIds}
          boundCredentials={boundCredentials}
          catalogName={catalogName}
          enforced={enforced}
          writable={writable}
          bindable={bindable}
          onClose={() => setEditing(null)}
        />
      )}
      {removing && (
        <RemoveBatteryDialog
          name={removing}
          onClose={() => setRemoving(null)}
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

type BatteryCredential = PolicyBattery["credentials"][number];

type CatalogEntry = { id: string; name: string; icon?: string | null };

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

/** A row's mark: its catalog entry's icon, else the bundled provider's, else a battery. */
function BatteryIcon({
  row,
  catalog,
}: {
  row: BatteryTableRow;
  catalog: CatalogEntry[];
}) {
  const match = catalog.find(
    (entry) =>
      row.summary?.installs.some((install) => install.catalogId === entry.id) ||
      entry.name.toLowerCase() === row.name.toLowerCase(),
  );
  const providerIcon = BUNDLED_PROVIDER_ICONS[row.name];
  if (match?.icon)
    return <McpCatalogIcon icon={match.icon} catalogId={match.id} size={20} />;
  if (row.summary?.source === "bundled" && providerIcon)
    return (
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
    );
  return <BatteryCharging className="size-5 shrink-0 text-muted-foreground" />;
}

function sourceLabel(row: BatteryTableRow) {
  return row.included?.source === "upload"
    ? `Upload ${row.included.packageHash?.slice(0, 12) ?? "unknown"}`
    : row.summary?.source === "upload"
      ? "Upload"
      : "Bundled";
}

/**
 * Everything one battery lets you change, in one place: where it applies and
 * which keys its helpers read. Each action writes directly to the policy.
 */
function BatteryDialog({
  row,
  catalog,
  installedCatalogIds,
  boundCredentials,
  catalogName,
  enforced,
  writable,
  bindable,
  onClose,
}: {
  row: BatteryTableRow;
  catalog: CatalogEntry[];
  installedCatalogIds: Set<string> | null;
  boundCredentials: Map<string, BatteryCredential>;
  catalogName: (catalogId: string) => string;
  enforced: boolean;
  writable: boolean;
  bindable: boolean;
  onClose: () => void;
}) {
  const { summary, included } = row;
  const create = useCreateBatteryInstall();
  const update = useUpdateBatteryInstall();
  const detach = useDeleteBatteryInstall();
  const remove = useRemoveBatteryInclude();
  const pending =
    create.isPending ||
    update.isPending ||
    detach.isPending ||
    remove.isPending;
  const organizationWide =
    (included?.scope ?? summary?.scope) === "organization";
  const status = included ? (enforced ? included.status : "refused") : null;
  const badge = status ? batteryStatusBadge(status) : null;
  const installs = summary?.installs ?? [];
  const servers = included?.servers ?? [];
  const governed = new Set(
    servers
      .map((server) => server.catalogId)
      .filter((id): id is string => id !== null),
  );
  // An entry not in the policy yet reads the organization's credential table
  // like any other: a variable another battery binds already has its key.
  const credentials: BatteryCredential[] =
    included?.credentials ??
    (summary?.credentials ?? []).map(
      (variable) =>
        boundCredentials.get(variable) ?? { variable, key: null, readers: [] },
    );
  const bindingInstall = installs[0];
  return (
    <StandardDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="medium"
      title={
        <span className="flex items-center gap-2.5">
          <BatteryIcon row={row} catalog={catalog} />
          <span>{row.name}</span>
          {badge && (
            <Badge variant={badge.variant} className="font-normal">
              {badge.label}
            </Badge>
          )}
        </span>
      }
      description={
        <span
          className="line-clamp-1"
          title={summary?.description ?? undefined}
        >
          {[sourceLabel(row), summary?.description].filter(Boolean).join(" · ")}
        </span>
      }
      bodyClassName="space-y-6"
      footer={<DialogCancelButton>Close</DialogCancelButton>}
    >
      {organizationWide ? (
        <DialogSection title="Scope">
          <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-3">
            <div className="space-y-0.5">
              <Label htmlFor={`battery-include-${row.name}`}>
                Include in policy
              </Label>
              <p className="text-xs text-muted-foreground">
                Its rules check every tool call in the organization.
              </p>
            </div>
            <Switch
              id={`battery-include-${row.name}`}
              checked={included !== null}
              disabled={!writable || !summary || pending}
              onCheckedChange={(enabled) =>
                enabled
                  ? create.mutate({ batteryName: row.name })
                  : remove.mutate(row.name)
              }
            />
          </div>
          {status === "unrouted" && (
            <p className="text-xs text-muted-foreground">
              No policy rule routes a tool to its annotators yet. Add one to the
              policy text, such as{" "}
              <code className="font-mono">{`annotator = "${summary?.annotators[0] ?? ""}"`}</code>
              .
            </p>
          )}
        </DialogSection>
      ) : (
        <DialogSection
          title="Servers"
          description="Its rules check tool calls on these servers."
        >
          {servers.length === 0 ? (
            <p className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
              Not attached to a server yet.
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {servers.map((server) => {
                const install =
                  installs.find(
                    ({ catalogId }) => catalogId === server.catalogId,
                  ) ?? null;
                const name =
                  server.catalogId === null
                    ? "Removed server"
                    : catalogName(server.catalogId);
                return (
                  <ServerRow
                    key={server.target}
                    catalogEntry={
                      catalog.find((entry) => entry.id === server.catalogId) ??
                      null
                    }
                    name={name}
                    detail={`${server.target}__*`}
                    action={
                      writable && install !== null && server.catalogId ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={pending}
                          aria-label={`Detach ${row.name} from ${name}`}
                          onClick={() => detach.mutate(install.id)}
                        >
                          <Unlink className="size-4" />
                          <span>Detach</span>
                        </Button>
                      ) : null
                    }
                  />
                );
              })}
            </ul>
          )}
          {writable && summary && (
            <AttachServerPicker
              batteryName={summary.name}
              catalog={catalog}
              installedCatalogIds={installedCatalogIds}
              taken={governed}
              pending={pending}
              onAttach={(catalogId, onSuccess) =>
                create.mutate(
                  { batteryName: row.name, catalogId },
                  { onSuccess },
                )
              }
            />
          )}
        </DialogSection>
      )}
      {credentials.length > 0 && (
        <CredentialsSection
          batteryName={row.name}
          credentials={credentials}
          onChange={(variable, key) => {
            if (!bindingInstall) return;
            update.mutate({
              id: bindingInstall.id,
              body: {
                credentialBindings: Object.fromEntries(
                  credentials
                    .map((credential) => [
                      credential.variable,
                      credential.variable === variable ? key : credential.key,
                    ])
                    .filter(([, value]) => value !== null && value !== UNBOUND),
                ),
              },
            });
          }}
          disabledReason={
            bindingInstall
              ? null
              : organizationWide
                ? "Include the battery to bind the keys its helpers read."
                : "Attach the battery to a server to bind the keys its helpers read."
          }
          bindable={bindable}
          pending={pending}
        />
      )}
    </StandardDialog>
  );
}

function DialogSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">{title}</h3>
          {description && (
            <p className="text-xs text-muted-foreground">{description}</p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** One server in the battery's list and the tools it governs. */
function ServerRow({
  catalogEntry,
  name,
  detail,
  action,
}: {
  catalogEntry: CatalogEntry | null;
  name: string;
  detail: string;
  action: ReactNode;
}) {
  return (
    <li className="flex min-h-12 items-center gap-3 px-3 py-2 text-sm">
      {catalogEntry ? (
        <McpCatalogIcon
          icon={catalogEntry.icon}
          catalogId={catalogEntry.id}
          size={16}
        />
      ) : null}
      <span className="font-medium">{name}</span>
      <span
        className={cn(
          "truncate text-xs text-muted-foreground",
          detail.endsWith("__*") && "font-mono",
        )}
      >
        {detail}
      </span>
      {action && <div className="ml-auto shrink-0">{action}</div>}
    </li>
  );
}

/** Pick an installed server the battery does not govern yet and add it to the list. */
function AttachServerPicker({
  batteryName,
  catalog,
  installedCatalogIds,
  taken,
  pending,
  onAttach,
}: {
  batteryName: string;
  catalog: CatalogEntry[];
  installedCatalogIds: Set<string> | null;
  taken: Set<string>;
  pending: boolean;
  onAttach: (catalogId: string, onSuccess: () => void) => void;
}) {
  const [catalogId, setCatalogId] = useState("");
  const readiness = useBatteryMatches(catalogId, catalogId !== "");
  const attach = readiness.data?.attach ?? null;
  const options = catalog.filter(
    (entry) =>
      (installedCatalogIds === null || installedCatalogIds.has(entry.id)) &&
      !taken.has(entry.id),
  );
  if (installedCatalogIds?.size === 0)
    return (
      <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>No MCP server is installed yet.</span>
        <Button asChild variant="link" size="sm" className="h-auto p-0">
          <Link href="/mcp/registry">Browse MCP servers</Link>
        </Button>
      </p>
    );
  if (options.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        Every installed server already has this battery.
      </p>
    );
  const id = `battery-server-${batteryName}`;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Attach to a server</Label>
      <div className="flex items-center gap-2">
        <SearchableSelect
          id={id}
          ariaLabel="MCP server"
          className="min-w-0 flex-1"
          value={catalogId}
          onValueChange={setCatalogId}
          placeholder="Select a server…"
          items={options.map((entry) => ({
            value: entry.id,
            label: entry.name,
            content: <ServerOption entry={entry} />,
            selectedContent: <ServerOption entry={entry} />,
          }))}
        />
        <Button
          type="button"
          variant="outline"
          disabled={pending || !catalogId || attach !== "ready"}
          onClick={() => {
            onAttach(catalogId, () => setCatalogId(""));
          }}
        >
          {catalogId && readiness.isFetching ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Plus className="size-4" />
          )}
          <span>Attach</span>
        </Button>
      </div>
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
          <span>Could not check whether this server can take a battery. </span>
          <Button
            type="button"
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
  );
}

function ServerOption({ entry }: { entry: CatalogEntry }) {
  return (
    <span className="flex items-center gap-2">
      <McpCatalogIcon icon={entry.icon} catalogId={entry.id} size={16} />
      <span>{entry.name}</span>
    </span>
  );
}

/**
 * The keys a battery's helpers read, each picked from the organization's
 * credentials. Those are set up on the Credentials settings page, which opens
 * in a new tab so the dialog's edits survive; the list reloads on return.
 */
function CredentialsSection({
  batteryName,
  credentials,
  onChange,
  disabledReason,
  bindable,
  pending,
}: {
  batteryName: string;
  credentials: BatteryCredential[];
  onChange: (variable: string, key: string) => void;
  disabledReason: string | null;
  bindable: boolean;
  pending: boolean;
}) {
  const available = useRuntimeCredentials(bindable);
  const { refetch } = available;
  useEffect(() => {
    if (!bindable) return;
    const reload = () => refetch();
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [bindable, refetch]);
  const options = available.data ?? [];
  return (
    <DialogSection
      title="Credentials"
      description={disabledReason ?? "Keys its helpers read when they run."}
      action={
        <Button asChild variant="link" size="sm" className="h-auto p-0">
          <Link href="/settings/credentials" target="_blank" rel="noreferrer">
            <span>Manage credentials</span>
            <ExternalLink className="size-3.5" />
          </Link>
        </Button>
      }
    >
      {bindable && available.isSuccess && options.length === 0 && (
        <InlineNotice variant="info">
          <KeyRound />
          <span className="font-medium">No credentials yet</span>
          <InlineNoticeText>
            Add one in Credentials, then pick it here.
          </InlineNoticeText>
        </InlineNotice>
      )}
      <div className="space-y-4">
        {credentials.map((credential) => (
          <CredentialRow
            key={credential.variable}
            batteryName={batteryName}
            credential={credential}
            value={credential.key ?? UNBOUND}
            options={options}
            disabled={!bindable || pending || disabledReason !== null}
            onChange={(key) => onChange(credential.variable, key)}
          />
        ))}
      </div>
    </DialogSection>
  );
}

function CredentialRow({
  batteryName,
  credential,
  value,
  options,
  disabled,
  onChange,
}: {
  batteryName: string;
  credential: BatteryCredential;
  value: string;
  options: RuntimeCredentialDefinition[];
  disabled: boolean;
  onChange: (key: string) => void;
}) {
  const [kept, setKept] = useState(false);
  const others = credential.readers.filter((reader) => reader !== batteryName);
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
    <div className="space-y-2">
      <Label htmlFor={id} className="font-mono text-xs">
        {credential.variable}
      </Label>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          // The table is one per organization: letting go of a variable the
          // other entries read would take the key from them too, so the
          // unset is refused and the row says why.
          if (next === UNBOUND && others.length > 0) return setKept(true);
          setKept(false);
          onChange(next);
        }}
      >
        <SelectTrigger id={id} className="w-full">
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
              // The helper runs for the whole organization, so a personal-only
              // credential cannot be bound; it is listed as such rather than hidden.
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
        <p className="text-xs text-muted-foreground">
          Also read by: {others.join(", ")}
        </p>
      )}
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
  packageIncluded,
  onEdit,
  onRemove,
  onDelete,
}: {
  row: BatteryTableRow;
  writable: boolean;
  packageIncluded: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onDelete: () => void;
}) {
  return (
    <RowClickShield>
      <TableRowActions
        itemName={row.name}
        actions={[
          writable
            ? {
                icon: <Pencil className="size-4" />,
                label: "Edit",
                onClick: onEdit,
              }
            : {
                icon: <Eye className="size-4" />,
                label: "View",
                onClick: onEdit,
              },
        ]}
        dropdownActions={[
          ...(writable && row.included
            ? [
                {
                  icon: <Unlink className="size-4" />,
                  label: "Remove from policy",
                  onClick: onRemove,
                  variant: "destructive" as const,
                },
              ]
            : []),
          ...(writable && row.summary?.source === "upload"
            ? [
                {
                  icon: <Trash2 className="size-4" />,
                  label: "Delete package",
                  onClick: onDelete,
                  disabled: packageIncluded,
                  disabledTooltip: "Included by the policy",
                  variant: "destructive" as const,
                },
              ]
            : []),
        ]}
      />
    </RowClickShield>
  );
}

function RemoveBatteryDialog({
  name,
  onClose,
}: {
  name: string;
  onClose: () => void;
}) {
  const remove = useRemoveBatteryInclude();
  return (
    <DeleteConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Remove the ${name} battery?`}
      description="Its include line leaves the policy text and its guardrails stop applying to every server it governed."
      confirmLabel="Remove"
      pendingLabel="Removing…"
      isPending={remove.isPending}
      onConfirm={async () => {
        // Whatever failed, the refetch shows what is left and the dialog
        // never outlives the attempt.
        try {
          await remove.mutateAsync(name);
        } finally {
          onClose();
        }
      }}
    />
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
      type="button"
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
