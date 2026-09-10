"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { useCallback, useState } from "react";
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
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { agentActivationSkillReferenceKey } from "@/lib/agent-skill-reference";
import {
  type AgentActivationSkill,
  useAgentActivationSkills,
} from "@/lib/agent-skills.query";

const columns: ColumnDef<AgentActivationSkill>[] = [
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
              source={skill.reference.source}
              providerName={skill.providerName}
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

export function AgentActivationSkillsTable({
  agentId,
  environmentId,
}: {
  agentId?: string;
  environmentId?: string | null;
}) {
  const [search, setSearch] = useState("");
  const [pagination, setPagination] = useState({
    pageIndex: 0,
    pageSize: DEFAULT_TABLE_LIMIT,
  });
  const normalizedSearch = search.trim();
  const { data, isPending, isFetching, isError } = useAgentActivationSkills({
    agentId,
    environmentId,
    limit: pagination.pageSize,
    offset: pagination.pageIndex * pagination.pageSize,
    search: normalizedSearch || undefined,
  });

  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    setPagination((current) =>
      current.pageIndex === 0 ? current : { ...current, pageIndex: 0 },
    );
  }, []);

  if (isPending) return <MessageTable>Loading skills…</MessageTable>;
  if (isError) {
    return (
      <MessageTable tone="error">
        Could not load skills. Try reopening this page.
      </MessageTable>
    );
  }
  if (!data?.enabled) {
    return <MessageTable>Skills are not enabled for this agent.</MessageTable>;
  }

  return (
    <div className="space-y-3">
      <SearchInput
        objectNamePlural="skills"
        searchFields={["name", "description", "provider"]}
        value={search}
        onSearchChange={handleSearchChange}
        syncQueryParams={false}
        isLoading={isFetching}
      />
      <DataTable
        columns={columns}
        data={data.data}
        getRowId={(skill) => agentActivationSkillReferenceKey(skill.reference)}
        pagination={{
          ...pagination,
          total: data.pagination.total,
        }}
        onPaginationChange={setPagination}
        manualPagination
        isLoading={isFetching}
        emptyMessage="No skills are available to you in this environment."
        hasActiveFilters={normalizedSearch.length > 0}
        filteredEmptyMessage="No skills match your search."
        onClearFilters={() => handleSearchChange("")}
        fixedWidthColumnIds={["scope"]}
        flexibleColumnIds={["name"]}
      />
    </div>
  );
}

function MessageTable({
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
