"use client";

import { archestraApiSdk } from "@shared";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Cron } from "croner";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Loader2,
  PauseCircle,
  Pencil,
  Play,
  Plus,
  Trash2,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentIcon } from "@/components/agent-icon";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { SearchInput } from "@/components/search-input";
import { TableRowActions } from "@/components/table-row-actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogForm,
  DialogHeader,
  DialogStickyFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelect } from "@/components/ui/multi-select";
import { PermissionButton } from "@/components/ui/permission-button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useProfiles } from "@/lib/agent.query";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useOrganizationMembers } from "@/lib/organization.query";
import {
  type ScheduleTrigger,
  type ScheduleTriggerRun,
  type ScheduleTriggerRunStatus,
  useCreateScheduleTrigger,
  useCreateScheduleTriggerRunConversation,
  useDeleteScheduleTrigger,
  useDisableScheduleTrigger,
  useEnableScheduleTrigger,
  useRunScheduleTriggerNow,
  useScheduleTrigger,
  useScheduleTriggerRuns,
  useScheduleTriggers,
  useUpdateScheduleTrigger,
} from "@/lib/schedule-trigger.query";
import { cn } from "@/lib/utils";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { formatCronSchedule } from "@/lib/utils/format-cron";
import {
  type AgentOption,
  buildScheduleTriggerPayload,
  DEFAULT_FORM_STATE,
  getActiveMutationVariable,
  getRunNowTrackingState,
  type ScheduleTriggerFormState,
} from "./schedule-trigger.utils";

export function ScheduleTriggersIndexPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const agentIdParam = searchParams.get("agentId");
  const { data: isScheduledTaskAdmin = false } = useHasPermissions({
    scheduledTask: ["admin"],
  });
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const [showOtherUsers, setShowOtherUsers] = useState(false);
  const [selectedAuthorIds, setSelectedAuthorIds] = useState<string[]>([]);
  const [searchName, setSearchName] = useState("");
  const [filterAgentId, setFilterAgentId] = useState<string | null>(
    agentIdParam,
  );
  const [pageSize, setPageSize] = useState(10);
  const [pageIndex, setPageIndex] = useState(0);
  const { data: members } = useOrganizationMembers(
    isScheduledTaskAdmin && showOtherUsers,
  );
  const memberItems = useMemo(
    () =>
      (members ?? [])
        .filter((m) => m.id !== currentUserId)
        .map((m) => ({
          value: m.id,
          label: m.name || m.email,
        })),
    [members, currentUserId],
  );
  const { data: triggersResponse, isLoading } = useScheduleTriggers({
    limit: pageSize,
    offset: pageIndex * pageSize,
    name: searchName || undefined,
    showAll: showOtherUsers,
    agentIds: filterAgentId ? [filterAgentId] : undefined,
    actorUserIds:
      showOtherUsers && selectedAuthorIds.length > 0
        ? selectedAuthorIds
        : undefined,
    refetchInterval: 5_000,
  });
  const { data: agents = [], isLoading: agentsLoading } = useProfiles({
    filters: { agentType: "agent" },
  });
  const createMutation = useCreateScheduleTrigger();
  const updateMutation = useUpdateScheduleTrigger();
  const deleteMutation = useDeleteScheduleTrigger();
  const [createFormOpen, setCreateFormOpen] = useState(false);
  const [editingTrigger, setEditingTrigger] = useState<ScheduleTrigger | null>(
    null,
  );
  const [formState, setFormState] =
    useState<ScheduleTriggerFormState>(DEFAULT_FORM_STATE);
  const [deletingTrigger, setDeletingTrigger] =
    useState<ScheduleTrigger | null>(null);
  const nameTouchedRef = useRef(false);

  const agentFilterOptions = useMemo(
    () =>
      agents.map((agent) => ({
        value: agent.id,
        label: agent.name || "Untitled agent",
        content: (
          <span className="flex items-center gap-2">
            <AgentIcon icon={agent.icon} size={16} />
            {agent.name || "Untitled agent"}
          </span>
        ),
      })),
    [agents],
  );

  const agentOptions = useMemo(
    () =>
      agents
        .filter(
          (agent) =>
            agent.scope !== "personal" || agent.authorId === currentUserId,
        )
        .map((agent) => ({
          value: agent.id,
          label: agent.name || "Untitled agent",
          description:
            agent.scope === "personal"
              ? "Personal agent"
              : `${agent.scope} agent`,
          content: (
            <span className="flex items-center gap-2">
              <AgentIcon icon={agent.icon} size={16} />
              {agent.name || "Untitled agent"}
            </span>
          ),
        })),
    [agents, currentUserId],
  );

  const allTriggers = triggersResponse?.data ?? [];
  const hasAgents = agentOptions.length > 0;
  const preferredAgentId =
    (filterAgentId &&
      agentOptions.some((a) => a.value === filterAgentId) &&
      filterAgentId) ||
    agentOptions[0]?.value ||
    "";
  const formPayload = buildScheduleTriggerPayload(formState);
  const isSaving = createMutation.isPending || updateMutation.isPending;
  const isComposerOpen = editingTrigger !== null || createFormOpen;

  const getDefaultName = useCallback(
    (agentId: string) => getDefaultTriggerName(agentId, agentOptions),
    [agentOptions],
  );

  useEffect(() => {
    if (
      editingTrigger ||
      !createFormOpen ||
      !preferredAgentId ||
      formState.agentId
    ) {
      return;
    }

    setFormState((current) => ({
      ...current,
      agentId: preferredAgentId,
      name: nameTouchedRef.current
        ? current.name
        : getDefaultName(preferredAgentId),
    }));
  }, [
    createFormOpen,
    editingTrigger,
    formState.agentId,
    preferredAgentId,
    getDefaultName,
  ]);

  const handledAgentIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      !agentIdParam ||
      !triggersResponse ||
      isLoading ||
      handledAgentIdRef.current === agentIdParam
    )
      return;
    handledAgentIdRef.current = agentIdParam;
    if (triggersResponse.data.length === 0) {
      setEditingTrigger(null);
      nameTouchedRef.current = false;
      setFormState({
        ...DEFAULT_FORM_STATE(),
        agentId: agentIdParam,
        name: getDefaultName(agentIdParam),
      });
      setCreateFormOpen(true);
    }
  }, [agentIdParam, triggersResponse, isLoading, getDefaultName]);

  const openCreateComposer = () => {
    setEditingTrigger(null);
    nameTouchedRef.current = false;
    setFormState({
      ...DEFAULT_FORM_STATE(),
      agentId: preferredAgentId,
      name: getDefaultName(preferredAgentId),
    });
    setCreateFormOpen(true);
  };

  const openEditComposer = useCallback((trigger: ScheduleTrigger) => {
    setEditingTrigger(trigger);
    setCreateFormOpen(false);
    nameTouchedRef.current = true;
    setFormState({
      name: trigger.name,
      agentId: trigger.agentId,
      cronExpression: trigger.cronExpression,
      timezone: trigger.timezone,
      messageTemplate: trigger.messageTemplate,
    });
  }, []);

  const closeComposer = () => {
    setEditingTrigger(null);
    setCreateFormOpen(false);
    nameTouchedRef.current = false;
    setFormState(DEFAULT_FORM_STATE());
    if (agentIdParam) {
      router.replace("/scheduled-tasks");
    }
  };

  const submitForm = async () => {
    if (!formPayload) {
      return;
    }

    const result = editingTrigger
      ? await updateMutation.mutateAsync({
          id: editingTrigger.id,
          body: formPayload,
        })
      : await createMutation.mutateAsync(formPayload);

    if (!result) {
      return;
    }

    closeComposer();
  };

  const confirmDelete = async () => {
    if (!deletingTrigger) {
      return;
    }

    const result = await deleteMutation.mutateAsync(deletingTrigger.id);
    if (result?.success) {
      setDeletingTrigger(null);
    }
  };

  const columns = useMemo<ColumnDef<ScheduleTrigger>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <span className="font-medium text-foreground">
            {row.original.name}
          </span>
        ),
      },
      {
        id: "agent",
        header: "Agent",
        cell: ({ row }) => {
          const agent = agents.find((a) => a.id === row.original.agentId);
          return (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <AgentIcon icon={agent?.icon ?? null} size={16} />
              <span>{agent?.name || "Unknown agent"}</span>
            </div>
          );
        },
      },
      ...(showOtherUsers
        ? [
            {
              id: "author",
              header: "Author",
              cell: ({ row }: { row: { original: ScheduleTrigger } }) => (
                <span className="text-sm text-muted-foreground">
                  {row.original.actor?.name ??
                    row.original.actor?.email ??
                    "Unknown"}
                </span>
              ),
            },
          ]
        : []),
      {
        id: "schedule",
        header: "Schedule",
        cell: ({ row }) => (
          <div className="text-sm text-muted-foreground">
            {formatCronSchedule(row.original.cronExpression)}
          </div>
        ),
      },
      {
        id: "nextRun",
        header: "Next Run",
        cell: ({ row }) => (
          <NextRunCell
            cronExpression={row.original.cronExpression}
            timezone={row.original.timezone}
            enabled={row.original.enabled}
          />
        ),
      },
      {
        id: "actions",
        header: "Actions",
        size: 80,
        enableHiding: false,
        cell: ({ row }) => (
          <TableRowActions
            actions={[
              {
                icon: <Pencil className="h-4 w-4" />,
                label: "Edit task",
                onClick: () => void openEditComposer(row.original),
              },
              {
                icon: <Trash2 className="h-4 w-4" />,
                label: "Delete task",
                variant: "destructive",
                onClick: () => setDeletingTrigger(row.original),
              },
            ]}
          />
        ),
      },
    ],
    [agents, openEditComposer, showOtherUsers],
  );

  return (
    <div className="flex w-full flex-col gap-5">
      <div className="flex items-center gap-4">
        <SearchInput
          objectNamePlural="tasks"
          searchFields={["name"]}
          syncQueryParams={false}
          onSearchChange={(value) => {
            setSearchName(value);
            setPageIndex(0);
          }}
        />
        <Select
          value={filterAgentId ?? "all"}
          onValueChange={(value) => {
            setFilterAgentId(value === "all" ? null : value);
            setPageIndex(0);
          }}
        >
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="All agents" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All agents</SelectItem>
            {agentFilterOptions.map((agent) => (
              <SelectItem key={agent.value} value={agent.value}>
                {agent.content}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {isScheduledTaskAdmin && (
          <Select
            value={showOtherUsers ? "others" : "mine"}
            onValueChange={(value) => {
              setShowOtherUsers(value === "others");
              setSelectedAuthorIds([]);
              setPageIndex(0);
            }}
          >
            <SelectTrigger className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mine">My tasks</SelectItem>
              <SelectItem value="others">Other users</SelectItem>
            </SelectContent>
          </Select>
        )}
        {isScheduledTaskAdmin && showOtherUsers && (
          <MultiSelect
            value={selectedAuthorIds}
            onValueChange={(ids) => {
              setSelectedAuthorIds(ids);
              setPageIndex(0);
            }}
            items={memberItems}
            placeholder="All users"
            className="w-[220px]"
            showSelectedBadges={false}
            selectedSuffix={(n) => `${n === 1 ? "user" : "users"} selected`}
          />
        )}
        <div className="ml-auto">
          <ScheduleTriggerCreateButton
            hasAgents={hasAgents}
            onClick={openCreateComposer}
          >
            New task
          </ScheduleTriggerCreateButton>
        </div>
      </div>

      {!hasAgents && !agentsLoading && (
        <Alert className="border-0 bg-muted/30">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>No internal agents available</AlertTitle>
          <AlertDescription>
            Scheduled tasks can only target internal agents that you can access.
          </AlertDescription>
        </Alert>
      )}

      <ScheduleTriggerFormDialog
        open={isComposerOpen}
        onOpenChange={(open) => {
          if (!open) {
            closeComposer();
          }
        }}
        formState={formState}
        agentOptions={agentOptions}
        agentsLoading={agentsLoading}
        hasAgents={hasAgents}
        isSaving={isSaving}
        isFormValid={formPayload !== null}
        isEditing={editingTrigger !== null}
        onSubmit={() => {
          void submitForm();
        }}
        onNameChange={(name) => {
          nameTouchedRef.current = true;
          setFormState((current) => ({ ...current, name }));
        }}
        onAgentChange={(agentId) => {
          setFormState((current) => ({
            ...current,
            agentId,
            name: nameTouchedRef.current
              ? current.name
              : getDefaultName(agentId),
          }));
        }}
        onCronExpressionChange={(cronExpression) =>
          setFormState((current) => ({ ...current, cronExpression }))
        }
        onMessageTemplateChange={(messageTemplate) =>
          setFormState((current) => ({ ...current, messageTemplate }))
        }
      />

      <DataTable
        columns={columns}
        data={allTriggers}
        isLoading={isLoading}
        emptyMessage="No scheduled tasks yet."
        manualPagination
        pagination={{
          pageIndex,
          pageSize,
          total: triggersResponse?.pagination.total ?? 0,
        }}
        onPaginationChange={(p) => {
          setPageIndex(p.pageIndex);
          setPageSize(p.pageSize);
        }}
        onRowClick={(trigger) => router.push(`/scheduled-tasks/${trigger.id}`)}
        hideSelectedCount
      />

      <DeleteConfirmDialog
        open={deletingTrigger !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeletingTrigger(null);
          }
        }}
        title="Delete scheduled trigger"
        description={
          deletingTrigger
            ? `Delete "${deletingTrigger.name}"? This action cannot be undone.`
            : "Delete this scheduled trigger? This action cannot be undone."
        }
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          void confirmDelete();
        }}
        confirmLabel="Delete trigger"
        pendingLabel="Deleting..."
      />
    </div>
  );
}

export function ScheduleTriggerDetailPage({
  triggerId,
}: {
  triggerId: string;
}) {
  const router = useRouter();
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const { data: canUpdateTrigger = false } = useHasPermissions({
    scheduledTask: ["update"],
  });
  const { data: isAgentAdmin = false } = useHasPermissions({
    agent: ["admin"],
  });
  const { data: isAgentTeamAdmin = false } = useHasPermissions({
    agent: ["team-admin"],
  });
  const { data: userTeams = [] } = useQuery({
    queryKey: ["teams"],
    queryFn: async () => {
      const response = await archestraApiSdk.getTeams({
        query: { limit: 100, offset: 0 },
      });
      return response.data?.data ?? [];
    },
  });
  const userTeamIdSet = useMemo(
    () => new Set(userTeams.map((t) => t.id)),
    [userTeams],
  );
  const { data: trigger, isLoading } = useScheduleTrigger(triggerId, {
    refetchInterval: 5_000,
  });
  const { data: agents = [], isLoading: agentsLoading } = useProfiles({
    filters: { agentType: "agent" },
  });
  const updateMutation = useUpdateScheduleTrigger();
  const deleteMutation = useDeleteScheduleTrigger();
  const enableMutation = useEnableScheduleTrigger();
  const disableMutation = useDisableScheduleTrigger();
  const runNowMutation = useRunScheduleTriggerNow();

  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [trackedRunId, setTrackedRunId] = useState<string | null>(null);
  const [formState, setFormState] =
    useState<ScheduleTriggerFormState>(DEFAULT_FORM_STATE);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const detailNameTouchedRef = useRef(true);

  useEffect(() => {
    if (!trigger) {
      return;
    }

    setFormState({
      name: trigger.name,
      agentId: trigger.agentId,
      cronExpression: trigger.cronExpression,
      timezone: trigger.timezone,
      messageTemplate: trigger.messageTemplate,
    });
  }, [trigger]);

  const agentOptions = useMemo(
    () =>
      agents
        .filter(
          (agent) =>
            agent.scope !== "personal" || agent.authorId === currentUserId,
        )
        .map((agent) => ({
          value: agent.id,
          label: agent.name || "Untitled agent",
          description:
            agent.scope === "personal"
              ? "Personal agent"
              : `${agent.scope} agent`,
          content: (
            <span className="flex items-center gap-2">
              <AgentIcon icon={agent.icon} size={16} />
              {agent.name || "Untitled agent"}
            </span>
          ),
        })),
    [agents, currentUserId],
  );
  const getDetailDefaultName = useCallback(
    (agentId: string) => getDefaultTriggerName(agentId, agentOptions),
    [agentOptions],
  );
  const formPayload = buildScheduleTriggerPayload(formState);
  const isSaving = updateMutation.isPending;
  const runNowState = getRunNowTrackingState({
    activeMutationTriggerId: getActiveMutationVariable(runNowMutation),
    currentTriggerId: triggerId,
    trackedRunId,
  });
  const isTogglePending = enableMutation.isPending || disableMutation.isPending;
  const toggleScheduleEnabled = (enabled: boolean) => {
    if (!trigger || !canUpdateTrigger) {
      return;
    }

    if (enabled) {
      enableMutation.mutate(trigger.id);
      return;
    }

    disableMutation.mutate(trigger.id);
  };

  const handleRunNow = async () => {
    const run = await runNowMutation.mutateAsync(triggerId);
    if (!run) {
      return;
    }

    setTrackedRunId(run.id);
  };

  const handleDelete = () => {
    deleteMutation.mutate(triggerId, {
      onSuccess: (result) => {
        if (result?.success) {
          setDeleteDialogOpen(false);
          router.push("/scheduled-tasks");
        }
      },
    });
  };

  const openEditDialog = () => {
    if (!trigger) {
      return;
    }

    setFormState({
      name: trigger.name,
      agentId: trigger.agentId,
      cronExpression: trigger.cronExpression,
      timezone: trigger.timezone,
      messageTemplate: trigger.messageTemplate,
    });
    setEditDialogOpen(true);
  };

  const submitForm = async () => {
    if (!formPayload) {
      return;
    }

    const result = await updateMutation.mutateAsync({
      id: triggerId,
      body: formPayload,
    });

    if (result) {
      setEditDialogOpen(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-40 items-center justify-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">Loading...</span>
      </div>
    );
  }

  if (!trigger) {
    return (
      <Alert className="border-0 bg-muted/30">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Schedule not found</AlertTitle>
        <AlertDescription>
          The trigger may have been removed, or you may no longer have access.
        </AlertDescription>
      </Alert>
    );
  }

  const matchedAgent = agents.find((a) => a.id === trigger.agentId);
  const canModifyAgent = (() => {
    if (!matchedAgent) return false;
    if (isAgentAdmin) return true;
    if (
      matchedAgent.scope === "team" &&
      isAgentTeamAdmin &&
      matchedAgent.teams?.some((t) => userTeamIdSet.has(t.id))
    )
      return true;
    if (
      matchedAgent.scope === "personal" &&
      !!currentUserId &&
      matchedAgent.authorId === currentUserId
    )
      return true;
    return false;
  })();
  const agentLinkParam = canModifyAgent ? "edit" : "view";

  return (
    <div className="mr-auto flex w-full flex-col gap-6">
      {/* Back link */}
      <Button
        variant="ghost"
        size="sm"
        asChild
        className="h-8 -ml-2 px-2 text-muted-foreground self-start"
      >
        <Link href="/scheduled-tasks">
          <ArrowLeft className="mr-1 h-4 w-4" />
          Back to Scheduled Tasks
        </Link>
      </Button>

      {/* Title row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">
            {trigger.name}
          </h1>
          <div className="flex items-center gap-2">
            <Switch
              checked={trigger.enabled}
              onCheckedChange={toggleScheduleEnabled}
              disabled={isTogglePending || !canUpdateTrigger}
              aria-label="Toggle schedule enabled"
            />
            <span className="text-sm text-muted-foreground">
              {trigger.enabled ? "Enabled" : "Disabled"}
            </span>
          </div>
        </div>
        {canUpdateTrigger && (
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <PermissionButton
                  permissions={{ scheduledTask: ["update"] }}
                  variant="outline"
                  size="icon-sm"
                  onClick={() => {
                    void handleRunNow();
                  }}
                  disabled={runNowState.isButtonSpinning}
                  aria-label="Run now"
                >
                  {runNowState.isButtonSpinning ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                </PermissionButton>
              </TooltipTrigger>
              <TooltipContent>Run now</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <PermissionButton
                  permissions={{ scheduledTask: ["update"] }}
                  variant="outline"
                  size="icon-sm"
                  onClick={openEditDialog}
                  aria-label="Edit"
                >
                  <Pencil className="h-4 w-4" />
                </PermissionButton>
              </TooltipTrigger>
              <TooltipContent>Edit</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <PermissionButton
                  permissions={{ scheduledTask: ["delete"] }}
                  variant="outline"
                  size="icon-sm"
                  onClick={() => setDeleteDialogOpen(true)}
                  disabled={deleteMutation.isPending}
                  aria-label="Delete"
                >
                  {deleteMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                </PermissionButton>
              </TooltipTrigger>
              <TooltipContent>Delete</TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>

      {/* Detail cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Link
          href={`/agents?${agentLinkParam}=${trigger.agentId}`}
          className="rounded-xl border border-border/60 bg-card px-4 py-3.5 transition-colors hover:bg-accent"
        >
          <p className="mb-2 text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
            Agent
          </p>
          <div className="flex items-center gap-2">
            <AgentIcon icon={matchedAgent?.icon ?? null} size={20} />
            <span className="text-sm text-foreground">
              {trigger.agent?.name ?? trigger.agentId}
            </span>
          </div>
        </Link>
        <DetailCard label="Task prompt">
          <p className="text-sm text-foreground line-clamp-3">
            {trigger.messageTemplate}
          </p>
        </DetailCard>
        <DetailCard label="Schedule">
          <p className="text-sm font-medium text-foreground">
            {formatCronSchedule(trigger.cronExpression)}
          </p>
          <NextRunCell
            cronExpression={trigger.cronExpression}
            timezone={trigger.timezone}
            enabled={trigger.enabled}
          />
        </DetailCard>
      </div>

      {/* Runs table */}
      <h2 className="text-lg font-semibold">History</h2>
      <ScheduleTriggerRunsTable
        trigger={trigger}
        trackedRunId={trackedRunId}
        activeMutationTriggerId={getActiveMutationVariable(runNowMutation)}
        onTrackedRunSettled={(runId) => {
          if (trackedRunId === runId) {
            setTrackedRunId(null);
          }
        }}
      />

      <ScheduleTriggerFormDialog
        open={editDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setEditDialogOpen(false);
          }
        }}
        formState={formState}
        agentOptions={agentOptions}
        agentsLoading={agentsLoading}
        hasAgents={agents.length > 0}
        isSaving={isSaving}
        isFormValid={formPayload !== null}
        isEditing
        onSubmit={() => {
          void submitForm();
        }}
        onNameChange={(name) => {
          detailNameTouchedRef.current = true;
          setFormState((current) => ({ ...current, name }));
        }}
        onAgentChange={(agentId) => {
          setFormState((current) => ({
            ...current,
            agentId,
            name: detailNameTouchedRef.current
              ? current.name
              : getDetailDefaultName(agentId),
          }));
        }}
        onCronExpressionChange={(cronExpression) =>
          setFormState((current) => ({ ...current, cronExpression }))
        }
        onMessageTemplateChange={(messageTemplate) =>
          setFormState((current) => ({ ...current, messageTemplate }))
        }
      />

      <DeleteConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Delete scheduled task"
        description={`Delete "${trigger.name}"? This action cannot be undone.`}
        isPending={deleteMutation.isPending}
        onConfirm={handleDelete}
        confirmLabel="Delete"
        pendingLabel="Deleting..."
      />
    </div>
  );
}

function getDefaultTriggerName(
  agentId: string,
  agentOptions: { value: string; label: string }[],
): string {
  const agent = agentOptions.find((a) => a.value === agentId);
  return agent ? `Scheduled ${agent.label}` : "";
}

function formatRunTimestamp(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();

  const timeStr = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (isToday) {
    return `Today at ${timeStr}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();

  if (isYesterday) {
    return `Yesterday at ${timeStr}`;
  }

  const dateStr = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

  return `${dateStr} at ${timeStr}`;
}

function RunStatusIcon({ status }: { status: ScheduleTriggerRunStatus }) {
  switch (status) {
    case "success":
      return <CheckCircle2 className="h-4 w-4 text-green-500" />;
    case "failed":
      return <XCircle className="h-4 w-4 text-red-500" />;
    case "running":
      return <Loader2 className="h-4 w-4 animate-spin text-blue-500" />;
  }
}

function DetailCard({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-card px-4 py-3.5">
      <p className="mb-2 text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
        {label}
      </p>
      {children}
    </div>
  );
}

function NextRunCell({
  cronExpression,
  timezone,
  enabled,
}: {
  cronExpression: string;
  timezone: string;
  enabled: boolean;
}) {
  if (!enabled) {
    return (
      <span className="flex items-center gap-1.5 text-sm text-muted-foreground/70">
        <PauseCircle className="h-3.5 w-3.5" />
        Paused
      </span>
    );
  }

  try {
    const cron = new Cron(cronExpression, { timezone });
    const next = cron.nextRun();
    if (!next) {
      return (
        <span className="text-sm text-muted-foreground/70">
          No upcoming run
        </span>
      );
    }
    return (
      <div className="text-sm text-muted-foreground">
        {formatRelativeTimeFromNow(next.toISOString())}
      </div>
    );
  } catch {
    return (
      <span className="text-sm text-muted-foreground/70">Invalid schedule</span>
    );
  }
}

function ScheduleTriggerCreateButton({
  hasAgents,
  onClick,
  children,
}: {
  hasAgents: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <PermissionButton
      permissions={{ scheduledTask: ["create"] }}
      onClick={onClick}
      disabled={!hasAgents}
      tooltip={
        hasAgents
          ? undefined
          : "You need access to at least one internal agent to create a schedule."
      }
    >
      <Plus className="h-4 w-4" />
      {children}
    </PermissionButton>
  );
}

type ScheduleMode = "hourly" | "daily";

const WEEKDAYS = [
  { label: "Mon", value: 1 },
  { label: "Tue", value: 2 },
  { label: "Wed", value: 3 },
  { label: "Thu", value: 4 },
  { label: "Fri", value: 5 },
  { label: "Sat", value: 6 },
  { label: "Sun", value: 0 },
] as const;

const HOURS = Array.from({ length: 24 }, (_, i) => ({
  value: String(i),
  label: `${String(i).padStart(2, "0")}:00`,
}));

function parseCronToMode(cron: string): {
  mode: ScheduleMode;
  hour: string;
  minute: string;
  days: number[];
} {
  const parts = cron.trim().split(/\s+/);
  const defaults = {
    hour: "9",
    minute: "0",
    days: [1, 2, 3, 4, 5],
  };

  if (parts.length !== 5) {
    return { mode: "daily", ...defaults };
  }

  const [min, hr, , , dow] = parts;

  // Hourly: "0 * * * *" or "N * * * *"
  if (hr === "*" && dow === "*") {
    return { mode: "hourly", ...defaults };
  }

  // Daily: specific hour, days pattern
  if (hr !== "*" && !hr.includes("/")) {
    const dayList =
      dow === "*"
        ? [0, 1, 2, 3, 4, 5, 6]
        : dow.split(",").flatMap((part) => {
            if (part.includes("-")) {
              const [start, end] = part.split("-").map(Number);
              const result: number[] = [];
              for (let i = start; i <= end; i++) result.push(i);
              return result;
            }
            return [Number(part)];
          });

    return {
      mode: "daily",
      hour: hr,
      minute: min,
      days: dayList,
    };
  }

  return { mode: "daily", ...defaults };
}

function buildCronFromSchedule(
  mode: ScheduleMode,
  hour: string,
  minute: string,
  days: number[],
): string {
  switch (mode) {
    case "hourly":
      return `${minute} * * * *`;
    case "daily": {
      const sorted = [...days].sort((a, b) => a - b);
      const dowPart =
        sorted.length === 7 || sorted.length === 0 ? "*" : sorted.join(",");
      return `${minute} ${hour} * * ${dowPart}`;
    }
  }
}

function ScheduleSection({
  cronExpression,
  onCronExpressionChange,
}: {
  cronExpression: string;
  onCronExpressionChange: (value: string) => void;
}) {
  const parsed = useMemo(
    () => parseCronToMode(cronExpression),
    [cronExpression],
  );
  const [mode, setMode] = useState<ScheduleMode>(parsed.mode);
  const [hour, setHour] = useState(parsed.hour);
  const [minute] = useState(parsed.minute);
  const [days, setDays] = useState<number[]>(parsed.days);
  const updateCron = useCallback(
    (
      newMode: ScheduleMode,
      newHour: string,
      newMinute: string,
      newDays: number[],
    ) => {
      onCronExpressionChange(
        buildCronFromSchedule(newMode, newHour, newMinute, newDays),
      );
    },
    [onCronExpressionChange],
  );

  const handleModeChange = (newMode: ScheduleMode) => {
    setMode(newMode);
    updateCron(newMode, hour, minute, days);
  };

  const handleHourChange = (newHour: string) => {
    setHour(newHour);
    updateCron(mode, newHour, minute, days);
  };

  const handleDayToggle = (day: number) => {
    const newDays = days.includes(day)
      ? days.filter((d) => d !== day)
      : [...days, day];
    if (newDays.length === 0) return;
    setDays(newDays);
    updateCron(mode, hour, minute, newDays);
  };

  return (
    <div className="space-y-3">
      <Label>Schedule</Label>

      <div className="flex gap-1 rounded-md border p-1">
        {(["hourly", "daily"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => handleModeChange(m)}
            className={cn(
              "flex-1 rounded-sm px-2 py-1.5 text-xs font-medium capitalize transition-colors",
              mode === m
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {m}
          </button>
        ))}
      </div>

      {mode === "daily" && (
        <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-2">
          <Label className="self-end">Repeat on</Label>
          <Label className="self-end">Time</Label>
          <div className="flex gap-1">
            {WEEKDAYS.map((d) => (
              <button
                key={d.value}
                type="button"
                onClick={() => handleDayToggle(d.value)}
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-md border text-xs font-medium transition-colors",
                  days.includes(d.value)
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input text-muted-foreground hover:bg-muted",
                )}
              >
                {d.label}
              </button>
            ))}
          </div>
          <Select value={hour} onValueChange={handleHourChange}>
            <SelectTrigger className="w-[90px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HOURS.map((h) => (
                <SelectItem key={h.value} value={h.value}>
                  {h.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}

function ScheduleTriggerFormDialog({
  open,
  onOpenChange,
  formState,
  agentOptions,
  agentsLoading,
  hasAgents,
  isSaving,
  isFormValid,
  isEditing,
  onSubmit,
  onNameChange,
  onAgentChange,
  onCronExpressionChange,
  onMessageTemplateChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  formState: ScheduleTriggerFormState;
  agentOptions: AgentOption[];
  agentsLoading: boolean;
  hasAgents: boolean;
  isSaving: boolean;
  isFormValid: boolean;
  isEditing: boolean;
  onSubmit: () => void;
  onNameChange: (value: string) => void;
  onAgentChange: (value: string) => void;
  onCronExpressionChange: (value: string) => void;
  onMessageTemplateChange: (value: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit task" : "New task"}</DialogTitle>
        </DialogHeader>

        <DialogForm
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={onSubmit}
        >
          <DialogBody className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="dialog-name">Name</Label>
              <Input
                id="dialog-name"
                value={formState.name}
                onChange={(event) => onNameChange(event.target.value)}
                placeholder="e.g. Daily summary"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="dialog-agent">Agent</Label>
              <SearchableSelect
                value={formState.agentId}
                onValueChange={onAgentChange}
                items={agentOptions}
                placeholder="Select agent"
                searchPlaceholder="Search agents..."
                disabled={agentsLoading || !hasAgents}
                className="w-full"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="dialog-prompt">Task Prompt</Label>
              <Textarea
                id="dialog-prompt"
                value={formState.messageTemplate}
                onChange={(event) =>
                  onMessageTemplateChange(event.target.value)
                }
                placeholder="Ask the agent to do something on every run."
                className="min-h-[80px] resize-y"
              />
            </div>

            <ScheduleSection
              cronExpression={formState.cronExpression}
              onCronExpressionChange={onCronExpressionChange}
            />
          </DialogBody>

          <DialogStickyFooter className="mt-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <PermissionButton
              permissions={{
                scheduledTask: [isEditing ? "update" : "create"],
              }}
              type="submit"
              disabled={isSaving || !isFormValid}
            >
              {isSaving && (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              )}
              {isEditing ? "Save changes" : "Create"}
            </PermissionButton>
          </DialogStickyFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}

function ScheduleTriggerRunsTable({
  trigger,
  trackedRunId,
  activeMutationTriggerId,
  onTrackedRunSettled,
}: {
  trigger: ScheduleTrigger;
  trackedRunId: string | null;
  activeMutationTriggerId: string | null;
  onTrackedRunSettled: (runId: string) => void;
}) {
  const router = useRouter();
  const ensureConversationMutation = useCreateScheduleTriggerRunConversation();
  const pageSize = 10;
  const [pageIndex, setPageIndex] = useState(0);
  const { data: runsResponse, isLoading: runsLoading } = useScheduleTriggerRuns(
    trigger.id,
    {
      limit: pageSize,
      offset: pageIndex * pageSize,
      enabled: true,
      refetchInterval: trackedRunId ? 3_000 : false,
    },
  );

  const trackedRun =
    trackedRunId === null
      ? null
      : (runsResponse?.data.find((run) => run.id === trackedRunId) ?? null);
  const runNowState = getRunNowTrackingState({
    activeMutationTriggerId,
    currentTriggerId: trigger.id,
    trackedRunId,
    trackedRunStatus: trackedRun?.status,
  });

  useEffect(() => {
    if (!runNowState.shouldClearTrackedRun || !trackedRunId) {
      return;
    }

    onTrackedRunSettled(trackedRunId);
  }, [onTrackedRunSettled, runNowState.shouldClearTrackedRun, trackedRunId]);

  const navigateToRunChat = useCallback(
    async (run: ScheduleTriggerRun) => {
      if (run.status !== "success" && run.status !== "failed") {
        return;
      }

      if (run.chatConversationId) {
        router.push(`/chat/${run.chatConversationId}`);
        return;
      }

      try {
        const conversation = await ensureConversationMutation.mutateAsync({
          triggerId: trigger.id,
          runId: run.id,
        });
        router.push(`/chat/${conversation.id}`);
      } catch {
        // Error toast handled by the mutation in schedule-trigger.query.ts
      }
    },
    [ensureConversationMutation, router, trigger.id],
  );

  const columns = useMemo<ColumnDef<ScheduleTriggerRun>[]>(
    () => [
      {
        id: "when",
        header: "",
        cell: ({ row }) => (
          <span className="text-sm text-foreground">
            {formatRunTimestamp(row.original.createdAt)}
          </span>
        ),
      },
      {
        id: "result",
        header: "",
        cell: ({ row }) => (
          <div className="flex items-center justify-end pr-2">
            <RunStatusIcon status={row.original.status} />
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <section className="[&_table]:bg-card">
      <DataTable
        columns={columns}
        data={runsResponse?.data ?? []}
        isLoading={runsLoading}
        emptyMessage="No runs recorded yet."
        manualPagination
        pagination={{
          pageIndex,
          pageSize,
          total: runsResponse?.pagination.total ?? 0,
        }}
        onPaginationChange={(p) => setPageIndex(p.pageIndex)}
        onRowClick={(run) => {
          void navigateToRunChat(run);
        }}
        getRowClassName={(run) =>
          run.status !== "success" && run.status !== "failed"
            ? "!cursor-default hover:!bg-transparent"
            : ""
        }
        hideHeader
        hideSelectedCount
        compactPagination
      />
    </section>
  );
}
