"use client";

import { useCallback, useState } from "react";
import {
  AvailableSkillsMessageTable,
  AvailableSkillsTable,
} from "@/components/available-skills-table";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { agentActivationSkillReferenceKey } from "@/lib/agent-skill-reference";
import {
  type AgentActivationSkill,
  useAgentActivationSkills,
} from "@/lib/agent-skills.query";

export function AgentActivationSkillsTable({
  agentId,
  environmentId,
  view,
  excludedIds = [],
}: {
  agentId?: string;
  environmentId?: string | null;
  view?: "effective" | "eligible";
  excludedIds?: string[];
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
    ...(view ? { view } : {}),
  });

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
  if (isError) {
    return (
      <AvailableSkillsMessageTable tone="error">
        Could not load skills. Try reopening this page.
      </AvailableSkillsMessageTable>
    );
  }
  if (!data?.enabled) {
    return (
      <AvailableSkillsMessageTable>
        Skills are not enabled for this agent.
      </AvailableSkillsMessageTable>
    );
  }

  const excluded = new Set(excludedIds);

  return (
    <AvailableSkillsTable
      rows={data.data
        .filter(
          (skill) =>
            !excluded.has(agentActivationSkillReferenceKey(skill.reference)),
        )
        .map((skill: AgentActivationSkill) => ({
          id: agentActivationSkillReferenceKey(skill.reference),
          name: skill.name,
          description: skill.description,
          scope: skill.scope,
          source: skill.reference.source,
          providerName: skill.providerName,
        }))}
      total={Math.max(0, data.pagination.total - excludedIds.length)}
      pagination={pagination}
      onPaginationChange={setPagination}
      search={search}
      onSearchChange={handleSearchChange}
      isFetching={isFetching}
      emptyMessage="No skills are available to you in this environment."
    />
  );
}
