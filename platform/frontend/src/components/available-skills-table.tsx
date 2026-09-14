"use client";

import type { ColumnDef, PaginationState } from "@tanstack/react-table";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { SearchInput } from "@/components/search-input";
import { SkillSourceBadge } from "@/components/skill-source-badge";
import { DataTable } from "@/components/ui/data-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface AvailableSkillRow {
  id: string;
  name: string;
  description: string;
  scope: "org" | "team" | "personal";
  source: "native" | "external_mcp" | "plugin";
  providerName?: string | null;
}

const columns: ColumnDef<AvailableSkillRow>[] = [
  {
    accessorKey: "name",
    header: "Skill",
    size: 420,
    cell: ({ row }) => {
      const skill = row.original;
      return (
        <div className="min-w-0">
          <div className="flex min-w-0 items-baseline gap-2">
            <p className="truncate font-medium" title={skill.name}>
              {skill.name}
            </p>
            <SkillSourceBadge
              source={skill.source}
              providerName={skill.providerName ?? null}
            />
          </div>
          <p
            className="line-clamp-2 text-xs text-muted-foreground"
            title={skill.description}
          >
            {skill.description}
          </p>
        </div>
      );
    },
  },
  {
    accessorKey: "scope",
    header: "Visibility",
    size: 180,
    cell: ({ row }) => (
      <ResourceVisibilityBadge scope={row.original.scope} scopeOnly />
    ),
  },
];

/** Read-only projection of the Skills page table for policy discovery. */
export function AvailableSkillsTable({
  rows,
  total,
  pagination,
  onPaginationChange,
  search,
  onSearchChange,
  isFetching,
  emptyMessage,
}: {
  rows: AvailableSkillRow[];
  total: number;
  pagination: PaginationState;
  onPaginationChange: (pagination: PaginationState) => void;
  search: string;
  onSearchChange: (search: string) => void;
  isFetching: boolean;
  emptyMessage: string;
}) {
  const normalizedSearch = search.trim();
  return (
    <div className="space-y-3">
      <SearchInput
        objectNamePlural="skills"
        searchFields={["name", "description", "provider"]}
        value={search}
        onSearchChange={onSearchChange}
        syncQueryParams={false}
        isLoading={isFetching}
      />
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(skill) => skill.id}
        pagination={{ ...pagination, total }}
        onPaginationChange={onPaginationChange}
        manualPagination
        isLoading={isFetching}
        emptyMessage={emptyMessage}
        hasActiveFilters={normalizedSearch.length > 0}
        filteredEmptyMessage="No skills match your search."
        onClearFilters={() => onSearchChange("")}
        fixedWidthColumnIds={["scope"]}
        flexibleColumnIds={["name"]}
      />
    </div>
  );
}

export function AvailableSkillsMessageTable({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "error";
}) {
  return (
    <div className="overflow-hidden rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[70%]">Skill</TableHead>
            <TableHead className="w-[30%]">Visibility</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell
              colSpan={2}
              className={
                tone === "error" ? "text-destructive" : "text-muted-foreground"
              }
            >
              {children}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}
