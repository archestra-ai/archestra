"use client";

import { DocsPage, E2eTestId, getDocsUrl } from "@shared";
import type { ColumnDef } from "@tanstack/react-table";
import {
  BookOpen,
  Check,
  MoreHorizontal,
  PackageMinus,
  PackageOpen,
  SquareArrowOutUpRight,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { SearchInput } from "@/components/search-input";
import { TableFilters } from "@/components/table-filters";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import {
  useArchiveMemory,
  useDeleteMemory,
  useMemoryExtractionAvailable,
  useMemoryInjectionEnabled,
  useMemoryPaginated,
  useUnarchiveMemory,
} from "@/lib/memory.query";
import {
  useActiveMemberRole,
  useActiveOrganization,
} from "@/lib/organization.query";
import { useTeams } from "@/lib/teams/team.query";
import { useSetSettingsAction } from "../../layout";
import { MemoryApproveDialog } from "./memory-approve-dialog";
import { MemoryCreateDialog } from "./memory-create-dialog";
import { MemoryDetailDrawer } from "./memory-detail-drawer";
import { MemoryRejectDialog } from "./memory-reject-dialog";
import {
  canApproveMemoryByScope,
  getDefaultMemoryStatusTab,
  getMemoryKindLabel,
  getMemoryPolicyFlagLabel,
  getMemoryScopeLabel,
  getMemoryStatusLabel,
  MEMORY_STATUS_TABS,
  type MemoryListItem,
  type MemoryScopeType,
  type MemoryStatusTab,
} from "./memory-utils";

export function MemoryList() {
  const appName = useAppName();
  const setSettingsAction = useSetSettingsAction();
  const { data: session } = useSession();
  const { data: activeOrganization } = useActiveOrganization();
  const { data: activeMemberRole } = useActiveMemberRole(
    activeOrganization?.id,
  );
  const { data: teams = [] } = useTeams();
  const { data: canApprovePermission = false } = useHasPermissions({
    memory: ["approve"],
  });
  const { data: canUpdatePermission = false } = useHasPermissions({
    memory: ["update"],
  });
  const { data: canDeletePermission = false } = useHasPermissions({
    memory: ["delete"],
  });
  const memoryInjectionEnabled = useMemoryInjectionEnabled();
  const memoryExtractionAvailable = useMemoryExtractionAvailable();
  const archiveMemory = useArchiveMemory();
  const unarchiveMemory = useUnarchiveMemory();
  const deleteMemory = useDeleteMemory();

  const {
    searchParams,
    pageIndex,
    pageSize,
    offset,
    setPagination,
    updateQueryParams,
  } = useDataTableQueryParams();

  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [approveTarget, setApproveTarget] = useState<MemoryListItem | null>(
    null,
  );
  const [rejectTarget, setRejectTarget] = useState<MemoryListItem | null>(null);
  const [detailMemoryId, setDetailMemoryId] = useState<string | null>(null);

  const selectedStatus = getSelectedStatusTab({
    statusParam: searchParams.get("status"),
    defaultStatus: getDefaultMemoryStatusTab(canApprovePermission),
  });
  const selectedScopeFilter = getSelectedScopeFilter(
    searchParams.get("scopeType"),
  );
  const searchTerm = searchParams.get("search")?.trim() || undefined;

  const {
    data: memoryResponse,
    isPending,
    isFetching,
  } = useMemoryPaginated({
    limit: pageSize,
    offset,
    status: selectedStatus,
    scopeType: selectedScopeFilter,
    search: searchTerm,
  });

  const memoryItems = memoryResponse?.data ?? [];
  const totalItems = memoryResponse?.pagination.total ?? 0;

  const currentUserId = session?.user?.id;
  const reviewerRole = activeMemberRole ?? "member";
  const currentTeamIds = useMemo(() => teams.map((team) => team.id), [teams]);
  const hasActiveFilters = Boolean(searchTerm || selectedScopeFilter);
  const docsUrl = getDocsUrl(DocsPage.PlatformMemory, "review-queue");

  useEffect(() => {
    setSettingsAction(
      <PermissionButton
        permissions={{ memory: ["create"] }}
        onClick={() => setIsCreateDialogOpen(true)}
        data-testid={E2eTestId.MemoryCreateButton}
      >
        Propose memory
      </PermissionButton>,
    );

    return () => setSettingsAction(null);
  }, [setSettingsAction]);

  const columns = useMemo<ColumnDef<MemoryListItem>[]>(
    () => [
      {
        accessorKey: "scopeType",
        header: "Scope",
        cell: ({ row }) => (
          <div className="space-y-1">
            <Badge variant="outline">
              {getMemoryScopeLabel(row.original.scopeType)}
            </Badge>
            <div className="font-mono text-[11px] text-muted-foreground">
              {row.original.scopeId}
            </div>
          </div>
        ),
      },
      {
        accessorKey: "kind",
        header: "Kind",
        cell: ({ row }) => (
          <Badge variant="secondary">
            {getMemoryKindLabel(row.original.kind)}
          </Badge>
        ),
      },
      {
        accessorKey: "content",
        header: "Content",
        cell: ({ row }) => (
          <div className="space-y-1">
            <p className="max-w-[420px] truncate text-sm">
              {row.original.content}
            </p>
            <div className="flex flex-wrap gap-1">
              {row.original.policyFlags.map((flag) => (
                <Badge
                  key={flag}
                  variant={flag === "source_deleted" ? "outline" : "secondary"}
                  className={
                    flag === "instruction_like"
                      ? "border-yellow-300 bg-yellow-100 text-yellow-900"
                      : flag === "source_deleted"
                        ? "border-orange-300 bg-orange-100 text-orange-900"
                        : undefined
                  }
                >
                  {getMemoryPolicyFlagLabel(flag)}
                </Badge>
              ))}
              {row.original.policyFlags.includes("source_deleted") ? (
                <Badge
                  variant="outline"
                  className="border-orange-300 bg-orange-50 text-orange-900"
                >
                  Excluded from injection
                </Badge>
              ) : null}
            </div>
          </div>
        ),
      },
      {
        accessorKey: "sourceConversationId",
        header: "Source",
        cell: ({ row }) =>
          row.original.sourceConversationId ? (
            <Link
              href={`/chat/${row.original.sourceConversationId}`}
              className="inline-flex items-center gap-1 text-sm text-primary underline underline-offset-4"
            >
              Conversation
              <SquareArrowOutUpRight className="h-3 w-3" />
            </Link>
          ) : (
            <span className="text-sm text-muted-foreground">Manual / none</span>
          ),
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => (
          <Badge
            variant={
              row.original.status === "rejected" ? "destructive" : "outline"
            }
            className={
              row.original.status === "approved"
                ? "border-emerald-300 bg-emerald-100 text-emerald-900"
                : row.original.status === "candidate"
                  ? "border-blue-300 bg-blue-100 text-blue-900"
                  : row.original.status === "archived"
                    ? "border-gray-300 bg-gray-100 text-gray-800"
                    : undefined
            }
          >
            {getMemoryStatusLabel(row.original.status)}
          </Badge>
        ),
      },
      {
        accessorKey: "reviewedBy",
        header: "Reviewer",
        cell: ({ row }) => (
          <span className="font-mono text-xs text-muted-foreground">
            {row.original.reviewedBy ?? "Not reviewed"}
          </span>
        ),
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => {
          const item = row.original;
          const canApproveByScope = canApproveMemoryByScope({
            item,
            currentUserId,
            currentRole: reviewerRole,
            organizationId: activeOrganization?.id,
            teamIds: currentTeamIds,
          });

          const approveDisabled = !canApprovePermission || !canApproveByScope;
          const lifecycleDisabled = !canUpdatePermission || !canApproveByScope;
          const deleteDisabled = !canDeletePermission || !canApproveByScope;

          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Open memory actions"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setDetailMemoryId(item.id)}>
                  View details
                </DropdownMenuItem>

                {item.status === "candidate" ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() => setApproveTarget(item)}
                      disabled={approveDisabled}
                      data-testid={E2eTestId.MemoryApproveButton}
                    >
                      <Check className="h-4 w-4" />
                      Approve
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => setRejectTarget(item)}
                      disabled={approveDisabled}
                      data-testid={E2eTestId.MemoryRejectButton}
                    >
                      <X className="h-4 w-4" />
                      Reject
                    </DropdownMenuItem>
                  </>
                ) : null}

                {item.status === "approved" ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() => void archiveMemory.mutateAsync(item.id)}
                      disabled={lifecycleDisabled || archiveMemory.isPending}
                    >
                      <PackageMinus className="h-4 w-4" />
                      Archive
                    </DropdownMenuItem>
                  </>
                ) : null}

                {item.status === "archived" ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() => void unarchiveMemory.mutateAsync(item.id)}
                      disabled={lifecycleDisabled || unarchiveMemory.isPending}
                    >
                      <PackageOpen className="h-4 w-4" />
                      Restore
                    </DropdownMenuItem>
                  </>
                ) : null}

                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => void deleteMemory.mutateAsync(item.id)}
                  disabled={deleteDisabled || deleteMemory.isPending}
                  className="text-destructive focus:text-destructive"
                >
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [
      activeOrganization?.id,
      archiveMemory,
      canApprovePermission,
      canDeletePermission,
      canUpdatePermission,
      currentTeamIds,
      currentUserId,
      deleteMemory,
      reviewerRole,
      unarchiveMemory,
    ],
  );

  return (
    <div className="space-y-4">
      <Alert>
        <AlertTitle>Injection policy state</AlertTitle>
        <AlertDescription>
          Automatic prompt injection is{" "}
          <span className="font-medium">
            {memoryInjectionEnabled ? "enabled" : "disabled"}
          </span>
          . Team and organization scopes are review-only.
        </AlertDescription>
      </Alert>

      {memoryExtractionAvailable === false ? (
        <Alert variant="destructive">
          <AlertTitle>Automatic extraction unavailable</AlertTitle>
          <AlertDescription>
            {appName} cannot extract new memory candidates automatically right
            now. Manual proposals remain available.
          </AlertDescription>
        </Alert>
      ) : null}

      <TableFilters className="gap-y-2">
        <Tabs
          value={selectedStatus}
          onValueChange={(value) =>
            updateQueryParams({
              status: value,
              page: "1",
            })
          }
        >
          <TabsList data-testid={E2eTestId.MemoryStatusTabs}>
            {MEMORY_STATUS_TABS.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value}>
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <Select
          value={selectedScopeFilter ?? "all"}
          onValueChange={(value) =>
            updateQueryParams({
              scopeType: value === "all" ? null : value,
              page: "1",
            })
          }
        >
          <SelectTrigger
            className="w-[180px]"
            data-testid={E2eTestId.MemoryScopeFilter}
          >
            <SelectValue placeholder="Scope" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All accessible scopes</SelectItem>
            <SelectItem value="user">User scope</SelectItem>
            <SelectItem value="team">Team scope</SelectItem>
            <SelectItem value="organization">Organization scope</SelectItem>
          </SelectContent>
        </Select>

        <SearchInput
          objectNamePlural="memory items"
          searchFields={["content"]}
          paramName="search"
        />

        <div className="ml-auto flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button asChild variant="ghost" size="icon-sm">
                <Link
                  href={docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Open memory docs"
                >
                  <BookOpen className="h-4 w-4" />
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open memory review docs</TooltipContent>
          </Tooltip>
        </div>
      </TableFilters>

      <div data-testid={E2eTestId.MemoryTable}>
        <DataTable
          columns={columns}
          data={memoryItems}
          manualPagination
          pagination={{
            pageIndex,
            pageSize,
            total: totalItems,
          }}
          onPaginationChange={setPagination}
          isLoading={isPending || isFetching}
          hasActiveFilters={hasActiveFilters}
          filteredEmptyMessage="No memory items match your filters."
          onClearFilters={() =>
            updateQueryParams({
              scopeType: null,
              search: null,
              page: "1",
            })
          }
          emptyMessage="No memory items found."
        />
      </div>

      {!isPending &&
      !isFetching &&
      memoryItems.length === 0 &&
      !hasActiveFilters ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BookOpen className="h-5 w-5" />
            </EmptyMedia>
            <EmptyTitle>No memory items yet</EmptyTitle>
            <EmptyDescription>
              Start by proposing a memory candidate or review extraction output.{" "}
              <ExternalDocsLink href={docsUrl} showIcon={false}>
                Review queue docs
              </ExternalDocsLink>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      <MemoryCreateDialog
        open={isCreateDialogOpen}
        onOpenChange={setIsCreateDialogOpen}
        currentUserId={currentUserId}
        organizationId={activeOrganization?.id}
        teams={teams.map((team) => ({ id: team.id, name: team.name }))}
      />

      <MemoryApproveDialog
        item={approveTarget}
        open={!!approveTarget}
        onOpenChange={(open) => {
          if (!open) {
            setApproveTarget(null);
          }
        }}
        disabled={
          !approveTarget
            ? true
            : !canApproveMemoryByScope({
                item: approveTarget,
                currentUserId,
                currentRole: reviewerRole,
                organizationId: activeOrganization?.id,
                teamIds: currentTeamIds,
              })
        }
      />

      <MemoryRejectDialog
        item={rejectTarget}
        open={!!rejectTarget}
        onOpenChange={(open) => {
          if (!open) {
            setRejectTarget(null);
          }
        }}
      />

      <MemoryDetailDrawer
        memoryId={detailMemoryId}
        open={!!detailMemoryId}
        onOpenChange={(open) => {
          if (!open) {
            setDetailMemoryId(null);
          }
        }}
      />
    </div>
  );
}

function getSelectedStatusTab(params: {
  statusParam: string | null;
  defaultStatus: MemoryStatusTab;
}): MemoryStatusTab {
  if (!params.statusParam) {
    return params.defaultStatus;
  }

  const matchedStatus = MEMORY_STATUS_TABS.find(
    (tab) => tab.value === params.statusParam,
  );
  return matchedStatus?.value ?? params.defaultStatus;
}

function getSelectedScopeFilter(
  scopeTypeParam: string | null,
): MemoryScopeType | undefined {
  if (
    scopeTypeParam === "user" ||
    scopeTypeParam === "team" ||
    scopeTypeParam === "organization"
  ) {
    return scopeTypeParam;
  }

  return undefined;
}
