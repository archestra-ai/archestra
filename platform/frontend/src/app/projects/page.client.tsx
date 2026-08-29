"use client";

import {
  type archestraApiTypes,
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
} from "@archestra/shared";
import { FolderKanban, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { AgentIcon } from "@/components/agent-icon";
import { AgentSelector } from "@/components/agent-selector";
import { ApiKeyLoadError } from "@/components/api-key-load-error";
import { BulkVisibilityDialog } from "@/components/bulk-visibility-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import {
  CollectionFilters,
  FilterBar,
  filterSearchClass,
} from "@/components/filter-bar";
import { IdentityFields } from "@/components/identity-fields";
import { LoadingState } from "@/components/loading";
import { NoApiKeySetup } from "@/components/no-api-key-setup";
import { PageLayout } from "@/components/page-layout";
import { PERMANENT_DELETE_LABEL } from "@/components/permanent-delete";
import { EditProjectDialog } from "@/components/projects/edit-project-dialog";
import { projectVisibilityToScope } from "@/components/projects/project-visibility";
import { QueryLoadError } from "@/components/query-load-error";
import {
  ResourceDeletedStatusFilter,
  ResourceScopeFilter,
  useScopeFilterParams,
} from "@/components/resource-scope-filter";
import { ScopeBadge } from "@/components/scope-badge";
import { SearchInput } from "@/components/search-input";
import { StandardFormDialog } from "@/components/standard-dialog";
import {
  TableCardGrid,
  TableCardSelectionScope,
  TableCardView,
  TableCardViewContent,
  TableCardViewToggle,
  useNavigableCard,
} from "@/components/table-card-view";
import { Badge } from "@/components/ui/badge";
import { BulkActions } from "@/components/ui/bulk-actions-bar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import { Textarea } from "@/components/ui/textarea";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { useInternalAgents } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { reportBulkOutcome } from "@/lib/bulk-action";
import {
  type BulkCardSelectionProps,
  useBulkCardSelection,
} from "@/lib/hooks/use-bulk-card-selection";
import { useBulkSelection } from "@/lib/hooks/use-bulk-selection";
import { useDialogUrlParam } from "@/lib/hooks/use-dialog-url-param";
import { useHasAnyApiKey } from "@/lib/llm-provider-api-keys.query";
import {
  canDeleteProject,
  canManageProject,
} from "@/lib/projects/project-permissions";
import { sortProjectsPinnedFirst } from "@/lib/projects/project-sort";
import {
  useBulkDeleteProjects,
  useBulkUpdateProjectVisibility,
  useCreateProject,
  useDeleteProject,
  usePermanentlyDeleteProject,
  usePinProject,
  useProject,
  useProjects,
  useRestoreProject,
} from "@/lib/projects/projects.query";
import { ProjectActionsMenu } from "./project-actions-menu";
import { ProjectDeleteConfirmDialog } from "./project-delete-confirm-dialog";
import { DeletedProjectsTable, ProjectsTable } from "./projects-table";

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
  const { scope, teamIds, authorIds, excludeAuthorIds, hasActiveScopeFilters } =
    useScopeFilterParams();
  const search = searchParams.get("search") ?? undefined;
  // The trash. The backend serves this slice to project admins only (empty for
  // everyone else), and the status filter that reaches it is gated the same way.
  const isDeletedView = searchParams.get("status") === "deleted";
  const {
    data,
    isPending,
    isFetching,
    isLoadingError: isProjectsLoadError,
    refetch: refetchProjects,
  } = useProjects({
    scope,
    search,
    teamIds,
    authorIds,
    excludeAuthorIds,
    status: isDeletedView ? "deleted" : undefined,
    toastOnError: false,
  });
  const {
    hasAnyApiKey,
    isLoading: isApiKeyLoading,
    isLoadError: isApiKeyLoadError,
    refetch: refetchApiKeys,
  } = useHasAnyApiKey();
  const [createOpen, setCreateOpen] = useState(false);
  const editId = searchParams.get("edit");
  const { data: editingProjectFromUrl } = useProject(editId ?? undefined);
  const {
    entity: editingProject,
    open: openEditDialog,
    close: closeEditDialog,
  } = useDialogUrlParam<ProjectListItem>({
    paramName: "edit",
    entityFromUrl: editingProjectFromUrl ?? null,
  });
  const [deletingProject, setDeletingProject] =
    useState<ProjectListItem | null>(null);
  const [permanentlyDeletingProject, setPermanentlyDeletingProject] =
    useState<ProjectListItem | null>(null);
  // Pinned-first grouping applies in every scope: oversight projects simply
  // aren't pinnable, so they fall into the unpinned section on their own. Not
  // in the trash, though — a deleted project keeps its `pinnedAt`, and the
  // trash table has no Pinned section and no pin indicator, so sorting there
  // would float a row to the top with nothing on screen explaining why.
  const projects = useMemo(
    () => (isDeletedView ? (data ?? []) : sortProjectsPinnedFirst(data ?? [])),
    [data, isDeletedView],
  );
  const pinnedProjects = projects.filter((project) => project.pinnedAt);
  const unpinnedProjects = projects.filter((project) => !project.pinnedAt);
  const deleteProject = useDeleteProject();
  const restoreProject = useRestoreProject();
  const permanentlyDeleteProject = usePermanentlyDeleteProject();
  const pinProjectMutation = usePinProject();
  const togglePin = (project: ProjectListItem) =>
    pinProjectMutation.mutate({ id: project.id, pinned: !project.pinnedAt });
  // Only consulted on the active slice; the trash has its own empty state.
  const hasActiveFilter = hasActiveScopeFilters || !!search;

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
      <TableCardView storageKey="archestra-projects-view">
        <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} />
        {editingProject && (
          <EditProjectDialog
            projectId={editingProject.id}
            open
            onOpenChange={(open) => {
              if (!open) closeEditDialog();
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
        {permanentlyDeletingProject && (
          <DeleteConfirmDialog
            open={!!permanentlyDeletingProject}
            onOpenChange={(open) => {
              if (!open) setPermanentlyDeletingProject(null);
            }}
            title="Delete project permanently"
            description={`This destroys "${permanentlyDeletingProject.name}" along with its files and scheduled tasks. Its chats were kept as ordinary conversations when it was deleted and stay. Nothing recovers the project itself.`}
            isPending={permanentlyDeleteProject.isPending}
            onConfirm={async () => {
              const ok = await permanentlyDeleteProject.mutateAsync({
                id: permanentlyDeletingProject.id,
              });
              if (ok) setPermanentlyDeletingProject(null);
            }}
            confirmLabel={PERMANENT_DELETE_LABEL}
          />
        )}
        <div>
          <CollectionFilters>
            <FilterBar
              leading
              actions={!isDeletedView ? <TableCardViewToggle /> : undefined}
            >
              {/* Hidden in the trash: the backend serves that slice whole, ignoring
              search and scope, so live controls would read as broken filters. */}
              {!isDeletedView && (
                <>
                  <SearchInput
                    isLoading={isFetching}
                    placeholder="Search projects"
                    paramName="search"
                    className={filterSearchClass}
                  />
                  <ResourceScopeFilter
                    ownerLabelPlural="projects"
                    allLabel="All projects"
                    adminPermission={{ project: ["admin"] }}
                  />
                </>
              )}
              {/* Gated on `project:admin`, matching the slice the backend serves:
              anyone else switching to Deleted would get an empty table. */}
              <ResourceDeletedStatusFilter
                deletePermission={{ project: ["admin"] }}
              />
            </FilterBar>
          </CollectionFilters>
          {(isPending || isFetching) && projects.length === 0 ? (
            <LoadingState label="Loading projects…" variant="page" />
          ) : isDeletedView ? (
            projects.length === 0 ? (
              <EmptyState icon={FolderKanban} title="No deleted projects" />
            ) : (
              <DeletedProjectsTable
                projects={projects}
                onRestore={(project) =>
                  restoreProject.mutate({ id: project.id })
                }
                onPermanentlyDelete={setPermanentlyDeletingProject}
              />
            )
          ) : projects.length === 0 ? (
            <EmptyState
              icon={FolderKanban}
              title={
                hasActiveFilter
                  ? "No projects match your filters"
                  : "No projects yet"
              }
              description={
                hasActiveFilter
                  ? "Try adjusting your search or filters."
                  : undefined
              }
            />
          ) : (
            <>
              {pinnedProjects.length > 0 && (
                <ProjectSection
                  title="Pinned"
                  projects={pinnedProjects}
                  onTogglePin={togglePin}
                  onEdit={openEditDialog}
                  onDelete={setDeletingProject}
                />
              )}
              <ProjectSection
                title={pinnedProjects.length > 0 ? "All projects" : undefined}
                projects={unpinnedProjects}
                onTogglePin={togglePin}
                onEdit={openEditDialog}
                onDelete={setDeletingProject}
              />
            </>
          )}
        </div>
      </TableCardView>
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
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkShareOpen, setBulkShareOpen] = useState(false);
  const bulkDelete = useBulkDeleteProjects();
  const bulkShare = useBulkUpdateProjectVisibility();
  const { data: isProjectAdmin } = useHasPermissions({ project: ["admin"] });
  const { data: canShareOrg } = useHasPermissions({ project: ["share-org"] });
  const { data: canUpdateProjects } = useHasPermissions({
    project: ["update"],
  });
  const { data: canDeleteProjects } = useHasPermissions({
    project: ["delete"],
  });
  const canShareProjectItem = (project: ProjectListItem) =>
    !!canUpdateProjects &&
    canManageProject(project.viewerRole, !!isProjectAdmin);
  const canDeleteProjectItem = (project: ProjectListItem) => {
    const manageable = canManageProject(project.viewerRole, !!isProjectAdmin);
    return !!(
      canDeleteProjects &&
      manageable &&
      canDeleteProject({
        viewerRole: project.viewerRole,
        visibility: project.visibility,
        isProjectAdmin: !!isProjectAdmin,
        canShareOrg: !!canShareOrg,
      })
    );
  };
  const canSelectProject = (project: ProjectListItem) =>
    canShareProjectItem(project) || canDeleteProjectItem(project);
  const {
    rowSelection,
    setRowSelection,
    onPageRowIdsChange,
    clearSelection,
    selected: selectedProjects,
    selectAllMatching,
    rangeSelection,
  } = useBulkSelection({
    rows: projects,
    getId: (project) => project.id,
    canSelect: canSelectProject,
    filterSignature: `projects:${projects.map((project) => project.id).join(",")}`,
    matchDescription: "are listed here",
  });
  const cardSelection = useBulkCardSelection({
    rows: projects,
    getRowId: (project) => project.id,
    rowSelection,
    setRowSelection,
    canSelect: canSelectProject,
    rangeSelection,
  });
  const selectedForSharing = selectedProjects.filter(canShareProjectItem);
  const selectedForDelete = selectedProjects.filter(canDeleteProjectItem);

  if (projects.length === 0) return null;

  return (
    <section className="space-y-3">
      {title ? (
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </h2>
      ) : null}
      <BulkActions
        count={selectedProjects.length}
        noun="project"
        onClear={clearSelection}
        busy={bulkDelete.isPending || bulkShare.isPending}
        selectAllMatching={selectAllMatching}
      >
        <PermissionButton
          permissions={{ project: ["update"] }}
          variant="outline"
          size="sm"
          disabled={selectedForSharing.length === 0}
          tooltip={
            selectedForSharing.length === 0
              ? "None of the selected projects can be shared by you"
              : undefined
          }
          onClick={() => setBulkShareOpen(true)}
        >
          <span>Edit sharing</span>
        </PermissionButton>
        <PermissionButton
          permissions={{ project: ["delete"] }}
          variant="destructive"
          size="sm"
          disabled={selectedForDelete.length === 0}
          tooltip={
            selectedForDelete.length === 0
              ? "None of the selected projects can be deleted by you"
              : undefined
          }
          onClick={() => setBulkDeleteOpen(true)}
        >
          <Trash2 className="h-4 w-4" />
          <span>Delete</span>
        </PermissionButton>
      </BulkActions>
      <TableCardViewContent
        table={
          <ProjectsTable
            projects={projects}
            onTogglePin={onTogglePin}
            onEdit={onEdit}
            onDelete={onDelete}
            rowSelection={rowSelection}
            onRowSelectionChange={setRowSelection}
            onPageRowIdsChange={onPageRowIdsChange}
            canSelect={canSelectProject}
            rangeSelection={rangeSelection}
          />
        }
        cards={
          <ProjectCards
            projects={projects}
            cardSelection={cardSelection}
            onVisibleRowIdsChange={onPageRowIdsChange}
            onTogglePin={onTogglePin}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        }
      />
      {bulkDeleteOpen && (
        <DeleteConfirmDialog
          open={bulkDeleteOpen}
          onOpenChange={setBulkDeleteOpen}
          title="Delete projects"
          description={`Delete ${selectedForDelete.length} ${
            selectedForDelete.length === 1 ? "project" : "projects"
          }? Their chats and files go with them.`}
          isPending={bulkDelete.isPending}
          onConfirm={() => {
            bulkDelete.mutate(
              selectedForDelete.map((project) => ({
                id: project.id,
                name: project.name,
              })),
              {
                onSuccess: (outcome) => {
                  reportBulkOutcome({
                    outcome,
                    verb: "Deleted",
                    failureVerb: "delete",
                    noun: "project",
                  });
                  setBulkDeleteOpen(false);
                  if (outcome.failed.length === 0) clearSelection();
                },
              },
            );
          }}
          confirmLabel="Delete projects"
          pendingLabel="Deleting..."
        />
      )}
      {bulkShareOpen && (
        <BulkVisibilityDialog
          open={bulkShareOpen}
          onOpenChange={setBulkShareOpen}
          noun="project"
          isPending={bulkShare.isPending}
          items={selectedForSharing.map((project) => ({
            id: project.id,
            // A project's list row carries names rather than audience ids, so
            // the dialog starts at the agreed scope and asks for the audience.
            scope:
              project.visibility === "organization"
                ? "org"
                : project.visibility === "team"
                  ? "team"
                  : "personal",
            teams: [],
            users: [],
          }))}
          onApply={async (change) => {
            const outcome = await bulkShare.mutateAsync({
              projects: selectedForSharing,
              scope: change.scope,
              teamIds: change.teamIds,
              userIds: change.userIds,
            });
            reportBulkOutcome({
              outcome,
              verb: "Updated sharing for",
              failureVerb: "update",
              noun: "project",
            });
            if (outcome.succeeded.length === 0) return false;
            if (outcome.failed.length === 0) clearSelection();
            return true;
          }}
        />
      )}
    </section>
  );
}

function ProjectCards({
  projects,
  cardSelection,
  onVisibleRowIdsChange,
  onTogglePin,
  onEdit,
  onDelete,
}: {
  projects: ProjectListItem[];
  cardSelection: (project: ProjectListItem) => BulkCardSelectionProps;
  onVisibleRowIdsChange: (ids: string[]) => void;
  onTogglePin: (project: ProjectListItem) => void;
  onEdit: (project: ProjectListItem) => void;
  onDelete: (project: ProjectListItem) => void;
}) {
  return (
    <TableCardSelectionScope
      rowIds={projects.map((project) => project.id)}
      onVisibleRowIdsChange={onVisibleRowIdsChange}
    >
      <TableCardGrid>
        {projects.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            onTogglePin={onTogglePin}
            onEdit={onEdit}
            onDelete={onDelete}
            {...cardSelection(project)}
          />
        ))}
      </TableCardGrid>
    </TableCardSelectionScope>
  );
}

function ProjectCard({
  project,
  onTogglePin,
  onEdit,
  onDelete,
  selected,
  selectionDisabled,
  onSelectedChange,
  onSelectionClick,
}: {
  project: ProjectListItem;
  onTogglePin: (project: ProjectListItem) => void;
  onEdit: (project: ProjectListItem) => void;
  onDelete: (project: ProjectListItem) => void;
} & BulkCardSelectionProps) {
  const { data: isProjectAdmin } = useHasPermissions({ project: ["admin"] });
  const { data: canShareOrg } = useHasPermissions({ project: ["share-org"] });
  const router = useRouter();
  const navigation = useNavigableCard({
    onNavigate: () => router.push(`/projects/${project.id}`),
    selected,
  });
  return (
    <div
      {...navigation.props}
      className={`rounded-lg border p-4 transition-colors ${navigation.className} ${selected ? "border-primary bg-primary/5" : ""}`}
    >
      <div className="flex items-start gap-3">
        <Checkbox
          className="mt-1"
          checked={selected}
          disabled={selectionDisabled}
          onCheckedChange={(value) => onSelectedChange(!!value)}
          onClick={onSelectionClick}
          aria-label={`Select ${project.name}`}
          aria-description={
            selectionDisabled ? "You cannot modify this project" : undefined
          }
          title={
            selectionDisabled ? "You cannot modify this project" : undefined
          }
        />
        <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
          <Link
            href={`/projects/${project.id}`}
            className="flex min-w-0 items-center gap-2"
          >
            <span className="shrink-0">
              <AgentIcon icon={project.icon} fallbackType="project" size={18} />
            </span>
            <span className="min-w-0 truncate font-medium">{project.name}</span>
          </Link>
          <span className="flex shrink-0 items-center gap-1">
            {/* Scope pill (personal/team/org) on every card. The owner label is
              added only on another member's PERSONAL project (admin oversight),
              where the personal pill alone can't say whose it is — for team/org
              the scope pill already conveys the sharing. */}
            <ScopeBadge
              scope={projectVisibilityToScope(project.visibility)}
              teamNames={project.shareTeamNames}
              userNames={project.shareUserNames}
            />
            {project.viewerRole === "admin" && project.visibility === null && (
              <Badge variant="secondary">
                {project.ownerName
                  ? `Owned by ${project.ownerName}`
                  : "Other user"}
              </Badge>
            )}
            <ProjectActionsMenu
              pinned={!!project.pinnedAt}
              canPin={project.viewerRole !== "admin"}
              canManage={canManageProject(project.viewerRole, !!isProjectAdmin)}
              canDelete={canDeleteProject({
                viewerRole: project.viewerRole,
                visibility: project.visibility,
                isProjectAdmin: !!isProjectAdmin,
                canShareOrg: !!canShareOrg,
              })}
              onTogglePin={() => onTogglePin(project)}
              onEdit={() => onEdit(project)}
              onDelete={() => onDelete(project)}
            />
          </span>
        </div>
      </div>
      {/* Always reserve two lines so cards keep a uniform height regardless of
          description length (or absence). */}
      <p className="mt-1 line-clamp-2 h-10 text-sm text-muted-foreground">
        {project.description}
      </p>
    </div>
  );
}

type CreateProjectForm = {
  name: string;
  description: string;
  icon: string | null;
  defaultAgentId: string | null;
};

/** Sentinel for "no pinned agent" — the picker cannot hold an empty value. */
const NO_DEFAULT_AGENT = "__org_default__";

function CreateProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const form = useForm<CreateProjectForm>({
    defaultValues: {
      name: "",
      description: "",
      icon: null,
      defaultAgentId: null,
    },
    mode: "onChange",
  });
  const createProject = useCreateProject();
  // Without `agent:read` the list comes back empty, which would read as "this
  // org has no agents" rather than "not yours to set" — hide the field instead.
  const { data: canReadAgents } = useHasPermissions({ agent: ["read"] });
  // A new project is unshared and you are its owner, so anything you can run
  // qualifies. Sharing it later narrows the offer (and drops a pin the new
  // audience cannot reach) in the edit dialog.
  const { data: accessibleAgents = [] } = useInternalAgents({
    enabled: open && canReadAgents === true,
  });
  const icon = form.watch("icon");
  const name = form.watch("name");
  const description = form.watch("description");
  const defaultAgentId = form.watch("defaultAgentId");
  const hasLengthError =
    name.length > PROJECT_NAME_MAX_LENGTH ||
    description.length > PROJECT_DESCRIPTION_MAX_LENGTH;

  const onSubmit = form.handleSubmit(
    async ({ name, description, icon, defaultAgentId }) => {
      const project = await createProject.mutateAsync({
        name: name.trim(),
        description: description.trim() || null,
        icon,
        defaultAgentId,
      });
      if (project) {
        form.reset();
        onOpenChange(false);
        router.push(`/projects/${project.id}`);
      }
    },
  );

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
      <IdentityFields
        icon={icon}
        onIconChange={(next) =>
          form.setValue("icon", next, { shouldDirty: true })
        }
        fallbackType="project"
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="new-project-name">Name *</Label>
            <Input
              autoFocus
              id="new-project-name"
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
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-project-description">Description</Label>
            <Textarea
              id="new-project-description"
              placeholder="What is this project about?"
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
      </IdentityFields>

      {canReadAgents === true && (
        <div className="space-y-1.5">
          <Label>Default agent</Label>
          <AgentSelector
            mode="single"
            agents={accessibleAgents}
            value={defaultAgentId ?? NO_DEFAULT_AGENT}
            onValueChange={(value) =>
              form.setValue(
                "defaultAgentId",
                value === NO_DEFAULT_AGENT ? null : value,
                { shouldDirty: true },
              )
            }
            hint="Any agent you can use"
            sentinelOption={{
              value: NO_DEFAULT_AGENT,
              label: "Default",
            }}
            className="w-full"
          />
          <p className="text-xs text-muted-foreground">
            Preselected for new chats and scheduled tasks in this project.
          </p>
        </div>
      )}
    </StandardFormDialog>
  );
}
