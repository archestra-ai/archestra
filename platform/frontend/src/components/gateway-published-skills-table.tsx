"use client";

import { useCallback, useState } from "react";
import type { EditableSkill } from "@/components/agent-skills-editor";
import { AvailableSkillsTable } from "@/components/available-skills-table";
import { DEFAULT_TABLE_LIMIT } from "@/consts";

/** The effective All-mode set from the gateway's exclusion picker. */
export function GatewayPublishedSkillsTable({
  skills,
  excludedIds,
}: {
  skills: EditableSkill[];
  excludedIds: string[];
}) {
  const [search, setSearch] = useState("");
  const [pagination, setPagination] = useState({
    pageIndex: 0,
    pageSize: DEFAULT_TABLE_LIMIT,
  });
  const normalizedSearch = search.trim();
  const excluded = new Set(excludedIds);
  const matchingSkills = skills.filter((skill) => {
    if (excluded.has(skill.id)) return false;
    if (!normalizedSearch) return true;
    const searchable = `${skill.name} ${skill.description ?? ""}`.toLowerCase();
    return searchable.includes(normalizedSearch.toLowerCase());
  });
  const offset = pagination.pageIndex * pagination.pageSize;
  const page = matchingSkills.slice(offset, offset + pagination.pageSize);

  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    setPagination((current) =>
      current.pageIndex === 0 ? current : { ...current, pageIndex: 0 },
    );
  }, []);

  return (
    <AvailableSkillsTable
      rows={page.map(toAvailableSkillRow)}
      total={matchingSkills.length}
      pagination={pagination}
      onPaginationChange={setPagination}
      search={search}
      onSearchChange={handleSearchChange}
      isFetching={false}
      emptyMessage="No skills are published by All mode."
    />
  );
}

function toAvailableSkillRow(skill: EditableSkill) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description ?? "",
    scope: "org" as const,
    source: "native" as const,
    providerName: null,
  };
}
