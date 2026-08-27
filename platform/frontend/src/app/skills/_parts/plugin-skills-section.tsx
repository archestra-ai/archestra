"use client";

import type { archestraApiTypes } from "@archestra/shared";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { ChartColumn, Info, Puzzle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { TableCard } from "@/components/table-card-view";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSession } from "@/lib/auth/auth.query";
import { PluginSourceIcon } from "../../plugins/_parts/plugin-source-icon";
import { SkillCollection, SkillSortableHeader } from "./skill-collection";
import { SkillUsageDialog } from "./skill-usage-dialog";
import { SkillUsageSummary } from "./skill-usage-summary";

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
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const [sorting, setSorting] = useState<SortingState>([]);
  const [usageSkill, setUsageSkill] = useState<PluginSkill | null>(null);

  const renderActions = (skill: PluginSkill) => {
    const actions: TableRowAction[] = [
      {
        icon: <ChartColumn className="h-4 w-4" />,
        label: "Usage",
        onClick: () => setUsageSkill(skill),
      },
      {
        icon: <Puzzle className="h-4 w-4" />,
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
      header: ({ column }) => (
        <SkillSortableHeader
          label="Plugin"
          isSorted={column.getIsSorted()}
          onToggle={() => column.toggleSorting(column.getIsSorted() === "asc")}
        />
      ),
      size: 180,
      minSize: 180,
      maxSize: 240,
      cell: ({ row }) => (
        <div className="flex min-w-0 items-center gap-2.5">
          <PluginSourceIcon plugin={row.original} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium">
                {row.original.pluginName}
              </span>
              {!row.original.pluginEnabled && (
                <Badge variant="outline" className="shrink-0">
                  Disabled
                </Badge>
              )}
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
      header: ({ column }) => (
        <SkillSortableHeader
          label="Skill"
          isSorted={column.getIsSorted()}
          onToggle={() => column.toggleSorting(column.getIsSorted() === "asc")}
        />
      ),
      size: 450,
      minSize: 320,
      maxSize: 600,
      cell: ({ row }) => (
        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{row.original.name}</div>
            <div className="truncate text-xs text-muted-foreground">
              {row.original.description || "No description"}
            </div>
          </div>
          {row.original.compatibility && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline" className="shrink-0 gap-1">
                  <Info className="h-3 w-3" />
                  compatibility
                </Badge>
              </TooltipTrigger>
              <TooltipContent>{row.original.compatibility}</TooltipContent>
            </Tooltip>
          )}
        </div>
      ),
    },
    {
      id: "visibility",
      size: 130,
      header: "Visibility",
      cell: ({ row }) => (
        <ResourceVisibilityBadge
          scope={row.original.scope}
          teams={undefined}
          users={undefined}
          authorId={currentUserId}
          authorName={session?.user?.name}
          currentUserId={currentUserId}
          showSelfAsMe
        />
      ),
    },
    {
      id: "files",
      size: 90,
      header: () => <div className="text-right">Files</div>,
      cell: ({ row }) => (
        <div className="text-right text-sm text-muted-foreground">
          {row.original.fileCount}{" "}
          {row.original.fileCount === 1 ? "file" : "files"}
        </div>
      ),
    },
    {
      id: "usageCount",
      accessorKey: "usageCount",
      size: 100,
      header: ({ column }) => (
        <div className="flex justify-end pr-4">
          <SkillSortableHeader
            label="Uses"
            isSorted={column.getIsSorted()}
            onToggle={() =>
              column.toggleSorting(column.getIsSorted() === "asc")
            }
          />
        </div>
      ),
      cell: ({ row }) => (
        <div className="flex justify-end pr-4">
          <SkillUsageSummary
            usageCount={row.original.usageCount}
            usageUserCount={row.original.usageUserCount}
            lastUsedAt={row.original.lastUsedAt}
          />
        </div>
      ),
    },
    {
      id: "actions",
      size: 150,
      header: () => <div className="pl-4 text-right">Actions</div>,
      cell: ({ row }) => (
        <div className="flex justify-end pl-4">
          {renderActions(row.original)}
        </div>
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
      <SkillCollection
        items={skills}
        columns={columns}
        getRowId={(skill) => `${skill.pluginId}:${skill.skillPath}`}
        renderCard={(skill) => (
          <TableCard
            key={`${skill.pluginId}:${skill.skillPath}`}
            icon={<PluginSourceIcon plugin={skill} />}
            title={<Link href={pluginSkillHref(skill)}>{skill.name}</Link>}
            description={skill.description || "No description"}
            actions={renderActions(skill)}
            footer={
              <div className="flex items-center justify-between gap-3">
                <span>
                  {skill.fileCount} {skill.fileCount === 1 ? "file" : "files"}
                </span>
                <span>
                  {skill.usageCount} {skill.usageCount === 1 ? "use" : "uses"}
                </span>
              </div>
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{skill.pluginName}</Badge>
              <ResourceVisibilityBadge
                scope={skill.scope}
                teams={undefined}
                users={undefined}
                authorId={currentUserId}
                authorName={session?.user?.name}
                currentUserId={currentUserId}
                showSelfAsMe
              />
              {!skill.pluginEnabled && (
                <Badge variant="outline">Plugin disabled</Badge>
              )}
              {skill.compatibility && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="outline" className="gap-1">
                      <Info className="h-3 w-3" />
                      compatibility
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>{skill.compatibility}</TooltipContent>
                </Tooltip>
              )}
            </div>
          </TableCard>
        )}
        isLoading={isLoading}
        emptyMessage="No plugin skills match the current filters."
        sorting={sorting}
        onSortingChange={setSorting}
        onRowClick={(skill) => router.push(pluginSkillHref(skill))}
        fixedWidthColumnIds={[
          "pluginName",
          "visibility",
          "files",
          "usageCount",
          "actions",
        ]}
        flexibleColumnIds={["name"]}
      />
      {usageSkill && (
        <SkillUsageDialog
          skillRef={{
            kind: "plugin",
            pluginId: usageSkill.pluginId,
            skillPath: usageSkill.skillPath,
          }}
          skillName={usageSkill.name}
          open
          onOpenChange={(open) => {
            if (!open) setUsageSkill(null);
          }}
        />
      )}
    </section>
  );
}

function pluginSkillHref(skill: PluginSkill) {
  const query = skill.skillPath
    ? `?skillPath=${encodeURIComponent(skill.skillPath)}`
    : "";
  return `/skills/plugins/${skill.pluginId}${query}`;
}
