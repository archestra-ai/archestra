"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { AgentIcon } from "@/components/agent-icon";
import { PageLayout } from "@/components/page-layout";
import { ProjectFormDialog } from "@/components/project-form-dialog";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { SearchInput } from "@/components/search-input";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { type Project, useProjects } from "@/lib/project.query";

export default function ProjectsPageClient() {
  const router = useRouter();
  const { searchParams, pageIndex, pageSize, offset, setPagination } =
    useDataTableQueryParams();
  const search = searchParams.get("search") || undefined;
  const { data: session } = useSession();
  const { data: canCreate } = useHasPermissions({ project: ["create"] });
  const [createOpen, setCreateOpen] = useState(false);
  const { data: projectsResponse, isLoading } = useProjects({
    limit: pageSize,
    offset,
    search,
  });
  const projects = projectsResponse?.data ?? [];

  const columns = useMemo<ColumnDef<Project>[]>(
    () => [
      {
        id: "name",
        header: "Project",
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-3">
            <AgentIcon
              icon={row.original.icon}
              fallbackType="agent"
              size={18}
            />
            <div className="min-w-0">
              <div className="truncate font-medium">{row.original.name}</div>
              {row.original.description ? (
                <div className="truncate text-xs text-muted-foreground">
                  {row.original.description}
                </div>
              ) : null}
            </div>
          </div>
        ),
      },
      {
        id: "visibility",
        header: "Visibility",
        cell: ({ row }) => (
          <ResourceVisibilityBadge
            scope={row.original.scope}
            teams={row.original.teams}
            authorId={row.original.authorId}
            authorName={row.original.authorName}
            currentUserId={session?.user?.id}
          />
        ),
      },
      {
        id: "context",
        header: "Context",
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {row.original.knowledgeBaseIds.length} knowledge sources
          </span>
        ),
      },
      {
        id: "updatedAt",
        header: "Updated",
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {new Date(row.original.updatedAt).toLocaleDateString()}
          </span>
        ),
      },
    ],
    [session?.user?.id],
  );

  return (
    <PageLayout
      title="Projects"
      description="Group chat sessions, instructions, context, and scheduled work."
      actionButton={
        canCreate ? (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            New project
          </Button>
        ) : null
      }
    >
      <div className="space-y-4">
        <SearchInput
          objectNamePlural="projects"
          searchFields={["name", "description"]}
        />
        <DataTable
          columns={columns}
          data={projects}
          isLoading={isLoading}
          manualPagination
          pagination={{
            pageIndex,
            pageSize,
            total: projectsResponse?.pagination.total ?? 0,
          }}
          onPaginationChange={setPagination}
          onRowClick={(project) => router.push(`/projects/${project.id}`)}
          emptyMessage="No projects found."
          hasActiveFilters={!!search}
        />
      </div>
      <ProjectFormDialog open={createOpen} onOpenChange={setCreateOpen} />
    </PageLayout>
  );
}
