"use client";

import { isBuiltInCatalogId, type Permissions } from "@archestra/shared";
import { useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
  BatteryCharging,
  ExternalLink,
  FileCode,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  TriangleAlert,
  Undo2,
  Unlink,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { useSettingsAreaAccess } from "@/app/_parts/use-settings-area-access";
import { AgentNameCell } from "@/components/agent-name-cell";
import {
  openRowOnPlainClick,
  RowClickShield,
} from "@/components/agent-pages/row-click-shield";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterSearchClass,
} from "@/components/filter-bar";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { QueryLoadError } from "@/components/query-load-error";
import {
  RuntimeCredentialIcon,
  runtimeCredentialIconOf,
} from "@/components/runtime-credential-icon";
import { SearchInput } from "@/components/search-input";
import { StandardDialog } from "@/components/standard-dialog";
import { TableRowActions } from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { DEFAULT_FILTER_ALL } from "@/consts";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import { useMcpRegistryIssueIndex } from "@/lib/mcp/mcp-registry.query";
import {
  useMcpServers,
  useReloadMcpServerTools,
} from "@/lib/mcp/mcp-server.query";
import {
  ATTACH_NOTES,
  type BatterySummary,
  batteryMatchesQueryKey,
  type PolicyBattery,
  useBatteries,
  useBatteryMatches,
  useCreateBatteryInstall,
  useDeleteBatteryInstall,
  usePolicyDeclarations,
  useRemoveBatteryInclude,
  useSetCredentialBinding,
} from "@/lib/openappa-batteries.query";
import type { OpenAppaBatteryChange } from "@/lib/openappa-chat-prompts";
import {
  useAppaGithubSync,
  useAppaSelfService,
} from "@/lib/openappa-github-sync.query";
import {
  type RuntimeCredentialDefinition,
  useCanUseEveryCredential,
  useRuntimeCredentials,
} from "@/lib/runtime-credentials.query";
import { cn } from "@/lib/utils/tailwind";
import {
  type BatteryCredential,
  batteryCredentials,
} from "./battery-credentials";
import { BatteryIcon, type CatalogEntry } from "./battery-icon";
import { BatterySourceDialog } from "./battery-source-dialog";
import {
  BATTERY_STATUS_GROUPS,
  BATTERY_TABLE_STATUS,
  type EnforcedStatus,
} from "./battery-status";
import { batteryStatusHint, batteryTableStatus } from "./battery-table-status";
import { enforcedStatus } from "./composition-view";
import { DialogSection } from "./dialog-section";
import {
  GithubManagedPolicyNotice,
  githubPolicyFileUrl,
} from "./github-managed-policy-notice";
import {
  OpenAppaChatButton,
  useOpenAppaChatLaunch,
} from "./openappa-chat-button";
import { batteryStatusBadge } from "./policy-decorations";
import { policyLineHref } from "./policy-line-href";

const STATUS_OPTIONS = [
  { value: DEFAULT_FILTER_ALL, label: "All statuses" },
  ...BATTERY_STATUS_GROUPS,
];

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
/**
 * One battery's dialog on its own, for a page that names a battery and wants
 * what is wrong with it fixed where the reader is. Renders nothing until the
 * battery is known.
 */
export function BatteryEditDialog({
  name,
  onClose,
}: {
  name: string;
  onClose: () => void;
}) {
  const {
    declarations,
    batteries,
    catalog,
    servers,
    canManage,
    canBind,
    selfService,
    editable,
  } = useBatteryData();
  const policy = declarations.data;
  const summary = batteries.data?.find((battery) => battery.name === name);
  if (!policy || !summary) return null;
  const included =
    policy.batteries.find((entry) => entry.name === name) ?? null;
  return (
    <BatteryDialog
      row={{ name, summary, included }}
      catalog={catalog.data ?? []}
      installedCatalogIds={
        servers.data
          ? new Set(servers.data.map((server) => server.catalogId))
          : null
      }
      credentials={batteryCredentials({
        declarations: policy,
        name,
        variables: summary.credentials ?? [],
      })}
      catalogName={(catalogId) =>
        catalog.data
          ? (catalog.data.find((entry) => entry.id === catalogId)?.name ??
            "Removed server")
          : ""
      }
      status={included ? enforcedStatus(policy, included) : null}
      changes={batteryChanges({
        canManage,
        managedInGithub: policy.managedInGithub,
        selfService,
      })}
      editable={editable}
      bindable={canBind}
      managedInGithub={policy.managedInGithub}
      onClose={onClose}
    />
  );
}

/**
 * How this reader changes a battery: by writing the policy directly, by asking
 * the configuration agent for a pull request while Git sync owns the policy,
 * as a server's editor through the agent while MCP Guardrails Self-Service is
 * on (attach and detach, for the servers they may edit), or not at all.
 */
type BatteryChanges = "direct" | "agent" | "owner" | "none";

function batteryChanges(params: {
  canManage: boolean | undefined;
  managedInGithub: boolean;
  selfService: boolean;
}): BatteryChanges {
  if (params.canManage === true)
    return params.managedInGithub ? "agent" : "direct";
  return params.managedInGithub && params.selfService ? "owner" : "none";
}

/** What the batteries, and one battery's dialog, are drawn from. */
function useBatteryData() {
  const declarations = usePolicyDeclarations();
  const batteries = useBatteries();
  // Battery matching reads each entry's server URL and image, which only the
  // full catalog carries.
  const catalog = useInternalMcpCatalog();
  // Which entries are installed: every visible install's catalog id is in the
  // registry's issue index. Without the right to list installs the answer is
  // unknown (undefined), as it was when the server list was not loaded.
  const { data: canReadInstallations } = useHasPermissions({
    mcpServerInstallation: ["read"],
  });
  const { data: issueIndex } = useMcpRegistryIssueIndex({
    enabled: !!canReadInstallations,
  });
  const servers = {
    data: canReadInstallations ? issueIndex?.servers : undefined,
  };
  const { data: canManage } = useHasPermissions({
    guardrailsPolicy: ["update"],
  });
  // Binding a credential hands its value to helper code, and an uploaded
  // package may carry such code, so both take Can use on every credential too.
  const { data: canUseEveryCredential } = useCanUseEveryCredential();
  const canBind = canManage === true && canUseEveryCredential === true;
  // A server's editor attaches and detaches its batteries through the agent
  // while self-service is on, as they change its rules.
  const selfService = useAppaSelfService(canManage === false).data?.enabled;
  const editable = new Set(
    (catalog.data ?? [])
      .filter(
        (entry) =>
          !isBuiltInCatalogId(entry.id) &&
          (entry.effectiveActions?.includes("update") ?? false),
      )
      .map((entry) => entry.id),
  );
  return {
    declarations,
    batteries,
    catalog,
    servers,
    canManage,
    canBind,
    selfService: selfService === true,
    editable,
  };
}

export function BatteriesPanel() {
  const {
    declarations,
    batteries,
    catalog,
    servers,
    canManage,
    canBind,
    selfService,
    editable,
  } = useBatteryData();
  // Filters and page live in the URL, so a reload or a shared link keeps them.
  const {
    searchParams,
    pageIndex,
    pageSize,
    updateQueryParams,
    setPagination,
  } = useDataTableQueryParams();
  const search = searchParams.get("search") ?? "";
  const statusFilter = knownFilter(STATUS_OPTIONS, searchParams.get("status"));
  // `?battery=<name>` opens that battery, so other pages can link to it.
  const [editing, setEditing] = useState<string | null>(
    searchParams.get("battery"),
  );
  const [removing, setRemoving] = useState<string | null>(null);
  const setFilter = (name: "status", value: string) =>
    updateQueryParams({
      [name]: value === DEFAULT_FILTER_ALL ? null : value,
      page: "1",
    });
  const clearFilters = () =>
    updateQueryParams({ search: null, status: null, page: "1" });
  const hasActiveFilters =
    !!search.trim() || statusFilter !== DEFAULT_FILTER_ALL;
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
  const policy = declarations.data;
  const { managedInGithub } = policy;
  // A line of the policy's aliases that names a battery the policy does not
  // include: it does nothing, and the policy is where it is removed.
  const { unusedAliases } = policy;
  const unusedAliasNote = `${
    unusedAliases.length === 1
      ? "One alias in the policy names a battery it does not include"
      : `${unusedAliases.length} aliases in the policy name batteries it does not include`
  }: ${unusedAliases.map((alias) => alias.namespace).join(", ")}.`;
  const included = policy.batteries;
  const statusOf = (entry: PolicyBattery) => enforcedStatus(policy, entry);
  // The repository owns the text while it syncs: an edit here would be undone
  // by the next pull, so each change goes to the configuration agent, which
  // opens a pull request. Bindings live beside the text, so they stay open.
  const changes = batteryChanges({ canManage, managedInGithub, selfService });
  const bindable = canBind === true;
  // Unknown while the catalog loads; only a loaded catalog can say a server is gone.
  const catalogName = (catalogId: string) =>
    catalog.data
      ? (catalog.data.find((entry) => entry.id === catalogId)?.name ??
        "Removed server")
      : "";
  const installedCatalogIds = servers.data
    ? new Set(servers.data.map((server) => server.catalogId))
    : null;
  // One row per battery that exists. An entry naming no battery is an error in
  // the policy text, which the Policy page marks on its line.
  const rows: BatteryTableRow[] = batteries.data.map((summary) => ({
    name: summary.name,
    summary,
    included: included.find((entry) => entry.name === summary.name) ?? null,
  }));
  // Read from the rows each render, so the open dialog follows every write.
  const editingRow = rows.find((row) => row.name === editing) ?? null;
  const query = search.trim().toLowerCase();
  const filteredRows = rows.filter((row) => {
    return (
      (!query ||
        [
          row.name,
          row.summary?.description ?? "",
          ...(row.summary?.namespaces ?? []),
        ].some((value) => value.toLowerCase().includes(query))) &&
      (statusFilter === DEFAULT_FILTER_ALL ||
        BATTERY_TABLE_STATUS[batteryTableStatus(row.included)].group ===
          statusFilter)
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
          icon={
            <RowBatteryIcon row={row.original} catalog={catalog.data ?? []} />
          }
        />
      ),
    },
    {
      id: "status",
      header: "Status",
      size: 220,
      cell: ({ row }) => (
        <BatteryStatusCell
          battery={row.original.included}
          catalogName={catalogName}
        />
      ),
    },
    // A read-only reader opens a battery by clicking its row: no action is left.
    ...(changes === "direct" || changes === "agent"
      ? [
          {
            id: "actions",
            header: "Actions",
            size: 96,
            cell: ({ row }: { row: { original: BatteryTableRow } }) => (
              <BatteryRowActions
                row={row.original}
                changes={changes}
                onEdit={() => setEditing(row.original.name)}
                onRemove={() => setRemoving(row.original.name)}
              />
            ),
          } satisfies ColumnDef<BatteryTableRow>,
        ]
      : []),
  ];
  return (
    <section aria-label="OpenAPPA batteries" className="space-y-4">
      {/* A healthy sync is a chip in the toolbar; only what asks for something takes a row. */}
      {managedInGithub && <GithubManagedPolicyNotice hideHealthy />}
      {(changes === "direct" || changes === "agent") &&
        servers.data?.length === 0 && (
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
        {/* What the page has to say beside its filters stays on their row. */}
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
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
                value={statusFilter}
                showSearch={false}
                onValueChange={(value) => setFilter("status", value)}
                placeholder="Filter by status"
                items={STATUS_OPTIONS}
              />
            </FilterBar>
          </div>
          {managedInGithub && <GithubManagedPolicyNotice healthyOnly />}
          {unusedAliases.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  href={`/openappa/policy?line=${unusedAliases[0].line}`}
                  aria-label={unusedAliasNote}
                  className="flex size-7 shrink-0 items-center justify-center rounded-md text-amber-600 outline-none hover:bg-amber-500/10 focus-visible:bg-amber-500/10 dark:text-amber-400"
                >
                  <TriangleAlert className="size-4" aria-hidden />
                </Link>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="end" className="max-w-60">
                {`${unusedAliasNote} Click to see it in the policy.`}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
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
        fixedWidthColumnIds={["status", "actions"]}
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
          credentials={batteryCredentials({
            declarations: declarations.data,
            name: editingRow.name,
            variables: editingRow.summary?.credentials ?? [],
          })}
          catalogName={catalogName}
          status={editingRow.included ? statusOf(editingRow.included) : null}
          changes={changes}
          editable={editable}
          bindable={bindable}
          managedInGithub={managedInGithub}
          onClose={() => {
            setEditing(null);
            if (searchParams.has("battery"))
              updateQueryParams({ battery: null });
          }}
        />
      )}
      {removing && (
        <RemoveBatteryDialog
          name={removing}
          onClose={() => setRemoving(null)}
        />
      )}
    </section>
  );
}

type BatteryTableRow = {
  name: string;
  summary: BatterySummary | null;
  included: PolicyBattery | null;
};

/** A row's status badge; a problem status says on hover what it means. */
function BatteryStatusCell({
  battery,
  catalogName,
}: {
  battery: PolicyBattery | null;
  catalogName: (catalogId: string) => string;
}) {
  const status = batteryTableStatus(battery);
  const { label, group } = BATTERY_TABLE_STATUS[status];
  if (status === "not_configured")
    return <span className="text-muted-foreground">{label}</span>;
  const badge = (
    <Badge variant={group === "attention" ? "destructive" : "secondary"}>
      {label}
    </Badge>
  );
  const hint = batteryStatusHint({ battery, catalogName });
  if (!hint) return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent className="max-w-72">{hint}</TooltipContent>
    </Tooltip>
  );
}

const UNBOUND = "__unbound__";

/** A row's mark, as the shared battery icon resolves it. */
function RowBatteryIcon({
  row,
  catalog,
}: {
  row: BatteryTableRow;
  catalog: CatalogEntry[];
}) {
  return (
    <BatteryIcon
      name={row.name}
      bundled={row.summary?.source === "bundled"}
      catalogIds={
        row.summary?.installs.map((install) => install.catalogId) ?? []
      }
      catalog={catalog}
    />
  );
}

/**
 * Everything one battery lets you change, in one place: where it applies and
 * which keys its helpers read, with a link to its source once the policy
 * includes it. Each change writes directly to the policy, or, while Git sync
 * owns it, opens the configuration agent on that change.
 */
function BatteryDialog({
  row,
  catalog,
  installedCatalogIds,
  credentials,
  catalogName,
  status,
  changes,
  editable,
  bindable,
  managedInGithub,
  onClose,
}: {
  row: BatteryTableRow;
  catalog: CatalogEntry[];
  installedCatalogIds: Set<string> | null;
  credentials: BatteryCredential[];
  catalogName: (catalogId: string) => string;
  /** How the enforced composition holds it; null when it is not included. */
  status: EnforcedStatus | null;
  changes: BatteryChanges;
  /** The catalogs the reader may edit, whose batteries an owner may change. */
  editable: ReadonlySet<string>;
  bindable: boolean;
  managedInGithub: boolean;
  onClose: () => void;
}) {
  const { summary, included } = row;
  const router = useRouter();
  const create = useCreateBatteryInstall();
  const bind = useSetCredentialBinding();
  const detach = useDeleteBatteryInstall();
  const remove = useRemoveBatteryInclude();
  const pending =
    create.isPending || bind.isPending || detach.isPending || remove.isPending;
  const writable = changes === "direct";
  const battery = launchBattery(row);
  const organizationWide =
    (included?.scope ?? summary?.scope) === "organization";
  // Under Git sync the dialog's changes wait for Save, which asks the
  // configuration agent for all of them at once: one proposal to approve,
  // one pull request. A server's editor changes only servers, never the
  // organization's batteries, and only a bundled battery: an uploaded
  // package stays with who may update guardrails.
  const staging =
    changes === "agent" ||
    (changes === "owner" &&
      !organizationWide &&
      editable.size > 0 &&
      (included?.source ?? summary?.source) !== "upload");
  const [staged, setStaged] = useState<StagedChanges>(NOTHING_STAGED);
  const stagedChanges = stagedBatteryChanges(staged, battery);
  // A server's editor saves through one tool call, which changes a bounded
  // number of servers: past it, nothing more is staged until Save.
  const stagingFull =
    changes === "owner" &&
    staged.attach.length + staged.detach.length >= MAX_SERVER_EDITOR_CHANGES;
  const saveLaunch = useOpenAppaChatLaunch({
    subject: {
      kind: "batteryChanges",
      changes: stagedChanges,
      serverEditor: changes === "owner",
    },
    permissions: agentPermissions(changes),
    enabled: staging,
  });
  const reload = useReloadMcpServerTools();
  const [saving, setSaving] = useState(false);
  // The server whose tools Save could not sync, by name.
  const [syncFailed, setSyncFailed] = useState<string | null>(null);
  const save = async () => {
    const href = saveLaunch.href;
    if (!href) return;
    setSaving(true);
    setSyncFailed(null);
    // A server whose tools were never synced has no prefix to point the
    // battery at: its tools are synced first.
    for (const { entry, syncFrom } of staged.attach) {
      if (!syncFrom) continue;
      try {
        await reload.mutateAsync(syncFrom);
      } catch {
        // The staged changes stay, for another try or an Undo.
        setSyncFailed(entry.name);
        setSaving(false);
        return;
      }
    }
    router.push(href);
  };
  const badge = status ? batteryStatusBadge(status) : null;
  const installs = summary?.installs ?? [];
  const servers = included?.servers ?? [];
  const governed = new Set(
    servers
      .map((server) => server.catalogId)
      .filter((id): id is string => id !== null),
  );
  // Inspecting a battery: its file on the Policy page, once the policy includes it.
  const viewSource = included ? (
    <Button asChild variant="link" size="sm" className="h-auto p-0">
      <Link href={policyLineHref({ entry: included.entry, line: null })}>
        <FileCode className="size-3.5" />
        <span>View source</span>
      </Link>
    </Button>
  ) : null;
  return (
    <StandardDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="medium"
      title={
        <span className="flex items-center gap-2.5">
          <RowBatteryIcon row={row} catalog={catalog} />
          <span>{row.name}</span>
          {badge && (
            <Badge variant={badge.variant} className="font-normal">
              {badge.label}
            </Badge>
          )}
        </span>
      }
      description={summary?.description}
      // The title row is left-aligned (icon, name, badge), so the copy under
      // it is too, at every width.
      headerClassName="text-left"
      bodyClassName="space-y-6"
      isDirty={stagedChanges.length > 0}
      footer={
        staging ? (
          <>
            <DialogCancelButton />
            <PermissionButton
              type="button"
              permissions={saveLaunch.permissions}
              disabled={
                stagedChanges.length === 0 || !saveLaunch.href || saving
              }
              onClick={() => void save()}
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              <span>Save</span>
            </PermissionButton>
          </>
        ) : (
          <DialogCancelButton>Close</DialogCancelButton>
        )
      }
    >
      {summary && !included && <BatteryPreviewSection summary={summary} />}
      {organizationWide ? (
        <DialogSection title="Scope" action={viewSource}>
          <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-3">
            <div className="space-y-0.5">
              <Label htmlFor={`battery-include-${row.name}`}>
                Include in policy
              </Label>
              <p className="text-xs text-muted-foreground">
                Its rules check every tool call in the organization.
              </p>
            </div>
            {staging ? (
              // The switch shows the change Save asks for; the pull request
              // makes it.
              <Switch
                id={`battery-include-${row.name}`}
                checked={staged.include ?? included !== null}
                disabled={!summary || saving}
                onCheckedChange={(enabled) =>
                  setStaged((current) => ({
                    ...current,
                    include: enabled === (included !== null) ? null : enabled,
                  }))
                }
              />
            ) : (
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
            )}
          </div>
          {managedInGithub && (changes === "none" || changes === "owner") && (
            <p className="text-xs text-muted-foreground">
              <span>
                The policy repository decides which batteries are included. Add
                it to{" "}
              </span>
              <code className="font-mono">include</code>
              <span> there. </span>
              <PolicyFileLink />
            </p>
          )}
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
          description={
            writable && servers.length === 1
              ? "Its rules check tool calls on these servers. Detaching the last one also removes the battery from the policy."
              : "Its rules check tool calls on these servers."
          }
          action={viewSource}
        >
          {servers.length === 0 && staged.attach.length === 0 ? (
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
                const detachLabel = `Detach ${row.name} from ${name}`;
                const serverId = server.catalogId;
                const detaching =
                  serverId !== null &&
                  staged.detach.some(({ id }) => id === serverId);
                return (
                  <ServerRow
                    key={server.target}
                    catalogEntry={
                      catalog.find((entry) => entry.id === server.catalogId) ??
                      null
                    }
                    name={name}
                    detail={
                      detaching
                        ? "Detached when you save"
                        : `${server.target}__*`
                    }
                    action={
                      writable && install !== null && serverId ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={pending}
                          aria-label={detachLabel}
                          onClick={() => detach.mutate(install.id)}
                        >
                          <Unlink className="size-4" />
                          <span>Detach</span>
                        </Button>
                      ) : staging &&
                        serverId &&
                        (changes === "agent" || editable.has(serverId)) ? (
                        detaching ? (
                          <UndoButton
                            label={`Keep ${row.name} on ${name}`}
                            disabled={saving}
                            onClick={() =>
                              setStaged((current) => ({
                                ...current,
                                detach: current.detach.filter(
                                  ({ id }) => id !== serverId,
                                ),
                              }))
                            }
                          />
                        ) : (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={saving || stagingFull}
                            aria-label={detachLabel}
                            onClick={() =>
                              setStaged((current) => ({
                                ...current,
                                detach: [
                                  ...current.detach,
                                  {
                                    id: serverId,
                                    name,
                                    toolPrefix: server.target,
                                  },
                                ],
                              }))
                            }
                          >
                            <Unlink className="size-4" />
                            <span>Detach</span>
                          </Button>
                        )
                      ) : null
                    }
                  />
                );
              })}
              {staged.attach.map(({ entry }) => (
                <ServerRow
                  key={entry.id}
                  catalogEntry={entry}
                  name={entry.name}
                  detail="Attached when you save"
                  action={
                    <UndoButton
                      label={`Do not attach ${row.name} to ${entry.name}`}
                      disabled={saving}
                      onClick={() =>
                        setStaged((current) => ({
                          ...current,
                          attach: current.attach.filter(
                            (attach) => attach.entry.id !== entry.id,
                          ),
                        }))
                      }
                    />
                  }
                />
              ))}
            </ul>
          )}
          {syncFailed !== null && (
            <p role="alert" className="text-sm text-destructive">
              Could not sync the tools of {syncFailed}, so nothing was saved.
              Check the server's connection and save again, or undo that server.
            </p>
          )}
          {stagingFull && (
            <p className="text-sm text-muted-foreground">
              One save changes up to {MAX_SERVER_EDITOR_CHANGES} servers. Save
              these changes to change more.
            </p>
          )}
          {summary && (writable || staging) && (
            <AttachServerPicker
              batteryName={summary.name}
              // A server's editor attaches to the servers they may edit.
              catalog={
                changes === "owner"
                  ? catalog.filter((entry) => editable.has(entry.id))
                  : catalog
              }
              installedCatalogIds={installedCatalogIds}
              taken={
                new Set([
                  ...governed,
                  ...staged.attach.map(({ entry }) => entry.id),
                ])
              }
              pending={pending || saving || stagingFull}
              attach={
                writable
                  ? {
                      kind: "direct",
                      onAttach: (catalogId, onSuccess) =>
                        create.mutate(
                          { batteryName: row.name, catalogId },
                          { onSuccess },
                        ),
                    }
                  : {
                      kind: "staged",
                      onStage: (entry, syncFrom) =>
                        setStaged((current) => ({
                          ...current,
                          attach: [...current.attach, { entry, syncFrom }],
                        })),
                    }
              }
            />
          )}
        </DialogSection>
      )}
      {credentials.length > 0 && (
        <CredentialsSection
          batteryName={row.name}
          credentials={credentials}
          onChange={(variable, key) =>
            bind.mutate({ variable, key: key === UNBOUND ? null : key })
          }
          bindable={bindable}
          managedInGithub={managedInGithub}
          agentBattery={changes === "agent" ? battery : null}
          pending={pending}
        />
      )}
    </StandardDialog>
  );
}

/**
 * A look at a battery the policy does not include yet: where it applies, the
 * namespaces and annotators its rules use and the keys its helpers read, with
 * its source a click away in a dialog of its own.
 */
function BatteryPreviewSection({ summary }: { summary: BatterySummary }) {
  const [sourceOpen, setSourceOpen] = useState(false);
  const names = (values: string[]) =>
    values.length === 0 ? (
      <span className="text-muted-foreground">None</span>
    ) : (
      <span className="font-mono text-xs">{values.join(", ")}</span>
    );
  const facts: [string, ReactNode][] = [
    [
      "Applies to",
      <span key="scope">
        {summary.scope === "organization"
          ? "Every tool call in the organization"
          : "Tool calls on the servers it is attached to"}
      </span>,
    ],
    ["Namespaces", names(summary.namespaces)],
    ["Annotators", names(summary.annotators)],
    ["Credentials", names(summary.credentials)],
  ];
  return (
    <DialogSection
      title="What it checks"
      action={
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0"
          onClick={() => setSourceOpen(true)}
        >
          <FileCode className="size-3.5" />
          <span>Preview source</span>
        </Button>
      }
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-md border px-3 py-2.5 text-sm">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>
      {sourceOpen && (
        <BatterySourceDialog
          name={summary.name}
          onClose={() => setSourceOpen(false)}
        />
      )}
    </DialogSection>
  );
}

/**
 * A battery as a change names it. A battery the policy does not include yet
 * has no entry of its own, so it gets the one an include would spell: the
 * same spelling the backend gives a bundled battery or an uploaded package.
 */
function launchBattery(row: BatteryTableRow) {
  const hash =
    row.summary?.source === "upload" ? row.summary.contentHash : null;
  return {
    name: row.name,
    entry:
      row.included?.entry ??
      (hash
        ? `batteries/${row.name}@sha256-${hash}/appa.toml`
        : `batteries/${row.name}/appa.toml`),
    namespaces: row.summary?.namespaces ?? [],
  };
}

/**
 * What a chat launch for a battery change takes: the permission to update
 * guardrails for a manager, none beyond reading for a server's editor, whose
 * edit access to the server the agent and the policy check hold them to.
 */
function agentPermissions(changes: BatteryChanges): Permissions {
  return changes === "owner" ? {} : { guardrailsPolicy: ["update"] };
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
      {/* Name over the tool pattern, so neither squeezes the other or the
          action on a narrow dialog. */}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{name}</span>
        <span
          className={cn(
            "block truncate text-xs text-muted-foreground",
            detail.endsWith("__*") && "font-mono",
          )}
        >
          {detail}
        </span>
      </span>
      {action && <div className="shrink-0">{action}</div>}
    </li>
  );
}

/**
 * Pick an installed server the battery does not govern yet and add it to the
 * list, or, while Git sync owns the policy, stage it for the dialog's Save.
 * A server whose tools were never synced has them synced on the way: at
 * once here, or on Save for a staged one.
 */
function AttachServerPicker({
  batteryName,
  catalog,
  installedCatalogIds,
  taken,
  pending,
  attach: action,
}: {
  batteryName: string;
  catalog: CatalogEntry[];
  installedCatalogIds: Set<string> | null;
  taken: Set<string>;
  pending: boolean;
  attach:
    | {
        kind: "direct";
        onAttach: (catalogId: string, onSuccess: () => void) => void;
      }
    | {
        kind: "staged";
        /** The server, and the install whose tools Save syncs first, if any. */
        onStage: (entry: CatalogEntry, syncFrom: SyncTarget | null) => void;
      };
}) {
  const client = useQueryClient();
  const [catalogId, setCatalogId] = useState("");
  const readiness = useBatteryMatches(catalogId, catalogId !== "");
  const attach = readiness.data?.attach ?? null;
  const syncTarget = useSyncTarget(catalogId);
  const canSync =
    useHasPermissions({ mcpServerInstallation: ["create"] }).data === true;
  const reload = useReloadMcpServerTools();
  // The server whose sync on Attach failed: it shows why it cannot attach.
  const [syncFailed, setSyncFailed] = useState("");
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
  const picked = options.find((entry) => entry.id === catalogId) ?? null;
  // Unsynced tools are synced on Attach, by whoever may sync them.
  const syncs =
    attach === "unsynced" &&
    canSync &&
    syncTarget !== null &&
    syncFailed !== catalogId;
  const ready =
    !pending &&
    !reload.isPending &&
    picked !== null &&
    (attach === "ready" || syncs);
  const busy = (catalogId !== "" && readiness.isFetching) || reload.isPending;
  const onAttach = async () => {
    if (!picked) return;
    const reset = () => setCatalogId("");
    if (action.kind === "staged") {
      action.onStage(picked, syncs ? syncTarget : null);
      reset();
      return;
    }
    if (syncs && syncTarget) {
      try {
        await reload.mutateAsync(syncTarget);
      } catch {
        setSyncFailed(picked.id);
        return;
      }
      await client.invalidateQueries({
        queryKey: batteryMatchesQueryKey(picked.id),
      });
    }
    action.onAttach(picked.id, reset);
  };
  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <Label htmlFor={id}>Attach to a server</Label>
        <p className="text-xs text-muted-foreground">
          Points the battery's rules at this server's tools. The server itself
          doesn't change.
        </p>
      </div>
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
          disabled={!ready}
          onClick={() => void onAttach()}
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Plus className="size-4" />
          )}
          <span>Attach</span>
        </Button>
      </div>
      {attach !== null && attach !== "ready" && !syncs && (
        <p
          role="note"
          className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
        >
          <span>
            {syncFailed === catalogId
              ? "Could not sync this server's tools, so the battery has no tools to attach to yet. Check the server's connection, then sync again."
              : ATTACH_NOTES[attach]}
          </span>
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

/** Undo a change the dialog staged for Save. */
function UndoButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={disabled}
      aria-label={label}
      onClick={onClick}
    >
      <Undo2 className="size-4" />
      <span>Undo</span>
    </Button>
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
 *
 * Anyone who can read credentials sees the list, so a bound key reads as what
 * it is even when this reader cannot change it. While the repository owns the
 * policy, a pick is a draft: nothing is saved here, and the section shows the
 * line to change in the repository instead.
 */
function CredentialsSection({
  batteryName,
  credentials,
  onChange,
  bindable,
  managedInGithub,
  agentBattery,
  pending,
}: {
  batteryName: string;
  credentials: BatteryCredential[];
  onChange: (variable: string, key: string) => void;
  bindable: boolean;
  managedInGithub: boolean;
  /** The battery, when a policy line's removal goes to the configuration agent. */
  agentBattery: OpenAppaBatteryChange["battery"] | null;
  pending: boolean;
}) {
  const { data: canRead } = useHasPermissions({ credential: ["read"] });
  const canSeeSettings = useSettingsAreaAccess() === true;
  const listable = canRead === true;
  const available = useRuntimeCredentials(listable);
  const { refetch } = available;
  useEffect(() => {
    if (!listable) return;
    const reload = () => refetch();
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [listable, refetch]);
  const options = available.data ?? [];
  return (
    <DialogSection
      title="Credentials"
      description={
        bindable
          ? credentials.length === 1
            ? "This battery needs an API token. Choose a saved credential for it."
            : "This battery needs API tokens. Choose a saved credential for each one."
          : "Changing a key takes permission to update guardrails and credentials."
      }
      action={
        canSeeSettings ? (
          <Button asChild variant="link" size="sm" className="h-auto p-0">
            <Link href="/settings/credentials" target="_blank" rel="noreferrer">
              <span>Manage credentials</span>
              <ExternalLink className="size-3.5" />
            </Link>
          </Button>
        ) : null
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
            listed={available.isSuccess}
            managedInGithub={managedInGithub}
            agentBattery={agentBattery}
            disabled={!bindable || pending || credential.source === "policy"}
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
  listed,
  managedInGithub,
  agentBattery,
  disabled,
  onChange,
}: {
  batteryName: string;
  credential: BatteryCredential;
  value: string;
  options: RuntimeCredentialDefinition[];
  /** The organization's credentials loaded, so a key missing from them is gone. */
  listed: boolean;
  managedInGithub: boolean;
  agentBattery: OpenAppaBatteryChange["battery"] | null;
  disabled: boolean;
  onChange: (key: string) => void;
}) {
  const [kept, setKept] = useState(false);
  const others = credential.readers.filter((reader) => reader !== batteryName);
  // The policy can name a key the list does not offer — deleted, never
  // created, or a list this reader cannot load — and the binding still has
  // to read as what it is. Only a loaded list can say the key is missing.
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
        <SelectContent
          position="popper"
          className="w-[var(--radix-select-trigger-width)]"
        >
          <SelectItem value={UNBOUND}>Not set</SelectItem>
          {unlisted !== null && (
            <SelectItem
              value={unlisted}
              disabled
              description={listed ? "No credential has this key" : undefined}
            >
              <CredentialOptionLabel icon={null} name={unlisted} />
            </SelectItem>
          )}
          {options.map((entry) => (
            <SelectItem
              key={entry.key}
              value={entry.key}
              // The helper runs for the whole organization, so a personal-only
              // credential cannot be bound; it is listed as such rather than hidden.
              disabled={!entry.allowOrganization}
              description={
                <span className="line-clamp-2 whitespace-normal">
                  <span>
                    {!entry.allowOrganization
                      ? "Personal credential · batteries need an organization credential"
                      : entry.organizationConfigured
                        ? "Organization credential"
                        : "Organization credential · no organization value yet"}
                  </span>
                  {entry.description && (
                    <span>{` · ${entry.description}`}</span>
                  )}
                </span>
              }
            >
              <CredentialOptionLabel
                icon={runtimeCredentialIconOf(entry)}
                name={entry.name}
              />
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {credential.source === "policy" &&
        (managedInGithub ? (
          <p className="text-xs text-muted-foreground">
            <span>
              Set in the policy repository. Remove its line there to manage it
              here.
            </span>
            <span> </span>
            {agentBattery && (
              <>
                <OpenAppaChatButton
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs"
                  permissions={{ guardrailsPolicy: ["update"] }}
                  batteryChange={{
                    promptKey: "removeCredentialLine",
                    battery: agentBattery,
                    variable: credential.variable,
                  }}
                >
                  <span>Remove it by pull request</span>
                </OpenAppaChatButton>
                <span> </span>
              </>
            )}
            <PolicyFileLink />
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Set by a [credentials] line in the policy text. Ask the
            configuration agent to remove it to manage it here.
          </p>
        ))}
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

/** The synced policy file on GitHub, when the sync names one. */
function PolicyFileLink() {
  const { data } = useAppaGithubSync();
  const href = githubPolicyFileUrl(data, "blob");
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 underline underline-offset-2 hover:no-underline"
    >
      <span>Open the policy file</span>
      <ExternalLink className="size-3" aria-hidden />
      <span className="sr-only">(opens in new tab)</span>
    </a>
  );
}

/** A credential's icon and name, which the select's trigger shows as well. */
function CredentialOptionLabel({
  icon,
  name,
}: {
  icon: string | null;
  name: string;
}) {
  // One row of its own: Radix drops ItemText's class, so the open list would
  // otherwise stack the block-level icon above the name.
  return (
    <span className="flex min-w-0 items-center gap-2">
      <RuntimeCredentialIcon icon={icon} className="size-4" size={16} />
      <span className="truncate">{name}</span>
    </span>
  );
}

/**
 * Edit, and Remove from policy for an included battery: a confirmation that
 * writes the policy, or, while Git sync owns it, the configuration agent.
 */
function BatteryRowActions({
  row,
  changes,
  onEdit,
  onRemove,
}: {
  row: BatteryTableRow;
  changes: BatteryChanges;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const removeLaunch = useOpenAppaChatLaunch({
    subject: {
      kind: "battery",
      change: { promptKey: "removeBattery", battery: launchBattery(row) },
    },
    permissions: { guardrailsPolicy: ["update"] },
    enabled: changes === "agent" && row.included !== null,
  });
  const remove =
    changes === "agent"
      ? {
          icon: <Unlink className="size-4" />,
          label: "Remove from policy",
          href: removeLaunch.href ?? undefined,
          disabled: !removeLaunch.href,
          permissions: removeLaunch.permissions,
          variant: "destructive" as const,
        }
      : {
          icon: <Unlink className="size-4" />,
          label: "Remove from policy",
          onClick: onRemove,
          variant: "destructive" as const,
        };
  return (
    <RowClickShield>
      <TableRowActions
        itemName={row.name}
        actions={[
          {
            icon: <Pencil className="size-4" />,
            label: "Edit",
            onClick: onEdit,
          },
          // One more action stays in the row: a menu holding one item hides
          // it and saves no width.
          ...(row.included ? [remove] : []),
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

/**
 * Re-discover the tools of the picked server, which is what gives an alias a
 * target. Shown where Attach cannot sync them itself: without the permission
 * to, or without a connection to sync from.
 */
function SyncToolsButton({ catalogId }: { catalogId: string }) {
  const client = useQueryClient();
  const target = useSyncTarget(catalogId);
  const reload = useReloadMcpServerTools();
  return (
    <PermissionButton
      permissions={{ mcpServerInstallation: ["create"] }}
      type="button"
      variant="outline"
      size="sm"
      disabled={reload.isPending || target === null}
      tooltip={
        target === null
          ? "Connect this server first: syncing tools needs a live connection"
          : undefined
      }
      onClick={() =>
        target &&
        reload.mutate(target, {
          onSuccess: () =>
            client.invalidateQueries({
              queryKey: batteryMatchesQueryKey(catalogId),
            }),
        })
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

/** The install a catalog entry's tools are synced from. */
type SyncTarget = { id: string; name: string; catalogId: string };

/**
 * The install that stands for a catalog entry when its tools are synced: the
 * reload endpoint takes an install, not the entry, so the newest one stands
 * for it. Null without one, or before an entry is picked.
 */
function useSyncTarget(catalogId: string): SyncTarget | null {
  // Only this entry's installs, without agents.
  const servers = useMcpServers({
    includeAssignedAgents: false,
    catalogId,
    enabled: catalogId !== "",
  });
  if (!catalogId) return null;
  const newest = (servers.data ?? [])
    .filter((server) => server.catalogId === catalogId)
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )[0];
  return newest ? { id: newest.id, name: newest.name, catalogId } : null;
}

/** What a battery's dialog holds for Save while Git sync owns the policy. */
type StagedChanges = {
  attach: { entry: CatalogEntry; syncFrom: SyncTarget | null }[];
  detach: { id: string; name: string; toolPrefix: string }[];
  /** The Include switch's new state, or null when it is left as it is. */
  include: boolean | null;
};

const NOTHING_STAGED: StagedChanges = { attach: [], detach: [], include: null };

/**
 * The servers one battery change of a server's editor may name: the
 * self-service battery tool takes one server and up to 20 others.
 */
const MAX_SERVER_EDITOR_CHANGES = 21;

/** The staged changes as the configuration agent is asked for them. */
function stagedBatteryChanges(
  staged: StagedChanges,
  battery: OpenAppaBatteryChange["battery"],
): OpenAppaBatteryChange[] {
  return [
    ...(staged.include === null
      ? []
      : [
          {
            promptKey: staged.include ? "includeBattery" : "removeBattery",
            battery,
          } as const,
        ]),
    ...staged.attach.map(({ entry }) => ({
      promptKey: "attachBattery" as const,
      battery,
      server: { id: entry.id, name: entry.name },
    })),
    ...staged.detach.map((server) => ({
      promptKey: "detachBattery" as const,
      battery,
      server,
    })),
  ];
}
