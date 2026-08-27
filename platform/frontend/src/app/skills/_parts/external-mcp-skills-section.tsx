"use client";

import type { archestraApiTypes } from "@archestra/shared";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { ChartColumn, MessageSquare, Server } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { TableCard } from "@/components/table-card-view";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { useSession } from "@/lib/auth/auth.query";
import { SkillCollection, SkillSortableHeader } from "./skill-collection";
import { SkillUsageDialog } from "./skill-usage-dialog";
import { SkillUsageSummary } from "./skill-usage-summary";

type ExternalSkill =
  archestraApiTypes.GetExternalMcpSkillsResponses["200"][number];

export function filterExternalMcpSkills({
  skills,
  search,
  scope,
}: {
  skills: ExternalSkill[];
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
        skill.serverName.toLowerCase().includes(needle)),
  );
}

export function ExternalMcpSkillsSection({
  skills,
  showWhenEmpty = false,
  isLoading = false,
}: {
  skills: ExternalSkill[];
  showWhenEmpty?: boolean;
  isLoading?: boolean;
}) {
  const router = useRouter();
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const [sorting, setSorting] = useState<SortingState>([]);
  const [usageSkill, setUsageSkill] = useState<ExternalSkill | null>(null);

  const renderActions = (skill: ExternalSkill) => {
    const actions: TableRowAction[] = [
      {
        icon: <MessageSquare className="h-4 w-4" />,
        label: "Chat",
        permissions: { chat: ["read", "create"] },
        href: externalSkillChatHref(skill),
      },
      {
        icon: <ChartColumn className="h-4 w-4" />,
        label: "Usage",
        permissions: {
          skill: ["read"],
          mcpServerInstallation: ["read"],
        },
        onClick: () => setUsageSkill(skill),
      },
      {
        icon: <Server className="h-4 w-4" />,
        label: "Manage MCP server",
        href: externalSkillSourceHref(skill),
      },
    ];
    return <TableRowActions actions={actions} itemName={skill.name} />;
  };

  const columns: ColumnDef<ExternalSkill>[] = [
    {
      id: "serverName",
      accessorKey: "serverName",
      size: 180,
      minSize: 180,
      maxSize: 240,
      header: ({ column }) => (
        <SkillSortableHeader
          label="MCP server"
          isSorted={column.getIsSorted()}
          onToggle={() => column.toggleSorting(column.getIsSorted() === "asc")}
        />
      ),
      cell: ({ row }) => (
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted/30">
            <McpCatalogIcon
              icon={row.original.icon}
              catalogId={row.original.catalogId}
              size={20}
            />
          </div>
          <span
            className="truncate font-medium"
            title={row.original.serverName}
          >
            {row.original.serverName}
          </span>
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
      cell: ({ row }) => {
        const skill = row.original;
        return (
          <div className="min-w-0">
            <div className="truncate font-medium">{skill.name}</div>
            <div className="truncate text-xs text-muted-foreground">
              {skill.description || "No description"}
            </div>
          </div>
        );
      },
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
      cell: ({ row }) => {
        // The digest manifest covers SKILL.md plus every resource file.
        const fileCount = row.original.resources?.length ?? 1;
        return (
          <div className="text-right text-sm text-muted-foreground">
            {fileCount} {fileCount === 1 ? "file" : "files"}
          </div>
        );
      },
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
      header: () => <div className="text-right">Actions</div>,
      cell: ({ row }) => (
        <div className="flex justify-end">{renderActions(row.original)}</div>
      ),
    },
  ];

  if (skills.length === 0 && !showWhenEmpty && !isLoading) return null;

  return (
    <section className="space-y-3" aria-labelledby="external-skills-title">
      <div className="flex items-center gap-2">
        <h2
          id="external-skills-title"
          className="text-sm font-medium uppercase tracking-wide text-muted-foreground"
        >
          Skills from installed MCP servers
        </h2>
        <Badge variant="secondary" className="px-1.5 py-0">
          Beta
        </Badge>
      </div>
      <SkillCollection
        items={skills}
        columns={columns}
        getRowId={(skill) => `${skill.mcpServerId}:${skill.id}`}
        renderCard={(skill) => {
          const fileCount = skill.resources?.length ?? 1;
          return (
            <TableCard
              key={`${skill.mcpServerId}:${skill.id}`}
              icon={
                <McpCatalogIcon
                  icon={skill.icon}
                  catalogId={skill.catalogId}
                  size={20}
                />
              }
              title={<Link href={externalSkillHref(skill)}>{skill.name}</Link>}
              description={skill.description || "No description"}
              actions={renderActions(skill)}
              footer={
                <div className="flex items-center justify-between gap-3">
                  <span>
                    {fileCount} {fileCount === 1 ? "file" : "files"}
                  </span>
                  <span>
                    {skill.usageCount} {skill.usageCount === 1 ? "use" : "uses"}
                  </span>
                </div>
              }
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">{skill.serverName}</Badge>
                <ResourceVisibilityBadge
                  scope={skill.scope}
                  teams={undefined}
                  users={undefined}
                  authorId={currentUserId}
                  authorName={session?.user?.name}
                  currentUserId={currentUserId}
                  showSelfAsMe
                />
              </div>
            </TableCard>
          );
        }}
        isLoading={isLoading}
        emptyMessage="No MCP skills match the current filters."
        sorting={sorting}
        onSortingChange={setSorting}
        onRowClick={(skill) => router.push(externalSkillHref(skill))}
        fixedWidthColumnIds={[
          "serverName",
          "visibility",
          "files",
          "usageCount",
        ]}
        flexibleColumnIds={["name"]}
      />
      {usageSkill && (
        <SkillUsageDialog
          skillRef={{
            kind: "externalMcp",
            mcpServerId: usageSkill.mcpServerId,
            uri: usageSkill.uri,
          }}
          skillName={usageSkill.name}
          open
          onOpenChange={(open) => !open && setUsageSkill(null)}
        />
      )}
    </section>
  );
}

function externalSkillHref(skill: ExternalSkill) {
  return `/skills/external/${skill.id}?mcpServerId=${skill.mcpServerId}`;
}

function externalSkillSourceHref(skill: ExternalSkill) {
  return `/mcp/registry/${skill.catalogId}`;
}

function externalSkillChatHref(skill: ExternalSkill) {
  const params = new URLSearchParams({
    mcp_skill_id: skill.id,
    mcp_server_id: skill.mcpServerId,
    mcp_skill_uri: skill.uri,
    mcp_skill_name: skill.name,
    mcp_server_name: skill.serverName,
    mcp_skill_display_name: `${skill.serverName} [${skill.scope}:${skill.mcpServerId.slice(0, 8)}] / ${skill.name}`,
  });
  return `/chat/new?${params.toString()}`;
}
