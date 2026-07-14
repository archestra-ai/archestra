"use client";

import {
  type archestraApiTypes,
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
} from "@archestra/shared";
import {
  FolderKanban,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { AgentIcon } from "@/components/agent-icon";
import { AgentIconPicker } from "@/components/agent-icon-picker";
import { ApiKeyLoadError } from "@/components/api-key-load-error";
import { NoApiKeySetup } from "@/components/no-api-key-setup";
import { PageLayout } from "@/components/page-layout";
import { ProjectScopeFilter } from "@/components/project-scope-filter";
import { EditProjectDialog } from "@/components/projects/edit-project-dialog";
import { projectVisibilityToScope } from "@/components/projects/project-visibility";
import { QueryLoadError } from "@/components/query-load-error";
import { ScopeBadge } from "@/components/scope-badge";
import { SearchInput } from "@/components/search-input";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useHasAnyApiKey } from "@/lib/llm-provider-api-keys.query";
import {
  parseProjectScope,
  toApiProjectScope,
} from "@/lib/projects/project-list-scope";
import { canManageProject } from "@/lib/projects/project-permissions";
import { sortProjectsPinnedFirst } from "@/lib/projects/project-sort";
import {
  useCreateProject,
  useDeleteProject,
  usePinProject,
  useProjects,
} from "@/lib/projects/projects.query";
import { ProjectDeleteConfirmDialog } from "./project-delete-confirm-dialog";

export default function ProjectsPageClient() {
  return (
    <ErrorBoundary>
      <Suspense>
        <ProjectsList />
      </Suspense>
    </ErrorBoundary>
  );
}

const PROJECTS_DESCRIPTION =
  "Collections of chats with shared files. Share a project to let teammates follow along and start their own chats.";

function ProjectsList() {
  const searchParams = useSearchParams();
  const scope = parseProjectScope(searchParams.get("scope"));
  const search = searchParams.get("search") ?? undefined;
  const csvParam = (key: string): string[] | undefined => {
    const values = searchParams.get(key)?.split(",").filter(Boolean);
    return values && values.length > 0 ? values : undefined;
  };
  const teamIds = csvParam("teamIds");
  const authorIds = csvParam("authorIds");
  const excludeAuthorIds = csvParam("excludeAuthorIds");
  const {
    data,
    isPending,
    isLoadingError: isProjectsLoadError,
    refetch: refetchProjects,
  } = useProjects({
    scope: toApiProjectScope(scope),
    search,
    teamIds,
    authorIds,
    excludeAuthorIds,
    toastOnError: false,
  });
  const {
    hasAnyApiKey,
    isLoading: isApiKeyLoading,
    isLoadError: isApiKeyLoadError,
    refetch: refetchApiKeys,
  } = useHasAnyApiKey();
  const [createOpen, setCreateOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<ProjectListItem | null>(
    null,
  );
  const [deletingProject, setDeletingProject] =
    useState<ProjectListItem | null>(null);
  // Pinned-first grouping applies in every scope: oversight projects simply
  // aren't pinnable, so they fall into the unpinned section on their own.
  const projects = useMemo(() => sortProjectsPinnedFirst(data ?? []), [data]);
  const pinnedProjects = projects.filter((project) => project.pinnedAt);
  const unpinnedProjects = projects.filter((project) => !project.pinnedAt);
  const deleteProject = useDeleteProject();
  const pinProjectMutation = usePinProject();
  const togglePin = (project: ProjectListItem) =>
    pinProjectMutation.mutate({ id: project.id, pinned: !project.pinnedAt });
  const hasActiveFilter =
    scope !== "all" ||
    !!search ||
    !!teamIds ||
    !!authorIds ||
    !!excludeAuthorIds;

  // The first keys fetch failed with no cached list (e.g. offline cold start).
  // Show a retry state rather than the setup prompt, which would wrongly imply
  // the user has no keys configured. `isLoadError` is scoped to the first-fetch
  // failure, so a failed background refetch keeps the cached state instead.
  if (!isApiKeyLoading && isApiKeyLoadError) {
    return (
      <PageLayout title="Projects" description={PROJECTS_DESCRIPTION}>
        <ApiKeyLoadError onRetry={refetchApiKeys} />
      </PageLayout>
    );
  }

  // Mirror the new-chat screen: with no usable LLM key there's nothing to run a
  // project on, so prompt to add one instead of offering project creation.
  if (!isApiKeyLoading && !hasAnyApiKey) {
    return (
      <PageLayout title="Projects" description={PROJECTS_DESCRIPTION}>
        <NoApiKeySetup description="Connect an LLM provider to start a project" />
      </PageLayout>
    );
  }

  // The projects list fetch failed with no cached data. Show a retry state so a
  // failed fetch isn't misread as "No projects yet".
  if (isProjectsLoadError) {
    return (
      <PageLayout title="Projects" description={PROJECTS_DESCRIPTION}>
        <QueryLoadError
          title="Couldn't load your projects"
          onRetry={() => refetchProjects()}
        />
      </PageLayout>
    );
  }

  return (
    <PageLayout
      title="Projects"
      description={PROJECTS_DESCRIPTION}
      actionButton={
        hasAnyApiKey ? (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New project
          </Button>
        ) : undefined
      }
    >
      <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} />
      {editingProject && (
        <EditProjectDialog
          projectId={editingProject.id}
          open
          onOpenChange={(open) => {
            if (!open) setEditingProject(null);
          }}
        />
      )}
      {deletingProject && (
        <ProjectDeleteConfirmDialog
          project={deletingProject}
          open={!!deletingProject}
          onOpenChange={(open) => {
            if (!open) setDeletingProject(null);
          }}
          isPending={deleteProject.isPending}
          onConfirm={async () => {
            const ok = await deleteProject.mutateAsync({
              id: deletingProject.id,
            });
            if (ok) setDeletingProject(null);
          }}
        />
      )}
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput placeholder="Search projects" paramName="search" />
          <ProjectScopeFilter />
        </div>
        {projects.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center text-sm text-muted-foreground">
            <FolderKanban className="h-8 w-8 opacity-50" />
            <p>
              {isPending
                ? "Loading…"
                : hasActiveFilter
                  ? "No projects match your filters"
                  : "No projects yet"}
            </p>
          </div>
        ) : (
          <>
            {pinnedProjects.length > 0 && (
              <ProjectSection
                title="Pinned"
                projects={pinnedProjects}
                onTogglePin={togglePin}
                onEdit={setEditingProject}
                onDelete={setDeletingProject}
              />
            )}
            <ProjectSection
              title={pinnedProjects.length > 0 ? "All projects" : undefined}
              projects={unpinnedProjects}
              onTogglePin={togglePin}
              onEdit={setEditingProject}
              onDelete={setDeletingProject}
            />
          </>
        )}
      </div>
    </PageLayout>
  );
}

// === internal components ===

type ProjectListItem = archestraApiTypes.GetProjectsResponses["200"][number];

function ProjectSection({
  title,
  projects,
  onTogglePin,
  onEdit,
  onDelete,
}: {
  title?: string;
  projects: ProjectListItem[];
  onTogglePin: (project: ProjectListItem) => void;
  onEdit: (project: ProjectListItem) => void;
  onDelete: (project: ProjectListItem) => void;
}) {
  if (projects.length === 0) return null;

  return (
    <section className="space-y-3">
      {title ? (
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </h2>
      ) : null}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {projects.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            onTogglePin={onTogglePin}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        ))}
      </div>
    </section>
  );
}

function ProjectCard({
  project,
  onTogglePin,
  onEdit,
  onDelete,
}: {
  project: ProjectListItem;
  onTogglePin: (project: ProjectListItem) => void;
  onEdit: (project: ProjectListItem) => void;
  onDelete: (project: ProjectListItem) => void;
}) {
  const { data: isProjectAdmin } = useHasPermissions({ project: ["admin"] });
  return (
    // `relative` + the title link's stretched `::after` (after:inset-0) makes the
    // whole card a single click target for the project. Interactive children
    // (the actions menu) sit above it via `relative z-10`.
    <div className="relative rounded-lg border p-4 transition-colors hover:bg-muted/50">
      <div className="flex items-center justify-between gap-2">
        <Link
          href={`/projects/${project.id}`}
          className="flex min-w-0 items-center gap-2 after:absolute after:inset-0"
        >
          <span className="shrink-0">
            <AgentIcon icon={project.icon} fallbackType="project" size={18} />
          </span>
          <span className="min-w-0 truncate font-medium">{project.name}</span>
        </Link>
        <span className="relative z-10 flex shrink-0 items-center gap-1">
          {/* Scope pill (personal/team/org) on every card. The owner label is
              added only on another member's PERSONAL project (admin oversight),
              where the personal pill alone can't say whose it is — for team/org
              the scope pill already conveys the sharing. */}
          <ScopeBadge
            scope={projectVisibilityToScope(project.visibility)}
            teamNames={project.shareTeamNames}
          />
          {project.viewerRole === "admin" && project.visibility === null && (
            <Badge variant="secondary">
              {project.ownerName
                ? `Owned by ${project.ownerName}`
                : "Other user"}
            </Badge>
          )}
          <ProjectCardActions
            pinned={!!project.pinnedAt}
            canPin={project.viewerRole !== "admin"}
            canManage={canManageProject(project.viewerRole, !!isProjectAdmin)}
            onTogglePin={() => onTogglePin(project)}
            onEdit={() => onEdit(project)}
            onDelete={() => onDelete(project)}
          />
        </span>
      </div>
      {/* Always reserve two lines so cards keep a uniform height regardless of
          description length (or absence). */}
      <p className="mt-1 line-clamp-2 h-10 text-sm text-muted-foreground">
        {project.description}
      </p>
    </div>
  );
}

function ProjectCardActions({
  pinned,
  canPin,
  canManage,
  onTogglePin,
  onEdit,
  onDelete,
}: {
  pinned: boolean;
  canPin: boolean;
  canManage: boolean;
  onTogglePin: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Project actions">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {canPin && (
          <DropdownMenuItem onSelect={onTogglePin}>
            {pinned ? (
              <PinOff className="h-4 w-4" />
            ) : (
              <Pin className="h-4 w-4" />
            )}
            {pinned ? "Unpin" : "Pin"}
          </DropdownMenuItem>
        )}
        {canManage && (
          <>
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil className="h-4 w-4" />
              Edit details
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2 className="h-4 w-4" />
              Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type CreateProjectForm = {
  name: string;
  description: string;
  icon: string | null;
};

function CreateProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const form = useForm<CreateProjectForm>({
    defaultValues: { name: "", description: "", icon: null },
    mode: "onChange",
  });
  const createProject = useCreateProject();
  const icon = form.watch("icon");
  const name = form.watch("name");
  const description = form.watch("description");
  const hasLengthError =
    name.length > PROJECT_NAME_MAX_LENGTH ||
    description.length > PROJECT_DESCRIPTION_MAX_LENGTH;

  const onSubmit = form.handleSubmit(async ({ name, description, icon }) => {
    const project = await createProject.mutateAsync({
      name: name.trim(),
      description: description.trim() || null,
      icon,
    });
    if (project) {
      form.reset();
      onOpenChange(false);
      router.push(`/projects/${project.id}`);
    }
  });

  return (
    <StandardFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="New project"
      description="Files the agent saves in this project are kept together and show up in your files."
      size="small"
      isDirty={form.formState.isDirty}
      onSubmit={onSubmit}
      footer={
        <>
          <DialogCancelButton>Cancel</DialogCancelButton>
          <Button
            type="submit"
            disabled={
              createProject.isPending || !name.trim().length || hasLengthError
            }
          >
            Create
          </Button>
        </>
      }
    >
      <div className="flex items-start gap-3">
        <AgentIconPicker
          value={icon}
          onChange={(next) =>
            form.setValue("icon", next, { shouldDirty: true })
          }
          fallbackType="project"
        />
        <div className="flex-1 space-y-3 min-w-0">
          <Input
            autoFocus
            aria-label="Project name"
            placeholder="Project name"
            maxLength={PROJECT_NAME_MAX_LENGTH}
            aria-invalid={!!form.formState.errors.name}
            {...form.register("name", {
              required: "Project name is required.",
              maxLength: {
                value: PROJECT_NAME_MAX_LENGTH,
                message: `Project name must be ${PROJECT_NAME_MAX_LENGTH} characters or fewer.`,
              },
            })}
          />
          {form.formState.errors.name?.message && (
            <p className="text-xs text-destructive">
              {form.formState.errors.name.message}
            </p>
          )}
          <Textarea
            aria-label="Project description"
            placeholder="Description (optional)"
            rows={3}
            maxLength={PROJECT_DESCRIPTION_MAX_LENGTH}
            aria-invalid={!!form.formState.errors.description}
            {...form.register("description", {
              maxLength: {
                value: PROJECT_DESCRIPTION_MAX_LENGTH,
                message: `Description must be ${PROJECT_DESCRIPTION_MAX_LENGTH} characters or fewer.`,
              },
            })}
          />
          {form.formState.errors.description?.message && (
            <p className="text-xs text-destructive">
              {form.formState.errors.description.message}
            </p>
          )}
        </div>
      </div>
    </StandardFormDialog>
  );
}
