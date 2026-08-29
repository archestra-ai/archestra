"use client";

import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { Download, PackageOpen, Pencil, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import {
  FilterBar,
  filterControlClass,
  filterSearchClass,
} from "@/components/filter-bar";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import { SearchInput } from "@/components/search-input";
import {
  TableCard,
  TableCardList,
  TableCardView,
  TableCardViewContent,
  TableCardViewToggle,
} from "@/components/table-card-view";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useProfiles } from "@/lib/agent.query";
import { type Bundle, useBundles, useDeleteBundle } from "@/lib/bundle.query";
import { formatBundleCapabilitySummary } from "@/lib/bundle-capabilities";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { getBundleActions } from "./_parts/bundle-actions-model";
import { bundleDetailHref } from "./_parts/bundle-page-config";

const DESCRIPTION =
  "Create reusable starting points for client setup with approved skills, plugins, and connection settings.";

export default function BundlesPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = (searchParams.get("search") ?? "").trim().toLowerCase();
  const gatewayFilter = searchParams.get("gateway") ?? "all";
  const { data: bundles, isFetching, isLoadingError, refetch } = useBundles();
  const { data: gateways = [] } = useProfiles({
    filters: { agentTypes: ["profile", "mcp_gateway"] },
  });
  const [sorting, setSorting] = useState<SortingState>([
    { id: "updatedAt", desc: true },
  ]);
  const [deleting, setDeleting] = useState<Bundle | null>(null);
  const deleteBundle = useDeleteBundle();

  const setFilter = useCallback(
    (name: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === "all" || value === "") params.delete(name);
      else params.set(name, value);
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );
  const filtered = useMemo(
    () =>
      (bundles ?? []).filter((bundle) => {
        if (
          search &&
          !`${bundle.name} ${bundle.description}`.toLowerCase().includes(search)
        ) {
          return false;
        }
        if (gatewayFilter === "current") return bundle.mcpGatewayId === null;
        if (gatewayFilter !== "all")
          return bundle.mcpGatewayId === gatewayFilter;
        return true;
      }),
    [bundles, gatewayFilter, search],
  );
  const hasActiveFilters = search.length > 0 || gatewayFilter !== "all";
  const clearFilters = useCallback(() => {
    router.push(pathname, { scroll: false });
  }, [pathname, router]);
  const gatewayName = (id: string | null) =>
    id
      ? (gateways.find((gateway) => gateway.id === id)?.name ?? "Unavailable")
      : "Keep current";
  const actionsFor = (bundle: Bundle) => {
    const [install, edit, remove] = getBundleActions(bundle.id);
    const actions: TableRowAction[] = [
      {
        icon: <Download className="size-4" />,
        label: install.label,
        href: install.href,
      },
      {
        icon: <Pencil className="size-4" />,
        label: edit.label,
        href: edit.href,
        permissions: edit.permissions,
      },
    ];
    const dropdownActions: TableRowAction[] = [
      {
        icon: <Trash2 className="size-4" />,
        label: remove.label,
        permissions: remove.permissions,
        variant: "destructive",
        onClick: () => setDeleting(bundle),
      },
    ];
    return (
      <TableRowActions
        actions={actions}
        dropdownActions={dropdownActions}
        itemName={bundle.name}
      />
    );
  };
  const columns: ColumnDef<Bundle>[] = [
    {
      accessorKey: "name",
      header: "Bundle",
      size: 360,
      cell: ({ row }) => (
        <div className="min-w-0">
          <Link
            className="font-medium hover:underline"
            href={bundleDetailHref(row.original.id)}
          >
            {row.original.name}
          </Link>
          <p className="truncate text-xs text-muted-foreground">
            {row.original.description || "No description"}
          </p>
        </div>
      ),
    },
    {
      id: "gateway",
      header: "MCP gateway",
      cell: ({ row }) => (
        <Badge variant="outline">
          {gatewayName(row.original.mcpGatewayId)}
        </Badge>
      ),
    },
    {
      id: "contents",
      header: "Contents",
      cell: ({ row }) =>
        formatBundleCapabilitySummary({
          skillCount: row.original.skillIds.length,
          pluginCount: row.original.pluginIds.length,
          localMcpCount: row.original.localMcpServers.length,
        }),
    },
    {
      accessorKey: "updatedAt",
      header: "Updated",
      cell: ({ row }) => formatRelativeTimeFromNow(row.original.updatedAt),
    },
    {
      id: "actions",
      header: () => <div className="text-right">Actions</div>,
      cell: ({ row }) => (
        <div className="flex justify-end">{actionsFor(row.original)}</div>
      ),
    },
  ];

  if (isLoadingError) {
    return (
      <PageLayout title="Bundles" description={DESCRIPTION}>
        <QueryLoadError title="Couldn't load your bundles" onRetry={refetch} />
      </PageLayout>
    );
  }
  const showEmptyState =
    !isFetching && (bundles?.length ?? 0) === 0 && !hasActiveFilters;

  return (
    <>
      <PageLayout
        title="Bundles"
        status={<Badge variant="secondary">Beta</Badge>}
        description={DESCRIPTION}
        actionButton={
          !showEmptyState ? (
            <PermissionButton permissions={{ bundle: ["create"] }} asChild>
              <Link href="/bundles/new">
                <Plus className="size-4" />
                <span>New bundle</span>
              </Link>
            </PermissionButton>
          ) : undefined
        }
      >
        <TableCardView storageKey="archestra-bundles-view" defaultMode="table">
          {showEmptyState ? (
            <EmptyState
              className="min-h-[60vh]"
              icon={PackageOpen}
              title="No bundles yet."
              description="Create a reusable setup for a role, team, or workflow."
              action={
                <PermissionButton permissions={{ bundle: ["create"] }} asChild>
                  <Link href="/bundles/new">
                    <Plus className="size-4" />
                    <span>Create your first bundle</span>
                  </Link>
                </PermissionButton>
              }
            />
          ) : (
            <>
              <div className="mb-3">
                <FilterBar
                  leading
                  onClearFilters={hasActiveFilters ? clearFilters : undefined}
                  actions={<TableCardViewToggle />}
                >
                  <SearchInput
                    paramName="search"
                    className={filterSearchClass}
                  />
                  <Select
                    value={gatewayFilter}
                    onValueChange={(value) => setFilter("gateway", value)}
                  >
                    <SelectTrigger
                      className={filterControlClass({
                        active: gatewayFilter !== "all",
                      })}
                      aria-label="Filter by MCP gateway"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All gateways</SelectItem>
                      <SelectItem value="current">
                        Keep current gateway
                      </SelectItem>
                      {gateways.map((gateway) => (
                        <SelectItem key={gateway.id} value={gateway.id}>
                          {gateway.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FilterBar>
              </div>
              <TableCardViewContent
                cards={
                  <TableCardList
                    itemCount={filtered.length}
                    isLoading={isFetching}
                    emptyIcon={PackageOpen}
                    emptyMessage="No bundles yet."
                    hasActiveFilters={hasActiveFilters}
                    filteredEmptyMessage="No bundles match the current filters."
                    onClearFilters={clearFilters}
                  >
                    {filtered.map((bundle) => (
                      <TableCard
                        key={bundle.id}
                        icon={<PackageOpen className="size-4" />}
                        title={
                          <Link href={bundleDetailHref(bundle.id)}>
                            {bundle.name}
                          </Link>
                        }
                        description={bundle.description}
                        actions={actionsFor(bundle)}
                        onNavigate={() =>
                          router.push(bundleDetailHref(bundle.id))
                        }
                        footer={
                          <span>
                            Updated{" "}
                            {formatRelativeTimeFromNow(bundle.updatedAt)}
                          </span>
                        }
                      >
                        <div className="flex flex-wrap gap-2">
                          <Badge variant="outline">
                            {gatewayName(bundle.mcpGatewayId)}
                          </Badge>
                          <span className="text-sm text-muted-foreground">
                            {formatBundleCapabilitySummary({
                              skillCount: bundle.skillIds.length,
                              pluginCount: bundle.pluginIds.length,
                              localMcpCount: bundle.localMcpServers.length,
                            })}
                          </span>
                        </div>
                      </TableCard>
                    ))}
                  </TableCardList>
                }
                table={
                  <DataTable
                    columns={columns}
                    data={filtered}
                    getRowId={(row) => row.id}
                    emptyIcon={PackageOpen}
                    emptyMessage="No bundles yet."
                    hasActiveFilters={hasActiveFilters}
                    filteredEmptyMessage="No bundles match the current filters."
                    onClearFilters={clearFilters}
                    sorting={sorting}
                    onSortingChange={setSorting}
                    onRowClick={(row) => router.push(bundleDetailHref(row.id))}
                    isLoading={isFetching}
                    hideSelectedCount
                    fixedWidthColumnIds={[
                      "gateway",
                      "contents",
                      "updatedAt",
                      "actions",
                    ]}
                    flexibleColumnIds={["name"]}
                  />
                }
              />
            </>
          )}
        </TableCardView>
      </PageLayout>
      <DeleteConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete bundle?"
        description={
          deleting
            ? `Delete “${deleting.name}”? Existing marketplace installations will no longer receive updates from this Bundle.`
            : "Delete this bundle?"
        }
        isPending={deleteBundle.isPending}
        onConfirm={() => {
          if (!deleting) return;
          deleteBundle.mutate(deleting.id, {
            onSuccess: (ok) => ok && setDeleting(null),
          });
        }}
      />
    </>
  );
}
