"use client";

import {
  BLOB_PROVIDER_TYPE_LABELS,
  type BlobProviderType,
} from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import {
  CircleCheck,
  CircleX,
  Cpu,
  FileSpreadsheet,
  Globe,
  HardDrive,
  KeyRound,
  ListFilter,
  Loader2,
  Pencil,
  Plug,
  Repeat,
  Trash2,
  UserRound,
} from "lucide-react";
import { useMemo, useState } from "react";
import { AgentNameCell } from "@/components/agent-name-cell";
import { openRowOnPlainClick } from "@/components/agent-pages/row-click-shield";
import {
  BlobProviderLogo,
  blobProviderLocation,
} from "@/components/blob-provider-logo";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterSearchClass,
} from "@/components/filter-bar";
import { SearchInput } from "@/components/search-input";
import { TableRowActions } from "@/components/table-row-actions";
import { BulkActions } from "@/components/ui/bulk-actions-bar";
import { BulkActionsScope } from "@/components/ui/bulk-actions-context";
import { createSelectColumn } from "@/components/ui/bulk-select-column";
import { DataTable } from "@/components/ui/data-table";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { BlobProvider } from "@/lib/blob-provider.query";
import { useBulkSelection } from "@/lib/hooks/use-bulk-selection";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";

export type BlobProviderTestResult = {
  success: boolean;
  message: string;
  at: Date;
};

/**
 * The organization's blob providers: where each writes and who it signs in
 * as, with search, a provider filter, and bulk test and delete.
 */
export function BlobProvidersTable({
  providers,
  isLoading,
  onEdit,
  onDelete,
  onTest,
  onBulkDelete,
  testingIds,
  testResults,
}: {
  providers: BlobProvider[];
  isLoading: boolean;
  onEdit: (provider: BlobProvider) => void;
  onDelete: (provider: BlobProvider) => void;
  onTest: (providers: readonly BlobProvider[]) => Promise<unknown>;
  /** Resolves once the batch is done; the selection clears on full success. */
  onBulkDelete: (
    providers: readonly BlobProvider[],
  ) => Promise<{ failed: unknown[] }>;
  testingIds: ReadonlySet<string>;
  testResults: Record<string, BlobProviderTestResult | undefined>;
}) {
  const { searchParams, updateQueryParams } = useDataTableQueryParams();
  const search = searchParams.get("search") || "";
  const typeFilter = searchParams.get("type") || ALL;
  const hasActiveFilters = search.trim().length > 0 || typeFilter !== ALL;
  const clearFilters = () =>
    updateQueryParams({ search: null, type: null, page: "1" });
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return providers.filter((provider) => {
      if (typeFilter !== ALL && provider.type !== typeFilter) return false;
      if (!query) return true;
      const { uri, endpoint } = blobProviderLocation(provider);
      return [provider.name, uri, endpoint ?? ""].some((field) =>
        field.toLowerCase().includes(query),
      );
    });
  }, [providers, search, typeFilter]);

  const {
    rowSelection,
    setRowSelection,
    onPageRowIdsChange,
    clearSelection,
    selected,
    selectAllMatching,
  } = useBulkSelection({
    rows: filtered,
    getId: (provider) => provider.id,
    filterSignature: `${search}|${typeFilter}`,
    matchDescription: hasActiveFilters ? "match these filters" : "exist",
  });
  const anyTesting = testingIds.size > 0;

  // The settings shell's content column is ~718px at 1200px wide, and
  // `DataTable` sets its minWidth to the sum of these sizes: 708.
  const columns: ColumnDef<BlobProvider>[] = useMemo(
    () => [
      createSelectColumn<BlobProvider>({
        rowLabel: (provider) => `Select ${provider.name}`,
        allLabel: "Select all blob providers on this page",
      }),
      {
        accessorKey: "name",
        header: "Name",
        size: 160,
        cell: ({ row }) => {
          const provider = row.original;
          return (
            <AgentNameCell
              name={provider.name}
              icon={<BlobProviderLogo type={provider.type} size={20} />}
              description={providerKind(provider)}
              onClick={() => onEdit(provider)}
              nameIndicator={
                <TestIndicator
                  testing={testingIds.has(provider.id)}
                  result={testResults[provider.id]}
                />
              }
            />
          );
        },
      },
      {
        id: "destination",
        header: "Destination",
        size: 208,
        cell: ({ row }) => <DestinationCell provider={row.original} />,
      },
      {
        id: "identity",
        header: "Signs in as",
        size: 172,
        cell: ({ row }) => <IdentityCell provider={row.original} />,
      },
      {
        id: "actions",
        header: "Actions",
        size: 112,
        cell: ({ row }) => {
          const provider = row.original;
          const testing = testingIds.has(provider.id);
          return (
            <TableRowActions
              itemName={provider.name}
              actions={[
                {
                  icon: testing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Plug className="h-4 w-4" />
                  ),
                  label: testing ? "Testing connection…" : "Test connection",
                  permissions: MANAGE,
                  disabled: testing,
                  disabledTooltip: "Testing connection…",
                  onClick: () => void onTest([provider]),
                },
                {
                  icon: <Pencil className="h-4 w-4" />,
                  label: "Edit",
                  permissions: MANAGE,
                  onClick: () => onEdit(provider),
                },
              ]}
              dropdownActions={[
                {
                  icon: <FileSpreadsheet className="h-4 w-4" />,
                  label: "Set up cost export",
                  tooltip: "Schedule FOCUS cost files to this provider",
                  permissions: COST_EXPORT_EDIT,
                  href: `/llm/cost-exports?new=1&blobProviderId=${provider.id}`,
                },
                {
                  icon: <Trash2 className="h-4 w-4" />,
                  label: "Delete",
                  permissions: MANAGE,
                  variant: "destructive",
                  disabled: provider.usedBy.costExports.length > 0,
                  disabledTooltip: inUseReason(provider.usedBy.costExports),
                  onClick: () => onDelete(provider),
                },
              ]}
            />
          );
        },
      },
    ],
    [onEdit, onDelete, onTest, testingIds, testResults],
  );

  return (
    <BulkActionsScope>
      <div>
        {/* Nothing to search or filter until the first provider exists. */}
        {(providers.length > 0 || hasActiveFilters) && (
          <CollectionFilters>
            <FilterBar
              onClearFilters={hasActiveFilters ? clearFilters : undefined}
              search={
                <SearchInput
                  objectNamePlural="blob providers"
                  searchFields={["name", "location"]}
                  className={filterSearchClass}
                />
              }
            >
              <FilterSelect
                value={typeFilter}
                onValueChange={(value) =>
                  updateQueryParams({
                    type: value === ALL ? null : value,
                    page: "1",
                  })
                }
                inactiveValue={ALL}
                placeholder="Filter by provider"
                showSearch={false}
                items={[
                  {
                    value: ALL,
                    label: "All providers",
                    content: (
                      <span className="inline-flex items-center gap-1.5 text-sm">
                        <ListFilter
                          aria-hidden
                          className="size-3.5 shrink-0 text-muted-foreground"
                        />
                        All providers
                      </span>
                    ),
                  },
                  ...PROVIDER_TYPES.map((type) => ({
                    value: type,
                    label: BLOB_PROVIDER_TYPE_LABELS[type],
                    content: (
                      <span className="inline-flex items-center gap-2 text-sm">
                        <BlobProviderLogo type={type} size={14} />
                        {BLOB_PROVIDER_TYPE_LABELS[type]}
                      </span>
                    ),
                  })),
                ]}
              />
            </FilterBar>
          </CollectionFilters>
        )}
        <BulkActions
          count={selected.length}
          noun="blob provider"
          onClear={clearSelection}
          busy={bulkDeleting || anyTesting}
          selectAllMatching={selectAllMatching}
        >
          <PermissionButton
            permissions={{ organizationSettings: ["update"] }}
            variant="outline"
            size="sm"
            disabled={anyTesting}
            onClick={() => void onTest(selected)}
          >
            <Plug className="h-4 w-4" />
            <span>Test connection</span>
          </PermissionButton>
          <PermissionButton
            permissions={{ organizationSettings: ["update"] }}
            variant="destructive"
            size="sm"
            onClick={() => setBulkDeleteOpen(true)}
          >
            <Trash2 className="h-4 w-4" />
            <span>Delete</span>
          </PermissionButton>
        </BulkActions>
        <DataTable
          columns={columns}
          data={filtered}
          isLoading={isLoading && providers.length === 0}
          getRowId={(row) => row.id}
          rowSelection={rowSelection}
          onRowSelectionChange={setRowSelection}
          onPageRowIdsChange={onPageRowIdsChange}
          hideSelectedCount
          onRowClick={(provider, event) =>
            openRowOnPlainClick(event, () => onEdit(provider))
          }
          emptyIcon={HardDrive}
          emptyMessage="No blob providers yet"
          emptyDescription="Connect the bucket or container that features such as scheduled cost exports write files to."
          hasActiveFilters={hasActiveFilters}
          filteredEmptyMessage="No blob providers match your filters"
          onClearFilters={clearFilters}
          hidePaginationWhenSinglePage
          fixedWidthColumnIds={["identity", "actions"]}
          flexibleColumnIds={["name", "destination"]}
        />
      </div>
      {bulkDeleteOpen && (
        <DeleteConfirmDialog
          open={bulkDeleteOpen}
          onOpenChange={setBulkDeleteOpen}
          title="Delete blob providers"
          description={`Delete ${selected.length} ${selected.length === 1 ? "blob provider" : "blob providers"} and their stored credentials? Files already written stay in place. Providers that exports still write to are skipped.`}
          isPending={bulkDeleting}
          confirmLabel="Delete blob providers"
          pendingLabel="Deleting..."
          onConfirm={async () => {
            setBulkDeleting(true);
            try {
              const outcome = await onBulkDelete(selected);
              setBulkDeleteOpen(false);
              if (outcome.failed.length === 0) clearSelection();
            } finally {
              setBulkDeleting(false);
            }
          }}
        />
      )}
    </BulkActionsScope>
  );
}

// === internal ===

const ALL = "all";

/** Why a provider in use can't be deleted, naming what writes to it. */
function inUseReason(costExports: string[]): string {
  const one = costExports.length === 1;
  const shown = costExports.slice(0, 2).map((name) => `"${name}"`);
  const more = costExports.length - shown.length;
  const names =
    more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(" and ");
  return one
    ? `Cost export ${names} writes here. Delete it or move it to another provider first.`
    : `Cost exports ${names} write here. Delete them or move them to another provider first.`;
}
const MANAGE = { organizationSettings: ["update"] } as const;
const COST_EXPORT_EDIT = {
  costExport: ["create"],
  llmCost: ["read"],
} as const;
const PROVIDER_TYPES = Object.keys(
  BLOB_PROVIDER_TYPE_LABELS,
) as BlobProviderType[];

// ===================================================================
// Cells
// ===================================================================

/** Bucket (or account/container) as the dominant line, context muted below. */
function DestinationCell({ provider }: { provider: BlobProvider }) {
  const { config } = provider;
  const { uri } = blobProviderLocation(provider);
  const prefix = config.keyPrefix ? `/${config.keyPrefix}/` : "/";

  const root = config.type === "azure_blob" ? config.container : config.bucket;

  const customEndpoint =
    config.type === "gcs"
      ? null
      : config.endpoint
        ? hostOf(config.endpoint)
        : null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="min-w-0">
          <div className="truncate font-mono text-[13px] leading-5">
            <span className="text-foreground">{root}</span>
            <span className="text-muted-foreground">{prefix}</span>
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {config.type === "s3" && (
              <span className="shrink-0 rounded border px-1 font-mono text-[11px] leading-4">
                {config.region}
              </span>
            )}
            {customEndpoint ? (
              <span className="flex min-w-0 items-center gap-1">
                <Globe className="size-3 shrink-0" />
                <span className="truncate">{customEndpoint}</span>
              </span>
            ) : null}
            {config.type === "azure_blob" && (
              <span className="truncate">
                {customEndpoint && <span>· </span>}
                <span>account {config.accountName}</span>
              </span>
            )}
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-80 break-all font-mono text-xs">
        {uri}
        {customEndpoint && config.type !== "gcs" && config.endpoint && (
          <span className="mt-1 block opacity-70">via {config.endpoint}</span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

/** Who the platform authenticates as, in plain words. */
function IdentityCell({ provider }: { provider: BlobProvider }) {
  const { title, detail, icon: Icon, missing } = describeIdentity(provider);
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-1.5 text-sm leading-5">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate" title={title}>
          {title}
        </span>
      </div>
      <div
        className={`mt-0.5 truncate pl-5 text-xs ${missing ? "text-destructive" : "text-muted-foreground"}`}
        title={detail}
      >
        {detail}
      </div>
    </div>
  );
}

function TestIndicator({
  testing,
  result,
}: {
  testing: boolean;
  result: BlobProviderTestResult | undefined;
}) {
  if (testing) {
    return (
      <Loader2
        className="size-3.5 animate-spin text-muted-foreground"
        aria-label="Testing connection"
      />
    );
  }
  if (!result) return null;
  const Icon = result.success ? CircleCheck : CircleX;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Icon
            className={`size-3.5 ${result.success ? "text-green-600 dark:text-green-500" : "text-destructive"}`}
            aria-label={
              result.success ? "Connection works" : "Connection failed"
            }
          />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        <span className="font-medium">
          {result.success ? "Connection works" : "Connection failed"}
        </span>
        <span className="opacity-70">
          {" "}
          · {formatRelativeTimeFromNow(result.at)}
        </span>
        {result.message && (
          <span className="mt-1 block break-words opacity-80">
            {result.message}
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

// ===================================================================
// Helpers
// ===================================================================

function providerKind(provider: BlobProvider): string {
  const { config } = provider;
  if (config.type === "s3" && config.endpoint) return "S3-compatible";
  return BLOB_PROVIDER_TYPE_LABELS[provider.type];
}

function describeIdentity(provider: BlobProvider): {
  title: string;
  detail: string;
  icon: typeof KeyRound;
  missing?: boolean;
} {
  const { config, hasCredentials } = provider;
  const stored = (what: string) =>
    hasCredentials
      ? { detail: `${what} ••••`, missing: false }
      : { detail: `No ${what.toLowerCase()} stored`, missing: true };

  switch (config.type) {
    case "s3":
      switch (config.authMethod) {
        case "assume_role": {
          const arn = parseRoleArn(config.roleArn);
          return {
            title: arn ? `Assumes role ${arn.role}` : "Assumes an IAM role",
            detail: [
              arn ? `account ${arn.account}` : null,
              config.externalId ? "external ID" : null,
              hasCredentials ? "from access key" : "from process identity",
            ]
              .filter(Boolean)
              .join(" · "),
            icon: Repeat,
          };
        }
        case "access_key":
          return { title: "Access key", icon: KeyRound, ...stored("Key") };
        case "default_chain":
          return {
            title: "Platform's AWS identity",
            detail: "Default credential chain",
            icon: Cpu,
          };
      }
      break;
    case "gcs":
      return config.authMethod === "service_account_key"
        ? {
            title: "Service account key",
            icon: KeyRound,
            ...stored("JSON key"),
          }
        : {
            title: "Workload identity",
            detail: "Application Default Credentials",
            icon: Cpu,
          };
    case "azure_blob":
      switch (config.authMethod) {
        case "service_principal":
          return {
            title: "Service principal",
            detail: config.clientId
              ? `client ${shortId(config.clientId)}${hasCredentials ? " · secret ••••" : ""}`
              : "Entra app registration",
            icon: UserRound,
            missing: !hasCredentials,
          };
        case "account_key":
          return {
            title: "Storage account key",
            icon: KeyRound,
            ...stored("Key"),
          };
        case "sas_token":
          return {
            title: "SAS token",
            icon: KeyRound,
            ...stored("Token"),
          };
        case "default_credential":
          return {
            title: "Workload identity",
            detail: "Azure default credential",
            icon: Cpu,
          };
      }
  }
  return { title: "Unknown", detail: "", icon: KeyRound };
}

function parseRoleArn(
  arn: string | null,
): { account: string; role: string } | null {
  const match = arn?.match(/^arn:[^:]+:iam::(\d+):role\/(?:.*\/)?([^/]+)$/);
  return match ? { account: match[1], role: match[2] } : null;
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}
