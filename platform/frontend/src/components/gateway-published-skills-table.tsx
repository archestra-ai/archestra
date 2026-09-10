"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { useCallback, useState } from "react";
import {
  AvailableSkillsMessageTable,
  AvailableSkillsTable,
} from "@/components/available-skills-table";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { useSkillsPaginated } from "@/lib/skills/skill.query";

type SkillRow = archestraApiTypes.GetSkillsResponses["200"]["data"][number];

/** Server-filtered skills eligible for All mode on a saved or draft gateway. */
export function GatewayPublishedSkillsTable({
  gatewayId,
  environmentId,
}: {
  gatewayId?: string;
  environmentId?: string | null;
}) {
  const [search, setSearch] = useState("");
  const [pagination, setPagination] = useState({
    pageIndex: 0,
    pageSize: DEFAULT_TABLE_LIMIT,
  });
  const normalizedSearch = search.trim();
  const { data, isPending, isFetching, isError } = useSkillsPaginated(
    {
      forAgentId: gatewayId,
      mcpGatewayEnvironment: environmentId ?? "default",
      limit: pagination.pageSize,
      offset: pagination.pageIndex * pagination.pageSize,
      search: normalizedSearch || undefined,
      sortBy: "name",
      sortDirection: "asc",
      agentSkillView: "eligible",
    },
    { toastOnError: false },
  );

  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    setPagination((current) =>
      current.pageIndex === 0 ? current : { ...current, pageIndex: 0 },
    );
  }, []);

  if (isPending) {
    return (
      <AvailableSkillsMessageTable>Loading skills…</AvailableSkillsMessageTable>
    );
  }
  if (isError || !data) {
    return (
      <AvailableSkillsMessageTable tone="error">
        Could not load skills. Close and reopen this view to try again.
      </AvailableSkillsMessageTable>
    );
  }

  return (
    <AvailableSkillsTable
      rows={data.data.map(toAvailableSkillRow)}
      total={data.pagination?.total ?? data.data.length}
      pagination={pagination}
      onPaginationChange={setPagination}
      search={search}
      onSearchChange={handleSearchChange}
      isFetching={isFetching}
      emptyMessage="No skills are eligible for All mode in this gateway's environment."
    />
  );
}

function toAvailableSkillRow(skill: SkillRow) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    scope: skill.scope,
    source: "native" as const,
    providerName: null,
  };
}
