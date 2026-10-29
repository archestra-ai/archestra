"use client";

import {
  type archestraApiTypes,
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
} from "@archestra/shared";
import type { RowSelectionState } from "@tanstack/react-table";
import { FolderKanban, Plus, Trash2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { AdvancedLabelsSection } from "@/components/advanced-labels-section";
import type { ProfileLabel, ProfileLabelsRef } from "@/components/agent-labels";
import { AgentSelector } from "@/components/agent-selector";
import { ApiKeyLoadError } from "@/components/api-key-load-error";
import { BulkResourceAccessDialog } from "@/components/bulk-resource-access-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { EntityLabelFilter } from "@/components/entity-label-filter";
import {
  CollectionFilters,
  FilterBar,
  filterControlClass,
  filterSearchClass,
} from "@/components/filter-bar";
import { IdentityFields } from "@/components/identity-fields";
import { NoApiKeySetup } from "@/components/no-api-key-setup";
import { PageLayout } from "@/components/page-layout";
import { PERMANENT_DELETE_LABEL } from "@/components/permanent-delete";
import { EditProjectDialog } from "@/components/projects/edit-project-dialog";
import { QueryLoadError } from "@/components/query-load-error";
import { ResourceAccessFilter } from "@/components/resource-access-filter";
import { ResourceListActions } from "@/components/resource-list-actions";
import {
  ResourceDeletedStatusFilter,
  useScopeFilterParams,
} from "@/components/resource-scope-filter";
import { SearchInput } from "@/components/search-input";
import { StandardFormDialog } from "@/components/standard-dialog";
import { EmptyTableSection } from "@/components/table-section-heading";
import { BulkActions } from "@/components/ui/bulk-actions-bar";
import { BulkActionsScope } from "@/components/ui/bulk-actions-context";
import { Button } from "@/components/ui/button";
import { FieldDescription } from "@/components/ui/field-description";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import { Textarea } from "@/components/ui/textarea";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { reportBulkOutcome } from "@/lib/bulk-action";
import { BulkRangeSelectionScope } from "@/lib/bulk-range-selection-context";
import {
  useProjectLabelKeys,
  useProjectLabelValues,
} from "@/lib/entity-labels.query";
import { useControlledRowSelection } from "@/lib/hooks/use-bulk-selection";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useDialogUrlParam } from "@/lib/hooks/use-dialog-url-param";
import { useHasAnyApiKey } from "@/lib/llm-provider-api-keys.query";
import {
  canDeleteProject,
  canManageProject,
} from "@/lib/projects/project-permissions";
import { sortProjectsPinnedFirst } from "@/lib/projects/project-sort";
import {
  useAllMatchingProjects,
  useBulkDeleteProjects,
  useCreateProject,
  useDeleteProject,
  usePermanentlyDeleteProject,
  usePinProject,
  useProject,
  useProjects,
  useRestoreProject,
} from "@/lib/projects/projects.query";
import { ProjectDeleteConfirmDialog } from "./project-delete-confirm-dialog";
import { ProjectPinnedTiles } from "./project-pinned-tiles";
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
  const {
    scope,
    teamIds,
    authorIds,
    excludeAuthorIds,
    access,
    sharedWith,
    owner,
    hasActiveScopeFilters,
  } = useScopeFilterParams();
  const search = searchParams.get("search") ?? undefined;
  const labelsFilter = searchParams.get("labels") ?? undefined;
  // The trash. The backend serves this slice to project admins only (empty for
  // everyone else), and the status filter that reaches it is gated the same way.
  const isDeletedView = searchParams.get("status") === "deleted";
  const { pageIndex, pageSize, offset, setPagination } =
    useDataTableQueryParams();
  const filters = {
    scope,
    search,
    teamIds,
    authorIds,
    excludeAuthorIds,
    access,
    sharedWith,
    owner,
    labels: labelsFilter,
  };
  // Pinned projects are tiles above the table, from their own request under
  // the same filters; the table pages through the rest. Not in the trash: a
  // deleted project keeps its `pinnedAt`, and the trash table has no tiles
  // and no pin indicator, so splitting there would hide a row with nothing
  // on screen explaining why.
  const {
    data: pinnedData,
    isPending: isPinnedPending,
    isLoadingError: isPinnedLoadError,
    refetch: refetchPinned,
  } = useProjects({
    ...filters,
    pinned: true,
    limit: PINNED_PROJECTS_LIMIT,
    offset: 0,
    enabled: !isDeletedView,
    toastOnError: false,
  });
  const {
    data,
    isPending,
    isFetching,
    isLoadingError: isTableLoadError,
    refetch: refetchTable,
  } = useProjects({
    ...(isDeletedView ? {} : filters),
    pinned: isDeletedView ? undefined : false,
    status: isDeletedView ? "deleted" : undefined,
    limit: pageSize,
    offset,
    toastOnError: false,
  });
  const isProjectsLoadError =
    isTableLoadError || (!isDeletedView && isPinnedLoadError);
  const refetchProjects = () => {
    void refetchTable();
    if (!isDeletedView) void refetchPinned();
  };
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
  const pinnedProjects = useMemo(
    () =>
      isDeletedView ? [] : sortProjectsPinnedFirst(pinnedData?.data ?? []),
    [pinnedData, isDeletedView],
  );
  const tableProjects = data?.data ?? [];
  const tableTotal = data?.pagination.total ?? 0;
  const tablePagination = { pageIndex, pageSize, total: tableTotal };
  // A filter that shrinks the list can leave the URL past its last page.
  useEffect(() => {
    if (data && tableTotal > 0 && offset >= tableTotal) {
      setPagination({ pageIndex: 0, pageSize });
    }
  }, [data, tableTotal, offset, pageSize, setPagination]);
  const deleteProject = useDeleteProject();
  const restoreProject = useRestoreProject();
  const permanentlyDeleteProject = usePermanentlyDeleteProject();
  const pinProjectMutation = usePinProject();
  const togglePin = (project: ProjectListItem) =>
    pinProjectMutation.mutate({ id: project.id, pinned: !project.pinnedAt });
  // Only consulted on the active slice; the trash has its own empty state.
  const hasActiveFilter = hasActiveScopeFilters || !!search || !!labelsFilter;

  const showNoApiKeySetup =
    !isApiKeyLoading && !isApiKeyLoadError && !hasAnyApiKey;

  // Same as /chat: the add-key prompt stands alone, centered in the viewport,
  // so hide the app shell's version footer while it shows.
  useEffect(() => {
    if (!showNoApiKeySetup) return;
    document.body.classList.add("hide-version");
    return () => document.body.classList.remove("hide-version");
  }, [showNoApiKeySetup]);

  // The first keys fetch failed with no cached list (e.g. offline cold start).
  // Show a retry state rather than the setup prompt, which would wrongly imply
  // the user has no keys configured. `isLoadError` is scoped to the first-fetch
  // failure, so a failed background refetch keeps the cached state instead.
  if (!isApiKeyLoading && isApiKeyLoadError) {
    return (
      <PageLayout
        title="Projects"
        description={PROJECTS_DESCRIPTION}
        actionButton={<ResourceListActions resource="project" />}
      >
        <ApiKeyLoadError onRetry={refetchApiKeys} />
      </PageLayout>
    );
  }

  // Mirror the new-chat screen: with no usable LLM key there's nothing to run a
  // project on, so prompt to add one instead of offering project creation.
  // Rendered bare (no page header), centered like the chat screen's prompt.
  if (showNoApiKeySetup) {
    return (
      <NoApiKeySetup description="Connect an LLM provider to start a project" />
    );
  }

  // The projects list fetch failed with no cached data. Show a retry state so a
  // failed fetch isn't misread as "No projects yet".
  if (isProjectsLoadError) {
    return (
      <PageLayout
        title="Projects"
        description={PROJECTS_DESCRIPTION}
        actionButton={<ResourceListActions resource="project" />}
      >
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
        <div className="flex items-center gap-2">
          {hasAnyApiKey && (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              New project
            </Button>
          )}
          <ResourceListActions resource="project" />
        </div>
      }
    >
      <BulkActionsScope>
        <BulkRangeSelectionScope>
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
                search={
                  !isDeletedView ? (
                    <SearchInput
                      isLoading={isFetching}
                      placeholder="Search projects"
                      paramName="search"
                      className={filterSearchClass}
                    />
                  ) : null
                }
                leading
              >
                {/* Hidden in the trash: the backend serves that slice whole, ignoring
              search and scope, so live controls would read as broken filters. */}
                {!isDeletedView && (
                  <ResourceAccessFilter resource="project" noun="projects" />
                )}
                {!isDeletedView && (
                  <EntityLabelFilter
                    useLabelKeys={useProjectLabelKeys}
                    useLabelValues={useProjectLabelValues}
                    className={filterControlClass({
                      active: Boolean(labelsFilter),
                    })}
                  />
                )}
                {/* Gated on overseeing every project, matching the slice the
              backend serves: anyone else switching to Deleted would get an
              empty table. */}
                <ResourceDeletedStatusFilter
                  deletePermission={{ project: ["update"] }}
                  deletePermissionScope="*"
                />
              </FilterBar>
            </CollectionFilters>
            {isPending ||
            (!isDeletedView && isPinnedPending) ? null : isDeletedView ? (
              tableTotal === 0 ? (
                <EmptyState icon={FolderKanban} title="No deleted projects" />
              ) : (
                <DeletedProjectsTable
                  projects={tableProjects}
                  pagination={tablePagination}
                  onPaginationChange={setPagination}
                  isLoading={isFetching}
                  onRestore={(project) =>
                    restoreProject.mutate({ id: project.id })
                  }
                  onPermanentlyDelete={setPermanentlyDeletingProject}
                />
              )
            ) : pinnedProjects.length === 0 && tableTotal === 0 ? (
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
              <div className="space-y-6">
                <ProjectPinnedTiles
                  projects={pinnedProjects}
                  onUnpin={togglePin}
                  onEdit={openEditDialog}
                  onDelete={setDeletingProject}
                />
                {tableTotal > 0 ? (
                  <ProjectSection
                    title="All projects"
                    projects={tableProjects}
                    filters={filters}
                    pagination={tablePagination}
                    onPaginationChange={setPagination}
                    isLoading={isFetching}
                    onTogglePin={togglePin}
                    onEdit={openEditDialog}
                    onDelete={setDeletingProject}
                  />
                ) : (
                  <EmptyTableSection
                    title="All projects"
                    message={
                      hasActiveFilter
                        ? "No other projects match your filters"
                        : "No other projects yet"
                    }
                  />
                )}
              </div>
            )}
          </div>
        </BulkRangeSelectionScope>
      </BulkActionsScope>
    </PageLayout>
  );
}

// === internal components ===

type ProjectListItem =
  archestraApiTypes.GetProjectsResponses["200"]["data"][number];
type ProjectListFilters = Omit<
  NonNullable<archestraApiTypes.GetProjectsData["query"]>,
  "limit" | "offset" | "pinned" | "status"
>;

/** Pinned tiles are one request; more pins than this are unusual. */
const PINNED_PROJECTS_LIMIT = 100;

function ProjectSection({
  title,
  projects,
  filters,
  pagination,
  onPaginationChange,
  isLoading,
  onTogglePin,
  onEdit,
  onDelete,
}: {
  title: string;
  /** The page in view. */
  projects: ProjectListItem[];
  /** The filters the page was fetched with, for "select all matching". */
  filters: ProjectListFilters;
  pagination: { pageIndex: number; pageSize: number; total: number };
  onPaginationChange: (pagination: {
    pageIndex: number;
    pageSize: number;
  }) => void;
  isLoading: boolean;
  onTogglePin: (project: ProjectListItem) => void;
  onEdit: (project: ProjectListItem) => void;
  onDelete: (project: ProjectListItem) => void;
}) {
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkShareOpen, setBulkShareOpen] = useState(false);
  const bulkDelete = useBulkDeleteProjects();
  const { data: isProjectAdmin } = useHasPermissions(
    { project: ["update"] },
    "*",
  );
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
        isProjectAdmin: !!isProjectAdmin,
      })
    );
  };
  const canSelectProject = (project: ProjectListItem) =>
    canShareProjectItem(project) || canDeleteProjectItem(project);
  // The table is server-paginated: selection covers the page in view, and
  // "select all N" walks every matching page. Changing a filter drops an
  // escalation rather than re-pointing "all N" at a different N.
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const filterSignature = JSON.stringify(filters);
  const [escalatedFor, setEscalatedFor] = useState<string | null>(null);
  const allMatchingSelected = escalatedFor === filterSignature;
  const { effectiveRowSelection, onRowSelectionChange, rangeSelection } =
    useControlledRowSelection({
      rowSelection,
      setRowSelection,
      rows: projects,
      getRowId: (project) => project.id,
      allMatchingSelected,
      clearEscalation: () => setEscalatedFor(null),
      canSelect: canSelectProject,
    });
  const {
    data: allMatching,
    isFetching: isFetchingAllMatching,
    isError: isAllMatchingError,
  } = useAllMatchingProjects(
    { ...filters, pinned: false },
    { enabled: allMatchingSelected },
  );
  useEffect(() => {
    if (allMatchingSelected && isAllMatchingError) {
      toast.error("Couldn't select all matching projects", {
        id: "projects-all-matching-error",
      });
    }
  }, [allMatchingSelected, isAllMatchingError]);
  const clearSelection = () => {
    setRowSelection({});
    setEscalatedFor(null);
  };
  const pageSelection = projects.filter(
    (project) =>
      canSelectProject(project) && effectiveRowSelection[project.id] === true,
  );
  const selectedProjects =
    allMatchingSelected && allMatching
      ? allMatching.filter(canSelectProject)
      : pageSelection;
  const selectablePage = projects.filter(canSelectProject);
  const selectAllMatching = {
    // The offer counts every match; once escalated, the bar counts what the
    // bulk actions will act on, which leaves out rows the caller cannot change.
    total:
      allMatchingSelected && allMatching
        ? selectedProjects.length
        : pagination.total,
    pageFullySelected:
      selectablePage.length > 0 &&
      selectablePage.every((project) => effectiveRowSelection[project.id]),
    active: allMatchingSelected,
    onSelectAll: () => setEscalatedFor(filterSignature),
    matchDescription: filters.search
      ? "match this search query"
      : "match the current filters",
  };
  const selectedForSharing = selectedProjects.filter(canShareProjectItem);
  const selectedForDelete = selectedProjects.filter(canDeleteProjectItem);

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <BulkActions
        count={selectedProjects.length}
        noun="project"
        onClear={clearSelection}
        busy={
          bulkDelete.isPending || (allMatchingSelected && isFetchingAllMatching)
        }
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
      <ProjectsTable
        projects={projects}
        pagination={pagination}
        onPaginationChange={onPaginationChange}
        isLoading={isLoading}
        onTogglePin={onTogglePin}
        onEdit={onEdit}
        onDelete={onDelete}
        rowSelection={effectiveRowSelection}
        onRowSelectionChange={onRowSelectionChange}
        canSelect={canSelectProject}
        rangeSelection={rangeSelection}
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
        <BulkResourceAccessDialog
          resource="project"
          items={selectedForSharing}
          open={bulkShareOpen}
          onOpenChange={setBulkShareOpen}
          onApplied={clearSelection}
        />
      )}
    </section>
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
  const [labels, setLabels] = useState<ProfileLabel[]>([]);
  const labelsRef = useRef<ProfileLabelsRef>(null);
  // Without `agent:read` the list comes back empty, which would read as "this
  // org has no agents" rather than "not yours to set" — hide the field instead.
  const { data: canReadAgents } = useHasPermissions({ agent: ["read"] });
  // A new project is unshared and you are its owner, so anything you can run
  // qualifies. Sharing it later narrows the offer (and drops a pin the new
  // audience cannot reach) in the edit dialog.
  const icon = form.watch("icon");
  const name = form.watch("name");
  const description = form.watch("description");
  const defaultAgentId = form.watch("defaultAgentId");
  const hasLengthError =
    name.length > PROJECT_NAME_MAX_LENGTH ||
    description.length > PROJECT_DESCRIPTION_MAX_LENGTH;

  const onSubmit = form.handleSubmit(
    async ({ name, description, icon, defaultAgentId }) => {
      const nextLabels = labelsRef.current?.saveUnsavedLabel() ?? labels;
      const project = await createProject.mutateAsync({
        name: name.trim(),
        description: description.trim() || null,
        icon,
        defaultAgentId,
        labels: nextLabels,
      });
      if (project) {
        form.reset();
        setLabels([]);
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
      size="medium"
      isDirty={form.formState.isDirty || labels.length > 0}
      onSubmit={onSubmit}
      bodyClassName="space-y-4"
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
        label={<Label htmlFor="new-project-name">Name *</Label>}
      >
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
      </IdentityFields>

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

      {canReadAgents === true && (
        <div className="space-y-2">
          <Label>Default agent</Label>
          <FieldDescription>
            Preselected for new chats and scheduled tasks in this project.
          </FieldDescription>
          <AgentSelector
            mode="single"
            remote={{
              filters: { agentType: "agent", excludeBuiltIn: true },
              enabled: open && canReadAgents === true,
            }}
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
        </div>
      )}
      <AdvancedLabelsSection
        collapsible
        ref={labelsRef}
        labels={labels}
        onLabelsChange={setLabels}
      />
    </StandardFormDialog>
  );
}
