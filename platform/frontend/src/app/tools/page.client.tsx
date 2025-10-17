"use client";

import { useQueryClient } from "@tanstack/react-query";
import type {
  ColumnDef,
  RowSelectionState,
  SortingState,
} from "@tanstack/react-table";
import { ChevronDown, ChevronUp, Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { LoadingSpinner } from "@/components/loading";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DataTable } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { GetToolsResponses } from "@/lib/clients/api";
import {
  prefetchOperators,
  prefetchToolInvocationPolicies,
  prefetchToolResultPolicies,
  useToolInvocationPolicies,
  useToolResultPolicies,
} from "@/lib/policy.query";
import { useToolPatchMutation, useTools } from "@/lib/tool.query";
import { formatDate } from "@/lib/utils";
import { ErrorBoundary } from "../_parts/error-boundary";
import { ToolDetailsDialog } from "./_parts/tool-details-dialog";

export function ToolsPage({
  initialData,
}: {
  initialData?: GetToolsResponses["200"];
}) {
  const queryClient = useQueryClient();

  // Prefetch policy data on mount
  useEffect(() => {
    prefetchOperators(queryClient);
    prefetchToolInvocationPolicies(queryClient);
    prefetchToolResultPolicies(queryClient);
  }, [queryClient]);

  return (
    <div className="container mx-auto overflow-y-auto">
      <ErrorBoundary>
        <Suspense fallback={<LoadingSpinner />}>
          <ToolsList key="tools-list-component" initialData={initialData} />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

type ToolData = GetToolsResponses["200"][number];

// Reusable sort icon component
function SortIcon({ isSorted }: { isSorted: false | "asc" | "desc" }) {
  if (isSorted === "asc") return <ChevronUp className="h-3 w-3" />;
  if (isSorted === "desc") return <ChevronDown className="h-3 w-3" />;

  return (
    <div className="text-muted-foreground/50 flex flex-col items-center">
      <ChevronUp className="h-3 w-3" />
      <span className="mt-[-4px]">
        <ChevronDown className="h-3 w-3" />
      </span>
    </div>
  );
}

function ToolsList({
  initialData,
}: {
  initialData?: GetToolsResponses["200"];
}) {
  const { data: tools } = useTools({ initialData });
  const toolPatchMutation = useToolPatchMutation();
  const { data: invocationPolicies } = useToolInvocationPolicies();
  const { data: resultPolicies } = useToolResultPolicies();

  // Dialog state - combined into single state
  const [selectedToolForDialog, setSelectedToolForDialog] =
    useState<ToolData | null>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState("");

  // Table state
  const [sorting, setSorting] = useState<SortingState>([
    { id: "createdAt", desc: true },
  ]);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [selectedTools, setSelectedTools] = useState<ToolData[]>([]);

  // Pagination from URL
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Use URL params for pagination
  const pageFromUrl = searchParams.get("page");
  const pageSizeFromUrl = searchParams.get("pageSize");

  const pageIndex = Number(pageFromUrl || "1") - 1;
  const pageSize = Number(pageSizeFromUrl || "50");

  // Filter tools based on search query
  const filteredTools = useMemo(() => {
    if (!searchQuery.trim()) return tools || [];

    const query = searchQuery.toLowerCase();
    return (tools || []).filter((tool) =>
      tool.name.toLowerCase().includes(query),
    );
  }, [tools, searchQuery]);

  const handlePaginationChange = useCallback(
    (newPagination: { pageIndex: number; pageSize: number }) => {
      // Clear selection when changing pages
      setRowSelection({});
      setSelectedTools([]);

      const params = new URLSearchParams(searchParams.toString());
      params.set("page", String(newPagination.pageIndex + 1));
      params.set("pageSize", String(newPagination.pageSize));
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  // Selection change handler - now works with page-relative indices
  const handleRowSelectionChange = useCallback(
    (newRowSelection: RowSelectionState) => {
      setRowSelection(newRowSelection);

      // Calculate the current page's data from filtered tools
      const startIndex = pageIndex * pageSize;
      const pageTools = (filteredTools || []).slice(
        startIndex,
        startIndex + pageSize,
      );

      // Map page-relative indices to actual tools
      const newSelectedTools = Object.keys(newRowSelection)
        .map((index) => pageTools[Number(index)])
        .filter(Boolean);

      setSelectedTools(newSelectedTools);
    },
    [filteredTools, pageIndex, pageSize],
  );

  // Bulk action handler - unified for both types
  const handleBulkAction = useCallback(
    (
      field: "allowUsageWhenUntrustedDataIsPresent" | "dataIsTrustedByDefault",
      value: boolean,
    ) => {
      let skippedCount = 0;
      let appliedCount = 0;

      // Perform all mutations, skipping tools with custom policies
      selectedTools.forEach((tool) => {
        // Skip tools with custom policies for the relevant field
        if (field === "allowUsageWhenUntrustedDataIsPresent") {
          const hasCustomInvocationPolicy =
            invocationPolicies?.byToolId[tool.id]?.length > 0;
          if (hasCustomInvocationPolicy) {
            skippedCount++;
            return;
          }
        }

        if (field === "dataIsTrustedByDefault") {
          const hasCustomResultPolicy =
            resultPolicies?.byToolId[tool.id]?.length > 0;
          if (hasCustomResultPolicy) {
            skippedCount++;
            return;
          }
        }

        toolPatchMutation.mutate({
          id: tool.id,
          [field]: value,
        });
        appliedCount++;
      });

      // Show toast notification about the results
      if (skippedCount > 0 && appliedCount > 0) {
        toast.info(
          `Applied to ${appliedCount} tool${appliedCount !== 1 ? "s" : ""}. Skipped ${skippedCount} with custom policies.`,
        );
      } else if (skippedCount > 0 && appliedCount === 0) {
        toast.warning(
          `All selected tools have custom policies. No changes made.`,
        );
      } else if (appliedCount > 0) {
        toast.success(
          `Applied to ${appliedCount} tool${appliedCount !== 1 ? "s" : ""}.`,
        );
      }

      // Keep selection active after mutations
      // Users might want to apply multiple actions to the same selection
    },
    [selectedTools, toolPatchMutation, invocationPolicies, resultPolicies],
  );

  const clearSelection = useCallback(() => {
    setRowSelection({});
    setSelectedTools([]);
  }, []);

  // Column definitions - moved before early return to fix hook order
  const columns: ColumnDef<ToolData>[] = useMemo(
    () => [
      {
        id: "select",
        header: ({ table }) => (
          <Checkbox
            checked={
              table.getIsAllPageRowsSelected() ||
              (table.getIsSomePageRowsSelected() && "indeterminate")
            }
            onCheckedChange={(value) =>
              table.toggleAllPageRowsSelected(!!value)
            }
            aria-label="Select all"
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            checked={row.getIsSelected()}
            onCheckedChange={(value) => row.toggleSelected(!!value)}
            aria-label={`Select ${row.original.name}`}
          />
        ),
        size: 50,
      },
      {
        accessorKey: "name",
        header: ({ column }) => (
          <Button
            variant="ghost"
            className="-ml-4 h-auto px-4 py-2 font-medium hover:bg-transparent"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Tool Name
            <SortIcon isSorted={column.getIsSorted()} />
          </Button>
        ),
        cell: ({ row }) => (
          <div className="font-medium text-foreground truncate">
            {row.original.name}
          </div>
        ),
        size: 250,
      },
      {
        id: "agent",
        accessorFn: (row) => row.agent?.name || "",
        header: ({ column }) => (
          <Button
            variant="ghost"
            className="-ml-4 h-auto px-4 py-2 font-medium hover:bg-transparent"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Agent
            <SortIcon isSorted={column.getIsSorted()} />
          </Button>
        ),
        cell: ({ row }) => (
          <div className="text-sm text-muted-foreground truncate">
            {row.original.agent?.name || "-"}
          </div>
        ),
        size: 150,
      },
      {
        id: "allowWithUntrusted",
        header: "In untrusted context",
        cell: ({ row }) => {
          const hasCustomPolicy =
            invocationPolicies?.byToolId[row.original.id]?.length > 0;

          if (hasCustomPolicy) {
            return (
              <span className="text-xs font-medium text-primary">Custom</span>
            );
          }

          return (
            <div className="flex items-center gap-2">
              <Switch
                checked={row.original.allowUsageWhenUntrustedDataIsPresent}
                onCheckedChange={(checked) => {
                  toolPatchMutation.mutate({
                    id: row.original.id,
                    allowUsageWhenUntrustedDataIsPresent: checked,
                  });
                }}
                onClick={(e) => e.stopPropagation()}
                aria-label={`Allow ${row.original.name} in untrusted context`}
              />
              <span className="text-xs text-muted-foreground">
                {row.original.allowUsageWhenUntrustedDataIsPresent
                  ? "Allowed"
                  : "Blocked"}
              </span>
            </div>
          );
        },
        size: 120,
      },
      {
        id: "trustedByDefault",
        header: "Results are",
        cell: ({ row }) => {
          const hasCustomPolicy =
            resultPolicies?.byToolId[row.original.id]?.length > 0;

          if (hasCustomPolicy) {
            return (
              <span className="text-xs font-medium text-primary">Custom</span>
            );
          }

          return (
            <div className="flex items-center gap-2">
              <Switch
                checked={row.original.dataIsTrustedByDefault}
                onCheckedChange={(checked) => {
                  toolPatchMutation.mutate({
                    id: row.original.id,
                    dataIsTrustedByDefault: checked,
                  });
                }}
                onClick={(e) => e.stopPropagation()}
                aria-label={`Mark ${row.original.name} results as ${row.original.dataIsTrustedByDefault ? "untrusted" : "trusted"}`}
              />
              <span className="text-xs text-muted-foreground">
                {row.original.dataIsTrustedByDefault ? "Trusted" : "Untrusted"}
              </span>
            </div>
          );
        },
        size: 120,
      },
      {
        accessorKey: "createdAt",
        header: ({ column }) => (
          <Button
            variant="ghost"
            className="-ml-4 h-auto px-4 py-2 font-medium hover:bg-transparent"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Detected
            <SortIcon isSorted={column.getIsSorted()} />
          </Button>
        ),
        cell: ({ row }) => (
          <div className="font-mono text-xs text-muted-foreground">
            {formatDate({ date: row.original.createdAt })}
          </div>
        ),
        size: 150,
      },
      {
        id: "parameters",
        header: "Parameters",
        cell: ({ row }) => {
          const paramCount = Object.keys(
            row.original.parameters?.properties || {},
          ).length;
          return (
            <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium">
              {paramCount}
            </span>
          );
        },
        size: 100,
      },
    ],
    [invocationPolicies, resultPolicies, toolPatchMutation],
  );

  // Calculate the current page's data from filtered tools - moved before component definition
  const paginatedTools = useMemo(() => {
    const startIndex = pageIndex * pageSize;
    const endIndex = startIndex + pageSize;
    return (filteredTools || []).slice(startIndex, endIndex);
  }, [filteredTools, pageIndex, pageSize]);

  // Early return if no tools
  if (!tools?.length) {
    return (
      <div className="w-full h-full">
        <div className="border-b border-border bg-card/30">
          <div className="max-w-7xl mx-auto px-8 py-8">
            <h1 className="text-2xl font-semibold tracking-tight mb-2">
              Tools
            </h1>
            <p className="text-sm text-muted-foreground">
              Here you can find the tools parsed from the interactions between
              your agents and LLMs. If you don't see the tools you expect,
              please ensure that your agents are properly configured to use
              Archestra as an LLM proxy, and trigger some interactions.
            </p>
          </div>
        </div>
        <div className="max-w-7xl mx-auto px-8 py-8">
          <p className="text-muted-foreground">No tools found</p>
        </div>
      </div>
    );
  }

  // Bulk actions component
  const BulkActions = () => {
    const hasSelection = selectedTools.length > 0;

    return (
      <div className="mb-6 flex items-center justify-between p-4 bg-muted/50 border border-border rounded-lg">
        <div className="flex items-center gap-3">
          {hasSelection ? (
            <>
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
                <span className="text-sm font-semibold text-primary">
                  {selectedTools.length}
                </span>
              </div>
              <span className="text-sm font-medium">
                {selectedTools.length === 1
                  ? "tool selected"
                  : `tools selected`}
              </span>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">
              Select tools to apply bulk actions
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="mr-2 h-4 w-px bg-border" />
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              handleBulkAction("allowUsageWhenUntrustedDataIsPresent", true)
            }
            disabled={!hasSelection}
          >
            Allow in untrusted context
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              handleBulkAction("allowUsageWhenUntrustedDataIsPresent", false)
            }
            disabled={!hasSelection}
          >
            Block in untrusted context
          </Button>
          <div className="mx-1 h-4 w-px bg-border" />
          <Button
            size="sm"
            variant="secondary"
            onClick={() => handleBulkAction("dataIsTrustedByDefault", true)}
            disabled={!hasSelection}
          >
            Mark results as trusted
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => handleBulkAction("dataIsTrustedByDefault", false)}
            disabled={!hasSelection}
          >
            Mark results as untrusted
          </Button>
          <div className="ml-2 h-4 w-px bg-border" />
          <Button
            size="sm"
            variant="ghost"
            onClick={clearSelection}
            disabled={!hasSelection}
          >
            Clear selection
          </Button>
        </div>
      </div>
    );
  };

  return (
    <div className="w-full h-full">
      <div className="border-b border-border bg-card/30">
        <div className="max-w-7xl mx-auto px-8 py-8">
          <h1 className="text-2xl font-semibold tracking-tight mb-2">Tools</h1>
          <p className="text-sm text-muted-foreground">
            Here you can find the tools parsed from the interactions between
            your agents and LLMs. If you don't see the tools you expect, please
            ensure that your agents are properly configured to use Archestra as
            an LLM proxy, and trigger some interactions.
          </p>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-8 py-8">
        <div className="mb-6">
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search tools by name..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                // Reset to first page when searching
                if (pageIndex !== 0) {
                  const params = new URLSearchParams(searchParams.toString());
                  params.set("page", "1");
                  router.push(`${pathname}?${params.toString()}`, {
                    scroll: false,
                  });
                }
                // Clear selection when searching
                setRowSelection({});
                setSelectedTools([]);
              }}
              className="pl-9"
            />
          </div>
        </div>

        <BulkActions />

        {(filteredTools?.length || 0) === 0 && searchQuery ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Search className="mb-4 h-12 w-12 text-muted-foreground/50" />
            <h3 className="mb-2 text-lg font-semibold">No tools found</h3>
            <p className="mb-4 text-sm text-muted-foreground">
              No tools match "{searchQuery}". Try adjusting your search.
            </p>
            <Button
              variant="outline"
              onClick={() => {
                setSearchQuery("");
                setRowSelection({});
                setSelectedTools([]);
              }}
            >
              Clear search
            </Button>
          </div>
        ) : (
          <DataTable
            columns={columns}
            data={paginatedTools}
            onRowClick={(tool, event) => {
              // Don't open dialog if clicking on checkbox cell or switch controls
              const target = event.target as HTMLElement;
              const isCheckboxClick =
                target.closest('[data-column-id="select"]') ||
                target.closest('input[type="checkbox"]') ||
                target.closest('button[role="checkbox"]') ||
                target.closest('button[role="switch"]');
              if (!isCheckboxClick) {
                setSelectedToolForDialog(tool);
              }
            }}
            sorting={sorting}
            onSortingChange={setSorting}
            manualPagination={true}
            pagination={{
              pageIndex,
              pageSize,
              total: filteredTools?.length || 0,
            }}
            onPaginationChange={handlePaginationChange}
            rowSelection={rowSelection}
            onRowSelectionChange={handleRowSelectionChange}
          />
        )}

        <ToolDetailsDialog
          tool={
            selectedToolForDialog
              ? tools.find((t) => t.id === selectedToolForDialog.id) ||
                selectedToolForDialog
              : null
          }
          open={!!selectedToolForDialog}
          onOpenChange={(open) => !open && setSelectedToolForDialog(null)}
        />
      </div>
    </div>
  );
}
