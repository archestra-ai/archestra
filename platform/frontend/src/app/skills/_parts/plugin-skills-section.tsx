"use client";

import type { archestraApiTypes } from "@archestra/shared";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { Eye, Puzzle, Settings } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AgentBadge } from "@/components/agent-badge";
import {
  TableCard,
  TableCardList,
  TableCardViewContent,
} from "@/components/table-card-view";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";

export type PluginSkill =
  archestraApiTypes.GetPluginSkillsResponses["200"][number];

export function filterPluginSkills({
  skills,
  search,
  scope,
}: {
  skills: PluginSkill[];
  search?: string;
  scope?: "personal" | "team" | "org";
}) {
  const needle = search?.trim().toLowerCase();
  return skills.filter(
    (skill) =>
      (!scope || skill.scope === scope) &&
      (!needle ||
        skill.name.toLowerCase().includes(needle) ||
        skill.description.toLowerCase().includes(needle) ||
        skill.pluginName.toLowerCase().includes(needle)),
  );
}

export function PluginSkillsSection({
  skills,
  showWhenEmpty = false,
  isLoading = false,
}: {
  skills: PluginSkill[];
  showWhenEmpty?: boolean;
  isLoading?: boolean;
}) {
  const router = useRouter();
  const [sorting, setSorting] = useState<SortingState>([]);

  const renderActions = (skill: PluginSkill) => {
    const actions: TableRowAction[] = [
      {
        icon: <Eye className="h-4 w-4" />,
        label: "View",
        href: pluginSkillHref(skill),
      },
      {
        icon: <Settings className="h-4 w-4" />,
        label: "Manage plugin",
        href: `/plugins/${skill.pluginId}`,
        permissions: { plugin: ["admin"] },
      },
    ];
    return <TableRowActions actions={actions} itemName={skill.name} />;
  };

  const columns: ColumnDef<PluginSkill>[] = [
    {
      id: "pluginName",
      accessorKey: "pluginName",
      header: "Plugin",
      size: 220,
      cell: ({ row }) => (
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/30">
            <Puzzle className="size-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <div className="truncate font-medium">
              {row.original.pluginName}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {row.original.clientType} ·{" "}
              {row.original.supportedPlatforms.join("/")}
            </div>
          </div>
        </div>
      ),
    },
    {
      id: "name",
      accessorKey: "name",
      header: "Skill",
      size: 460,
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{row.original.name}</div>
          <div className="truncate text-xs text-muted-foreground">
            {row.original.description}
          </div>
        </div>
      ),
    },
    {
      id: "visibility",
      size: 130,
      header: "Visibility",
      cell: ({ row }) => <AgentBadge type={row.original.scope} />,
    },
    {
      id: "files",
      size: 100,
      header: () => <div className="text-right">Resources</div>,
      cell: ({ row }) => (
        <div className="text-right text-sm text-muted-foreground">
          {row.original.fileCount}
        </div>
      ),
    },
    {
      id: "actions",
      size: 100,
      header: () => <div className="text-right">Actions</div>,
      cell: ({ row }) => (
        <div className="flex justify-end">{renderActions(row.original)}</div>
      ),
    },
  ];

  if (skills.length === 0 && !showWhenEmpty && !isLoading) return null;

  return (
    <section className="space-y-3" aria-labelledby="plugin-skills-title">
      <div className="flex items-center gap-2">
        <h2
          id="plugin-skills-title"
          className="text-sm font-medium uppercase tracking-wide text-muted-foreground"
        >
          Skills from plugins
        </h2>
        <Badge variant="secondary" className="px-1.5 py-0">
          Beta
        </Badge>
      </div>
      <TableCardViewContent
        cards={
          <TableCardList
            itemCount={skills.length}
            isLoading={isLoading}
            emptyMessage="No plugin skills match the current filters."
          >
            {skills.map((skill) => (
              <TableCard
                key={`${skill.pluginId}:${skill.skillPath}`}
                icon={<Puzzle className="size-4 text-muted-foreground" />}
                title={<Link href={pluginSkillHref(skill)}>{skill.name}</Link>}
                description={skill.description}
                actions={renderActions(skill)}
                footer={
                  <span>
                    {skill.fileCount}{" "}
                    {skill.fileCount === 1 ? "resource" : "resources"}
                  </span>
                }
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{skill.pluginName}</Badge>
                  <AgentBadge type={skill.scope} />
                  {!skill.pluginEnabled && (
                    <Badge variant="outline">Plugin disabled</Badge>
                  )}
                </div>
              </TableCard>
            ))}
          </TableCardList>
        }
        table={
          <DataTable
            columns={columns}
            data={skills}
            isLoading={isLoading}
            getRowId={(row) => `${row.pluginId}:${row.skillPath}`}
            emptyMessage="No plugin skills match the current filters."
            hideSelectedCount
            sorting={sorting}
            onSortingChange={setSorting}
            onRowClick={(row) => router.push(pluginSkillHref(row))}
            tableClassName="[&_td]:py-1.5"
            fixedWidthColumnIds={[
              "pluginName",
              "visibility",
              "files",
              "actions",
            ]}
            flexibleColumnIds={["name"]}
          />
        }
      />
    </section>
  );
}

function pluginSkillHref(skill: PluginSkill) {
  const query = skill.skillPath
    ? `?skillPath=${encodeURIComponent(skill.skillPath)}`
    : "";
  return `/skills/plugins/${skill.pluginId}${query}`;
}
