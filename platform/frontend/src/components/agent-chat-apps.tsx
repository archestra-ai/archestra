"use client";

import {
  type archestraApiTypes,
  MESSAGING_CHANNEL_LABELS,
} from "@archestra/shared";
import {
  ArrowRight,
  ExternalLink,
  Info,
  LockKeyhole,
  MessagesSquare,
  Search,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ChannelDetailsDialog } from "@/app/settings/messaging-channels/_components/channel-details-dialog";
import { EmailChannelDetailsDialog } from "@/app/settings/messaging-channels/_components/email-channel-details-dialog";
import { AgentEmailSettingsDialog } from "@/app/settings/messaging-channels/email/agent-email-settings-dialog";
import { AgentIcon } from "@/components/agent-icon";
import { ChannelIcon } from "@/components/channel-icon";
import { CopyButton } from "@/components/copy-button";
import { FormDialog } from "@/components/form-dialog";
import { QueryLoadError } from "@/components/query-load-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PermissionButton } from "@/components/ui/permission-button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { useProfiles } from "@/lib/agent.query";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import {
  useAllChatOpsBindings,
  useApplyChatOpsBindingPlan,
  useChatOpsStatus,
  useUpdateChatOpsBinding,
} from "@/lib/chatops/chatops.query";
import { useAgentEmailAddress } from "@/lib/chatops/incoming-email.query";
import { useConfig } from "@/lib/config/config.query";
import { useMessagingChannelCatalog } from "@/lib/integration-overrides";
import { cn } from "@/lib/utils";

type Agent = archestraApiTypes.GetAgentResponses["200"];
type Binding =
  archestraApiTypes.ListChatOpsBindingsResponses["200"]["data"][number];
type ChatProvider = "ms-teams" | "slack" | "telegram";
type SetupProvider = ChatProvider | "email";
type AgentReferenceData = {
  id: string;
  name: string;
  icon?: string | null;
  href?: string;
};

/** Edit-wizard channel assignment and per-channel configuration. */
export function AgentChatAppsEditor({
  agent,
  readOnly = false,
  onDirtyChange,
  standaloneSave = true,
  onSaveHandlerChange,
}: {
  agent: Agent;
  readOnly?: boolean;
  onDirtyChange?: (isDirty: boolean) => void;
  standaloneSave?: boolean;
  onSaveHandlerChange?: (handler: (() => Promise<boolean>) | null) => void;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [optionOrder, setOptionOrder] = useState<string[]>([]);
  const [optionOrderKey, setOptionOrderKey] = useState<string | null>(null);
  const [initializedAgentId, setInitializedAgentId] = useState<string | null>(
    null,
  );
  const [pendingPlan, setPendingPlan] = useState<AssignmentPlan | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const [assignmentRefreshFailed, setAssignmentRefreshFailed] = useState(false);
  const [emailSettingsOpen, setEmailSettingsOpen] = useState(false);
  const [detailsBindingId, setDetailsBindingId] = useState<string | null>(null);
  const [pendingChannelDetails, setPendingChannelDetails] = useState<
    Record<
      string,
      { channelInstructions: string | null; answerAllMessages: boolean }
    >
  >({});
  const saveResultRef = useRef<((saved: boolean) => void) | null>(null);
  const requestSaveRef = useRef<() => Promise<boolean>>(() =>
    Promise.resolve(true),
  );
  const { data: session } = useSession();
  const { data: canCreateDm = false } = useHasPermissions({
    agentTrigger: ["create"],
  });
  const {
    data,
    isPending,
    isLoadingError,
    refetch,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    fetchNextPage,
  } = useAllChatOpsBindings();
  const {
    data: providers,
    isPending: providersPending,
    isLoadingError: providersLoadingError,
    refetch: refetchProviders,
  } = useChatOpsStatus();
  const {
    data: config,
    isPending: configPending,
    isLoadingError: configLoadingError,
    refetch: refetchConfig,
  } = useConfig();
  const telegramEnabled = config?.features.chatopsTelegramEnabled === true;
  const messagingChannelCatalog = useMessagingChannelCatalog();
  const emailProviderEnabled = config?.features.incomingEmail?.enabled === true;
  const emailChannelVisible =
    emailProviderEnabled && !messagingChannelCatalog.isHidden("email");
  const { data: emailAddressData } = useAgentEmailAddress(
    emailChannelVisible && agent.incomingEmailEnabled ? agent.id : null,
  );
  const emailAddress = emailAddressData?.emailAddress ?? null;
  const applyBindingPlanMutation = useApplyChatOpsBindingPlan();

  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isFetchNextPageError) {
      void fetchNextPage();
    }
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError]);

  const providerAvailabilityPending = configPending;
  const visibleProviders = CHAT_PROVIDERS.filter(
    (provider) =>
      !messagingChannelCatalog.isHidden(provider) &&
      (provider !== "telegram" || telegramEnabled),
  );
  const visibleProviderIds = new Set(visibleProviders);
  const bindings = (data?.bindings ?? []).filter((binding) =>
    visibleProviderIds.has(binding.provider),
  );
  const assignedBindings = bindings.filter(
    (binding) => binding.agentId === agent.id,
  );
  const foreignAgentIds = [
    ...new Set(
      bindings.flatMap((binding) =>
        binding.agentId && binding.agentId !== agent.id
          ? [binding.agentId]
          : [],
      ),
    ),
  ];
  const {
    data: agents = [],
    isPending: agentNamesPending,
    isLoadingError: agentNamesLoadingError,
    refetch: refetchAgentNames,
  } = useProfiles({
    filters: { agentType: "agent", includeTools: false },
    enabled: foreignAgentIds.length > 0,
  });
  const agentNames = new Map(agents.map((item) => [item.id, item.name]));
  const agentReferences = new Map(
    agents.map((item) => [
      item.id,
      {
        id: item.id,
        name: item.name,
        icon: item.icon,
        href: `/agents/${item.id}`,
      },
    ]),
  );
  const detailsBinding =
    bindings.find((binding) => binding.id === detailsBindingId) ?? null;
  const detailsDialogBinding = detailsBinding
    ? { ...detailsBinding, ...pendingChannelDetails[detailsBinding.id] }
    : null;
  const detailsAssignedAgent = detailsBinding?.agentId
    ? detailsBinding.agentId === agent.id
      ? {
          id: agent.id,
          name: agent.name,
          icon: agent.icon,
          href: `/agents/${agent.id}`,
        }
      : (agentReferences.get(detailsBinding.agentId) ?? null)
    : null;
  const existingDmProviders = new Set(
    bindings
      .filter((binding) => binding.isDm)
      .map((binding) => binding.provider),
  );
  const configuredDmProviders = visibleProviders.filter(
    (provider) =>
      provider !== "telegram" &&
      providers?.some(
        (status) => status.id === provider && status.configured,
      ) &&
      !existingDmProviders.has(provider),
  );
  const currentIds = useMemo(
    () => assignedBindings.map((binding) => binding.id).sort(),
    [assignedBindings],
  );
  const assignmentOptions = buildAssignmentOptions({
    agent,
    agentNames,
    bindings,
    configuredDmProviders,
    currentUserId: session?.user?.id,
    canCreateDm,
  });
  const persistedSelectionKey = `${agent.id}:${currentIds.join(",")}`;
  const orderedOptions = orderAssignmentOptions(
    assignmentOptions,
    optionOrder,
    currentIds,
  );
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
  const showEmailRow =
    emailChannelVisible &&
    (!normalizedQuery ||
      ["email", emailAddress, agent.incomingEmailSecurityMode].some((value) =>
        value?.toLocaleLowerCase().includes(normalizedQuery),
      ));
  const filteredOptions = orderedOptions.filter(
    (option) =>
      !normalizedQuery ||
      [
        MESSAGING_CHANNEL_LABELS[option.provider],
        option.name,
        option.workspaceName,
        option.assignedAgentName,
      ].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery)),
  );

  const normalizedSelectedIds = [...selectedIds].sort();
  const selectedChannelCount =
    selectedIds.length +
    Number(emailChannelVisible && agent.incomingEmailEnabled);
  const selectedChannelCountLabel = `${selectedChannelCount} channel${
    selectedChannelCount === 1 ? "" : "s"
  } selected`;
  const isDirty =
    initializedAgentId === agent.id &&
    (normalizedSelectedIds.length !== currentIds.length ||
      normalizedSelectedIds.some((id, index) => id !== currentIds[index]) ||
      Object.keys(pendingChannelDetails).length > 0);
  const isSaving = applyBindingPlanMutation.isPending || isConfirming;
  const allBindingsLoaded =
    !hasNextPage && !isFetchingNextPage && !isFetchNextPageError;
  const agentNamesReady =
    !assignmentRefreshFailed &&
    (foreignAgentIds.length === 0 ||
      (!agentNamesPending && !agentNamesLoadingError));
  const isLoadingAgentNames = foreignAgentIds.length > 0 && agentNamesPending;
  const didAgentNamesFail =
    foreignAgentIds.length > 0 && agentNamesLoadingError;

  useEffect(() => {
    if (
      initializedAgentId === agent.id ||
      isPending ||
      isLoadingError ||
      !allBindingsLoaded
    ) {
      return;
    }
    setSelectedIds(currentIds);
    setOptionOrder(sortAssignmentOptionIds(assignmentOptions, currentIds));
    setOptionOrderKey(persistedSelectionKey);
    setInitializedAgentId(agent.id);
  }, [
    agent.id,
    allBindingsLoaded,
    currentIds,
    initializedAgentId,
    isLoadingError,
    isPending,
    assignmentOptions,
    persistedSelectionKey,
  ]);

  useEffect(() => {
    if (
      initializedAgentId !== agent.id ||
      isDirty ||
      optionOrderKey === persistedSelectionKey
    ) {
      return;
    }
    setOptionOrder(sortAssignmentOptionIds(assignmentOptions, currentIds));
    setOptionOrderKey(persistedSelectionKey);
  }, [
    agent.id,
    assignmentOptions,
    currentIds,
    initializedAgentId,
    isDirty,
    optionOrderKey,
    persistedSelectionKey,
  ]);

  useEffect(() => {
    onDirtyChange?.(isDirty);
    return () => onDirtyChange?.(false);
  }, [isDirty, onDirtyChange]);

  async function refreshSelection() {
    const result = await refetch();
    if (result.isError || !result.data) {
      setAssignmentRefreshFailed(true);
      setPendingPlan(null);
      return;
    }
    setAssignmentRefreshFailed(false);
    setSelectedIds(
      result.data.bindings
        .filter(
          (binding) =>
            visibleProviderIds.has(binding.provider) &&
            binding.agentId === agent.id,
        )
        .map((binding) => binding.id)
        .sort(),
    );
    setPendingPlan(null);
  }

  function resolveSave(saved: boolean) {
    saveResultRef.current?.(saved);
    saveResultRef.current = null;
  }

  const applyAssignmentPlan = (plan: AssignmentPlan) => {
    const changedAssignments = new Map<string, AtomicAssignmentUpdate>();
    for (const expected of plan.expectedAssignments) {
      changedAssignments.set(expected.id, {
        bindingId: expected.id,
        expectedAgentId: expected.agentId,
        nextAgentId: agent.id,
      });
    }
    for (const expected of plan.expectedUnassignments) {
      changedAssignments.set(expected.id, {
        bindingId: expected.id,
        expectedAgentId: expected.agentId,
        nextAgentId: null,
      });
    }
    for (const [bindingId, details] of Object.entries(pendingChannelDetails)) {
      const binding = bindings.find((item) => item.id === bindingId);
      if (!binding) continue;
      const changedAssignment = changedAssignments.get(bindingId);
      if (!changedAssignment && binding.agentId !== agent.id) continue;
      const update = changedAssignment ?? {
        bindingId,
        expectedAgentId: binding.agentId,
        nextAgentId: binding.agentId,
      };
      changedAssignments.set(bindingId, {
        ...update,
        channelInstructions: details.channelInstructions,
        ...(!binding.isDm &&
          binding.provider !== "telegram" && {
            answerAllMessages: details.answerAllMessages,
          }),
      });
    }

    applyBindingPlanMutation.mutate(
      {
        targetAgentId: agent.id,
        updates: [...changedAssignments.values()],
        directMessages: plan.dmProviders.map((provider) => ({ provider })),
      },
      {
        onSuccess: (result) => {
          const createdDmByProvider = new Map(
            result
              .filter((binding) => binding.isDm)
              .map((binding) => [binding.provider, binding.id]),
          );
          setSelectedIds((current) =>
            current.map((id) => {
              if (!id.startsWith(VIRTUAL_DM_PREFIX)) return id;
              const provider = id.slice(
                VIRTUAL_DM_PREFIX.length,
              ) as ChatProvider;
              return createdDmByProvider.get(provider) ?? id;
            }),
          );
          setPendingChannelDetails({});
          setPendingPlan(null);
          resolveSave(true);
        },
        onError: () => {
          setPendingPlan(null);
          resolveSave(false);
        },
      },
    );
  };

  const requestSave = () =>
    new Promise<boolean>((resolve) => {
      saveResultRef.current?.(false);
      saveResultRef.current = resolve;
      const plan = buildAssignmentPlan({
        agentId: agent.id,
        agentNames,
        assignedBindings,
        bindings,
        selectedIds,
      });
      if (plan.reassignments.length > 0) {
        setPendingPlan(plan);
        return;
      }
      applyAssignmentPlan(plan);
    });

  const cancelReassignment = () => {
    setPendingPlan(null);
    resolveSave(false);
  };

  const setOptionChecked = (optionId: string, checked: boolean) => {
    if (!checked) {
      setPendingChannelDetails((current) => {
        if (!(optionId in current)) return current;
        const next = { ...current };
        delete next[optionId];
        return next;
      });
    }
    setSelectedIds((current) =>
      checked
        ? current.includes(optionId)
          ? current
          : [...current, optionId]
        : current.filter((id) => id !== optionId),
    );
  };

  const confirmReassignment = async () => {
    if (!pendingPlan) return;
    setIsConfirming(true);
    try {
      const result = await refetch();
      if (result.isError || !result.data) {
        toast.error(
          "The channel assignments could not be checked. Save again after the channel list loads.",
        );
        setPendingPlan(null);
        resolveSave(false);
        return;
      }
      const latestBindings = result.data.bindings.filter((binding) =>
        visibleProviderIds.has(binding.provider),
      );
      const assignmentChanged = pendingPlan.reassignments.some(
        (reassignment) =>
          latestBindings.find(
            (binding) => binding.id === reassignment.bindingId,
          )?.agentId !== reassignment.expectedAgentId,
      );
      if (assignmentChanged) {
        toast.error(
          "A channel assignment changed. Review the channel list. Then save again.",
        );
        setPendingPlan(null);
        await refreshSelection();
        resolveSave(false);
        return;
      }
      applyAssignmentPlan(pendingPlan);
    } finally {
      setIsConfirming(false);
    }
  };

  useEffect(() => {
    requestSaveRef.current = requestSave;
  });
  useEffect(() => {
    if (!onSaveHandlerChange) return;
    const handler = () => requestSaveRef.current();
    onSaveHandlerChange(handler);
    return () => {
      onSaveHandlerChange(null);
      saveResultRef.current?.(false);
      saveResultRef.current = null;
    };
  }, [onSaveHandlerChange]);

  if (configLoadingError) {
    return (
      <QueryLoadError
        title="Cannot load chat app availability"
        onRetry={() => refetchConfig()}
      />
    );
  }

  if (
    !providerAvailabilityPending &&
    visibleProviders.length === 0 &&
    !emailChannelVisible
  ) {
    return null;
  }

  return (
    <section aria-labelledby="chat-apps-heading" className="space-y-4">
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <MessagesSquare className="size-4 text-muted-foreground" />
          <h3 id="chat-apps-heading" className="text-base font-semibold">
            Messaging channels
          </h3>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Set instructions and reply behavior for each assigned channel.
        </p>
      </div>

      <ProviderSetupLinks
        visibleProviders={
          emailChannelVisible
            ? [...visibleProviders, "email"]
            : visibleProviders
        }
        loadingProviders={[
          ...CHAT_PROVIDERS.filter(
            (provider) => !messagingChannelCatalog.isHidden(provider),
          ),
          ...(emailChannelVisible ? (["email"] as const) : []),
        ]}
        providerStatuses={providers}
        emailConfigured={config?.features.incomingEmail?.enabled === true}
        isPending={providersPending || providerAvailabilityPending}
        isLoadingError={providersLoadingError}
        onRetry={refetchProviders}
      />

      <div className="overflow-hidden rounded-md border">
        {assignmentRefreshFailed ? (
          <QueryLoadError
            title="Cannot refresh channel assignments"
            onRetry={() => void refreshSelection()}
            className="min-h-32"
          />
        ) : isPending || !allBindingsLoaded ? (
          <div className="space-y-3 p-4">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : isLoadingError || isFetchNextPageError ? (
          <QueryLoadError
            title="Cannot load channel assignments"
            onRetry={() => refetch()}
            className="min-h-32"
          />
        ) : isLoadingAgentNames ? (
          <div className="space-y-3 p-4">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : didAgentNamesFail ? (
          <QueryLoadError
            title="Cannot load the agents assigned to these channels"
            onRetry={() => refetchAgentNames()}
            className="min-h-32"
          />
        ) : (
          <>
            <div className="space-y-2 border-b p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">Channel assignments</span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {selectedChannelCountLabel}
                </span>
              </div>
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="agent-channel-search"
                  aria-label="Search channels"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.preventDefault();
                  }}
                  placeholder="Search channels, workspaces, or agents"
                  className="pl-9"
                  disabled={readOnly || isSaving}
                />
              </div>
            </div>
            <ScrollArea className="h-[30vh] min-h-32 max-h-64 sm:h-[45vh] sm:max-h-96">
              {filteredOptions.length > 0 || showEmailRow ? (
                <div className="w-0 min-w-full divide-y">
                  {showEmailRow && (
                    <AgentEmailChannelRow
                      agent={agent}
                      emailAddress={emailAddress}
                      readOnly={readOnly}
                      onEdit={() => setEmailSettingsOpen(true)}
                    />
                  )}
                  {filteredOptions.map((option) => {
                    const checked = selectedIds.includes(option.id);
                    const canEditChannel = !readOnly && checked;
                    const assignedAgent = option.assignedAgentId
                      ? option.assignedAgentId === agent.id
                        ? {
                            id: agent.id,
                            name: agent.name,
                            icon: agent.icon,
                            href: `/agents/${agent.id}`,
                          }
                        : (agentReferences.get(option.assignedAgentId) ?? {
                            id: option.assignedAgentId,
                            name: option.assignedAgentName ?? "another agent",
                            icon: null,
                          })
                      : undefined;
                    return (
                      <div key={option.id}>
                        <div
                          data-channel-assignment-row
                          className={cn(
                            "relative w-full min-w-0 overflow-hidden px-4 py-3",
                            option.disabledReason || readOnly
                              ? cn(
                                  "bg-muted/20 opacity-65",
                                  !option.virtualDm && "cursor-pointer",
                                )
                              : checked
                                ? "cursor-pointer bg-primary/[0.04] hover:bg-primary/[0.07]"
                                : "cursor-pointer hover:bg-muted/40",
                          )}
                        >
                          {!option.virtualDm && (
                            <button
                              type="button"
                              className="absolute inset-0 cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                              aria-label={`${canEditChannel ? "Edit channel" : "View details"} for ${assignmentOptionLabel(option)}`}
                              onClick={() => setDetailsBindingId(option.id)}
                            />
                          )}
                          <div className="pointer-events-none relative grid grid-cols-[1rem_1rem_minmax(0,1fr)] items-start gap-x-3 sm:grid-cols-[1rem_1rem_minmax(0,1fr)_8rem]">
                            <Checkbox
                              id={`chat-channel-${option.id}`}
                              aria-label={assignmentOptionLabel(option)}
                              aria-describedby={`chat-channel-details-${option.id}`}
                              checked={checked}
                              disabled={
                                readOnly || !!option.disabledReason || isSaving
                              }
                              onCheckedChange={(value) =>
                                setOptionChecked(option.id, value === true)
                              }
                              className="pointer-events-auto relative z-10 mt-0.5"
                            />
                            <ChannelIcon
                              channel={option.provider}
                              className="mt-0.5 size-4 shrink-0"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                <span className="truncate text-sm font-medium text-foreground">
                                  {option.name}
                                </span>
                                {pendingChannelDetails[option.id] && (
                                  <Badge
                                    variant="outline"
                                    className="px-1.5 py-0 text-[10px] font-normal"
                                  >
                                    Changes pending
                                  </Badge>
                                )}
                              </span>
                              <span
                                id={`chat-channel-details-${option.id}`}
                                className="mt-0.5 block text-xs text-muted-foreground"
                              >
                                {option.disabledReason ? (
                                  <span className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
                                    <LockKeyhole className="mt-0.5 size-3 shrink-0" />
                                    <span>{option.disabledReason}</span>
                                  </span>
                                ) : (
                                  <AssignmentStatus
                                    option={option}
                                    checked={checked}
                                    targetAgent={{
                                      id: agent.id,
                                      name: agent.name,
                                      icon: agent.icon,
                                      href: `/agents/${agent.id}`,
                                    }}
                                    assignedAgent={assignedAgent}
                                  />
                                )}
                              </span>
                            </span>
                            {!option.virtualDm ? (
                              <span
                                aria-hidden="true"
                                className="pointer-events-none relative z-10 col-start-3 mt-2 inline-flex h-8 w-32 items-center justify-center justify-self-start rounded-md border bg-background px-3 text-xs font-medium sm:col-start-4 sm:row-start-1 sm:mt-0 sm:justify-self-stretch"
                              >
                                {canEditChannel
                                  ? "Edit channel"
                                  : "View details"}
                              </span>
                            ) : (
                              <span
                                aria-hidden="true"
                                className="col-start-3 h-8 w-32 sm:col-start-4 sm:row-start-1"
                              />
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
                  <span>No channels match your search.</span>
                </div>
              )}
            </ScrollArea>
            {standaloneSave && (
              <div className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-muted-foreground">
                  {isDirty
                    ? "Save the channel changes before you continue."
                    : "Add the chat app to a group. Then send a message to show the group channel here."}
                </p>
                <PermissionButton
                  type="button"
                  permissions={{ agentTrigger: ["update"] }}
                  onClick={() => void requestSave()}
                  disabled={
                    readOnly || !isDirty || isSaving || !agentNamesReady
                  }
                >
                  <span>{isSaving ? "Saving..." : "Save channel changes"}</span>
                </PermissionButton>
              </div>
            )}
          </>
        )}
      </div>

      <ReassignmentConfirmDialog
        open={!!pendingPlan}
        onOpenChange={(open) => {
          if (!open && !isSaving) {
            cancelReassignment();
          }
        }}
        plan={pendingPlan}
        targetAgent={{
          id: agent.id,
          name: agent.name,
          icon: agent.icon,
          href: `/agents/${agent.id}`,
        }}
        agentReferences={agentReferences}
        isPending={isSaving}
        onConfirm={() => void confirmReassignment()}
      />

      <ChannelDetailsDialog
        binding={detailsDialogBinding}
        assignedAgent={detailsAssignedAgent}
        open={!!detailsBinding}
        readOnly={
          readOnly ||
          !detailsBinding ||
          !selectedIds.includes(detailsBinding.id)
        }
        isSaving={false}
        saveLabel="Done"
        onOpenChange={(open) => {
          if (!open) {
            setDetailsBindingId(null);
          }
        }}
        onSave={({ channelInstructions, answerAllMessages }) => {
          if (!detailsBinding) return;
          setPendingChannelDetails((current) => ({
            ...current,
            [detailsBinding.id]: {
              channelInstructions,
              answerAllMessages,
            },
          }));
          setDetailsBindingId(null);
        }}
      />
      <AgentEmailSettingsDialog
        agent={agent}
        open={emailSettingsOpen}
        onOpenChange={setEmailSettingsOpen}
        providerEnabled={emailProviderEnabled}
      />
    </section>
  );
}

function AgentEmailChannelRow({
  agent,
  emailAddress,
  readOnly,
  onEdit,
}: {
  agent: Agent;
  emailAddress: string | null;
  readOnly: boolean;
  onEdit: () => void;
}) {
  const enabled = agent.incomingEmailEnabled;
  return (
    <div
      data-email-channel-row
      data-channel-assignment-row
      className={cn(
        "relative w-full min-w-0 overflow-hidden px-4 py-3",
        readOnly
          ? "bg-muted/20 opacity-65"
          : enabled
            ? "cursor-pointer bg-primary/[0.04] hover:bg-primary/[0.07]"
            : "cursor-pointer hover:bg-muted/40",
      )}
    >
      <button
        type="button"
        className="absolute inset-0 cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default"
        aria-label={`${enabled ? "Edit email" : "Enable email"} for Email channel ${emailAddress || "Email"}`}
        disabled={readOnly}
        onClick={onEdit}
      />
      <div className="pointer-events-none relative grid grid-cols-[1rem_1rem_minmax(0,1fr)] items-start gap-x-3 sm:grid-cols-[1rem_1rem_minmax(0,1fr)_8rem]">
        <Checkbox
          id="agent-email-channel"
          aria-label="Email channel"
          aria-describedby="agent-email-channel-details"
          checked={enabled}
          disabled={readOnly}
          onCheckedChange={onEdit}
          className="pointer-events-auto relative z-10 mt-0.5"
        />
        <ChannelIcon channel="email" className="mt-0.5 size-4 shrink-0" />
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className="min-w-0 max-w-full truncate text-sm font-medium text-foreground"
              title={emailAddress || "Email"}
            >
              {emailAddress || "Email"}
            </span>
            {emailAddress && (
              <span className="pointer-events-auto relative z-10 -my-1">
                <CopyButton text={emailAddress} />
              </span>
            )}
          </span>
          <span
            id="agent-email-channel-details"
            className="mt-0.5 block text-xs text-muted-foreground"
          >
            {enabled
              ? `Email is enabled with ${agent.incomingEmailSecurityMode} access.`
              : "Email is not enabled for this agent."}
          </span>
        </span>
        <span
          aria-hidden="true"
          className="pointer-events-none relative z-10 col-start-3 mt-2 inline-flex h-8 w-32 items-center justify-center justify-self-start rounded-md border bg-background px-3 text-xs font-medium sm:col-start-4 sm:row-start-1 sm:mt-0 sm:justify-self-stretch"
        >
          {enabled ? "Edit email" : "Enable email"}
        </span>
      </div>
    </div>
  );
}

/** Read-only chat-app status and assigned-channel summary for agent detail. */
export function AgentChatApps({ agent }: { agent: Agent }) {
  const [detailsBindingId, setDetailsBindingId] = useState<string | null>(null);
  const [emailDetailsOpen, setEmailDetailsOpen] = useState(false);
  const { data: canUpdateChannels = false } = useHasPermissions({
    agentTrigger: ["update"],
  });
  const { data: canUpdateAgent = false } = useHasPermissions({
    agent: ["update"],
  });
  const updateBinding = useUpdateChatOpsBinding();
  const {
    data,
    isPending,
    isLoadingError,
    refetch,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    fetchNextPage,
  } = useAllChatOpsBindings();
  const {
    data: providers,
    isPending: providersPending,
    isLoadingError: providersLoadingError,
    refetch: refetchProviders,
  } = useChatOpsStatus();
  const {
    data: config,
    isPending: configPending,
    isLoadingError: configLoadingError,
    refetch: refetchConfig,
  } = useConfig();
  const messagingChannelCatalog = useMessagingChannelCatalog();
  const emailProviderEnabled = config?.features.incomingEmail?.enabled === true;
  const emailChannelVisible =
    emailProviderEnabled && !messagingChannelCatalog.isHidden("email");
  const { data: emailAddressData } = useAgentEmailAddress(
    emailChannelVisible && agent.incomingEmailEnabled ? agent.id : null,
  );
  const emailAddress = emailAddressData?.emailAddress ?? null;

  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isFetchNextPageError) {
      void fetchNextPage();
    }
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError]);

  if (configLoadingError) {
    return (
      <QueryLoadError
        title="Cannot load chat app availability"
        onRetry={() => refetchConfig()}
      />
    );
  }

  const telegramEnabled = config?.features.chatopsTelegramEnabled === true;
  const visibleProviders = CHAT_PROVIDERS.filter(
    (provider) =>
      !messagingChannelCatalog.isHidden(provider) &&
      (provider !== "telegram" || telegramEnabled),
  );
  if (!configPending && visibleProviders.length === 0 && !emailChannelVisible) {
    return null;
  }

  const visibleProviderIds = new Set(visibleProviders);
  const assignedBindings = (data?.bindings ?? []).filter(
    (binding) =>
      visibleProviderIds.has(binding.provider) && binding.agentId === agent.id,
  );
  const detailsBinding =
    assignedBindings.find((binding) => binding.id === detailsBindingId) ?? null;
  return (
    <section aria-labelledby="chat-apps-heading" className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <MessagesSquare className="size-4 text-muted-foreground" />
            <h4 id="chat-apps-heading" className="text-sm font-medium">
              Messaging channels
            </h4>
          </div>
        </div>
      </div>

      <ProviderSetupLinks
        visibleProviders={
          emailChannelVisible
            ? [...visibleProviders, "email"]
            : visibleProviders
        }
        loadingProviders={[
          ...CHAT_PROVIDERS.filter(
            (provider) => !messagingChannelCatalog.isHidden(provider),
          ),
          ...(emailChannelVisible ? (["email"] as const) : []),
        ]}
        providerStatuses={providers}
        emailConfigured={config?.features.incomingEmail?.enabled === true}
        isPending={providersPending || configPending}
        isLoadingError={providersLoadingError}
        onRetry={refetchProviders}
      />

      {isPending ? (
        <div className="flex gap-2">
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-7 w-36" />
        </div>
      ) : isLoadingError || isFetchNextPageError ? (
        <QueryLoadError
          title="Cannot load all assigned channels"
          onRetry={() => refetch()}
        />
      ) : assignedBindings.length > 0 ||
        (emailChannelVisible && agent.incomingEmailEnabled) ? (
        <AssignedChannelCollection
          bindings={assignedBindings}
          emailAddress={emailAddress}
          emailEnabled={emailChannelVisible && agent.incomingEmailEnabled}
          onSelectBinding={setDetailsBindingId}
          onSelectEmail={() => setEmailDetailsOpen(true)}
          canEditChannels={canUpdateChannels}
          canEditEmail={canUpdateAgent}
        />
      ) : (
        <div className="rounded-md border border-dashed px-4 py-5 text-center">
          <p className="text-sm font-medium">No channels assigned</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Edit this agent&apos;s configuration to assign chat channels.
          </p>
        </div>
      )}
      <ChannelDetailsDialog
        binding={detailsBinding}
        assignedAgent={{ id: agent.id, name: agent.name, icon: agent.icon }}
        open={!!detailsBinding}
        readOnly={!canUpdateChannels}
        isSaving={updateBinding.isPending}
        onOpenChange={(open) => {
          if (!open) setDetailsBindingId(null);
        }}
        onSave={({ channelInstructions, answerAllMessages }) => {
          if (!detailsBinding) return;
          updateBinding.mutate(
            {
              id: detailsBinding.id,
              channelInstructions,
              ...(!detailsBinding.isDm &&
                detailsBinding.provider !== "telegram" && {
                  answerAllMessages,
                }),
            },
            { onSuccess: () => setDetailsBindingId(null) },
          );
        }}
      />
      {canUpdateAgent ? (
        <AgentEmailSettingsDialog
          agent={agent}
          open={emailDetailsOpen}
          onOpenChange={setEmailDetailsOpen}
          providerEnabled={emailProviderEnabled}
        />
      ) : (
        <EmailChannelDetailsDialog
          agent={agent}
          emailAddress={emailAddress}
          open={emailDetailsOpen}
          onOpenChange={setEmailDetailsOpen}
        />
      )}
    </section>
  );
}

function AssignedChannelCollection({
  bindings,
  emailAddress,
  emailEnabled,
  onSelectBinding,
  onSelectEmail,
  canEditChannels,
  canEditEmail,
}: {
  bindings: Binding[];
  emailAddress: string | null;
  emailEnabled: boolean;
  onSelectBinding: (bindingId: string) => void;
  onSelectEmail: () => void;
  canEditChannels: boolean;
  canEditEmail: boolean;
}) {
  const totalChannels = bindings.length + Number(emailEnabled);

  return (
    <div className="overflow-hidden rounded-md border">
      <div className="flex items-center justify-between gap-2 border-b bg-muted/20 px-3 py-2.5">
        <p className="text-sm font-medium text-muted-foreground">
          Assigned channels
        </p>
        <Badge variant="secondary" className="tabular-nums">
          {totalChannels}
        </Badge>
      </div>
      <ScrollArea className={cn(totalChannels > 4 && "h-80 max-h-[50vh]")}>
        <div className="w-0 min-w-full divide-y">
          {emailEnabled && (
            <div className="relative grid w-full min-w-0 cursor-pointer grid-cols-[1rem_minmax(0,1fr)] items-center gap-x-3 px-3 py-3 hover:bg-muted/40 sm:grid-cols-[1rem_minmax(0,1fr)_8rem]">
              <button
                type="button"
                className="absolute inset-0 cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                aria-label={`${canEditEmail ? "Edit email" : "View details"} for Email channel ${emailAddress || "Email"}`}
                onClick={onSelectEmail}
              />
              <ChannelIcon channel="email" className="size-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className="truncate text-sm font-medium"
                    title={emailAddress || "Email"}
                  >
                    {emailAddress || "Email"}
                  </span>
                  {emailAddress && (
                    <span className="relative z-10 -my-1">
                      <CopyButton text={emailAddress} />
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Email invocation
                </p>
              </div>
              <span
                aria-hidden="true"
                className="pointer-events-none relative z-10 col-start-2 mt-2 inline-flex h-8 w-32 items-center justify-center justify-self-start rounded-md border bg-background px-3 text-xs font-medium sm:col-start-3 sm:row-start-1 sm:mt-0 sm:justify-self-stretch"
              >
                {canEditEmail ? "Edit email" : "View details"}
              </span>
            </div>
          )}
          {bindings.map((binding) => {
            const provider = binding.provider as ChatProvider;
            const label = channelName(binding);
            const behavior = binding.isDm
              ? "Direct messages"
              : provider === "telegram" || binding.answerAllMessages
                ? "All messages"
                : "Mentions only";
            return (
              <div
                key={binding.id}
                className="relative grid w-full min-w-0 cursor-pointer grid-cols-[1rem_minmax(0,1fr)] items-center gap-x-3 overflow-hidden px-3 py-3 hover:bg-muted/40 sm:grid-cols-[1rem_minmax(0,1fr)_8rem]"
              >
                <button
                  type="button"
                  className="absolute inset-0 cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  aria-label={`${canEditChannels ? "Edit channel" : "View details"} for ${MESSAGING_CHANNEL_LABELS[provider]} channel ${label}`}
                  onClick={() => onSelectBinding(binding.id)}
                />
                <ChannelIcon channel={provider} className="size-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {label}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">{behavior}</p>
                </div>
                <span
                  aria-hidden="true"
                  className="pointer-events-none relative z-10 col-start-2 mt-2 inline-flex h-8 w-32 items-center justify-center justify-self-start rounded-md border bg-background px-3 text-xs font-medium sm:col-start-3 sm:row-start-1 sm:mt-0 sm:justify-self-stretch"
                >
                  {canEditChannels ? "Edit channel" : "View details"}
                </span>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}

type AssignmentOption = {
  id: string;
  provider: ChatProvider;
  name: string;
  workspaceName: string | null;
  assignedAgentId: string | null;
  assignedAgentName: string | null;
  disabledReason: string | null;
  virtualDm: boolean;
  isDm: boolean;
};

type AssignmentPlan = {
  expectedAssignments: ExpectedAgentAssignment[];
  expectedUnassignments: ExpectedAgentAssignment[];
  dmProviders: ChatProvider[];
  reassignments: Array<{
    bindingId: string;
    expectedAgentId: string;
    provider: ChatProvider;
    channelName: string;
    agentName: string;
  }>;
};

type ExpectedAgentAssignment = {
  id: string;
  agentId: string | null;
};
type AtomicAssignmentUpdate =
  archestraApiTypes.ApplyChatOpsBindingPlanData["body"]["updates"][number];

const CHAT_PROVIDERS = [
  "ms-teams",
  "slack",
  "telegram",
] as const satisfies readonly ChatProvider[];
const VIRTUAL_DM_PREFIX = "virtual-dm:";

function ProviderSetupLinks({
  visibleProviders,
  loadingProviders,
  providerStatuses,
  emailConfigured,
  isPending,
  isLoadingError,
  onRetry,
}: {
  visibleProviders: SetupProvider[];
  loadingProviders: readonly SetupProvider[];
  providerStatuses: Array<{ id: string; configured: boolean }> | undefined;
  emailConfigured: boolean;
  isPending: boolean;
  isLoadingError: boolean;
  onRetry: () => unknown;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {isPending ? (
        loadingProviders.map((provider) => (
          <Skeleton key={provider} className="h-9 w-32 rounded-md" />
        ))
      ) : isLoadingError ? (
        <QueryLoadError
          title="Cannot load chat app status"
          onRetry={onRetry}
          className="min-h-24 w-full"
        />
      ) : (
        visibleProviders.map((provider) => {
          const configured =
            provider === "email"
              ? emailConfigured
              : providerStatuses?.some(
                  (status) => status.id === provider && status.configured,
                );
          return (
            <Link
              key={provider}
              href={`/settings/messaging-channels/${provider}`}
              className="group inline-flex min-w-0 items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors hover:bg-muted/50"
            >
              <ChannelIcon channel={provider} className="size-4 shrink-0" />
              <span className="truncate font-medium">
                {MESSAGING_CHANNEL_LABELS[provider]}
              </span>
              <span
                className={cn(
                  "text-xs",
                  configured
                    ? "text-green-600 dark:text-green-400"
                    : "text-muted-foreground group-hover:text-foreground",
                )}
              >
                {configured ? "Connected" : "Set up"}
              </span>
              <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
            </Link>
          );
        })
      )}
    </div>
  );
}

function sortAssignmentOptionIds(
  options: AssignmentOption[],
  selectedIds: string[],
) {
  const selected = new Set(selectedIds);
  return [...options]
    .sort((left, right) => {
      const selectedOrder =
        Number(selected.has(right.id)) - Number(selected.has(left.id));
      if (selectedOrder !== 0) return selectedOrder;
      return (
        MESSAGING_CHANNEL_LABELS[left.provider].localeCompare(
          MESSAGING_CHANNEL_LABELS[right.provider],
        ) || left.name.localeCompare(right.name)
      );
    })
    .map((option) => option.id);
}

function orderAssignmentOptions(
  options: AssignmentOption[],
  optionOrder: string[],
  persistedSelectedIds: string[],
) {
  const optionsById = new Map(options.map((option) => [option.id, option]));
  const initialOrder =
    optionOrder.length > 0
      ? optionOrder
      : sortAssignmentOptionIds(options, persistedSelectedIds);
  const ordered = initialOrder.flatMap((id) => {
    const option = optionsById.get(id);
    if (!option) return [];
    optionsById.delete(id);
    return [option];
  });
  const remainingIds = sortAssignmentOptionIds(
    [...optionsById.values()],
    persistedSelectedIds,
  );
  return [
    ...ordered,
    ...remainingIds.flatMap((id) => {
      const option = optionsById.get(id);
      return option ? [option] : [];
    }),
  ];
}

function buildAssignmentOptions({
  agent,
  agentNames,
  bindings,
  configuredDmProviders,
  currentUserId,
  canCreateDm,
}: {
  agent: Agent;
  agentNames: Map<string, string>;
  bindings: Binding[];
  configuredDmProviders: ChatProvider[];
  currentUserId: string | undefined;
  canCreateDm: boolean;
}): AssignmentOption[] {
  const virtualDmOptions = configuredDmProviders.map((provider) => ({
    id: `${VIRTUAL_DM_PREFIX}${provider}`,
    provider,
    name: "Direct message",
    workspaceName: null,
    assignedAgentId: null,
    assignedAgentName: null,
    disabledReason: !canCreateDm
      ? "You do not have permission to create a direct message assignment."
      : agent.scope === "personal" && agent.authorId !== currentUserId
        ? "Only this personal agent's owner can assign a direct message."
        : null,
    virtualDm: true,
    isDm: true,
  }));
  const realOptions = bindings.map((binding) => {
    const personalAssignmentRefused =
      agent.scope === "personal" &&
      (!binding.isDm || agent.authorId !== currentUserId);
    return {
      id: binding.id,
      provider: binding.provider,
      name: channelName(binding),
      workspaceName: binding.workspaceName,
      assignedAgentId: binding.agentId,
      assignedAgentName:
        binding.agentId && binding.agentId !== agent.id
          ? (agentNames.get(binding.agentId) ?? "another agent")
          : null,
      disabledReason: personalAssignmentRefused
        ? "This personal agent can use only its owner's direct messages."
        : null,
      virtualDm: false,
      isDm: binding.isDm,
    };
  });
  return [...virtualDmOptions, ...realOptions];
}

function buildAssignmentPlan({
  agentId,
  agentNames,
  assignedBindings,
  bindings,
  selectedIds,
}: {
  agentId: string;
  agentNames: Map<string, string>;
  assignedBindings: Binding[];
  bindings: Binding[];
  selectedIds: string[];
}): AssignmentPlan {
  const selectedRealIds = selectedIds.filter(
    (id) => !id.startsWith(VIRTUAL_DM_PREFIX),
  );
  const toAssignBindings = bindings.filter(
    (binding) =>
      selectedRealIds.includes(binding.id) && binding.agentId !== agentId,
  );
  const toUnassignBindings = assignedBindings.filter(
    (binding) => !selectedRealIds.includes(binding.id),
  );
  return {
    expectedAssignments: toAssignBindings.map((binding) => ({
      id: binding.id,
      agentId: binding.agentId,
    })),
    expectedUnassignments: toUnassignBindings.map((binding) => ({
      id: binding.id,
      agentId: binding.agentId,
    })),
    dmProviders: selectedIds
      .filter((id) => id.startsWith(VIRTUAL_DM_PREFIX))
      .map((id) => id.slice(VIRTUAL_DM_PREFIX.length) as ChatProvider),
    reassignments: toAssignBindings.flatMap((binding) =>
      binding.agentId
        ? [
            {
              bindingId: binding.id,
              expectedAgentId: binding.agentId,
              provider: binding.provider as ChatProvider,
              channelName: channelName(binding),
              agentName: agentNames.get(binding.agentId) ?? "another agent",
            },
          ]
        : [],
    ),
  };
}

function ReassignmentConfirmDialog({
  open,
  onOpenChange,
  plan,
  targetAgent,
  agentReferences,
  isPending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plan: AssignmentPlan | null;
  targetAgent: AgentReferenceData;
  agentReferences: Map<string, AgentReferenceData>;
  isPending: boolean;
  onConfirm: () => void;
}) {
  const count = plan?.reassignments.length ?? 0;
  const singular = count === 1;
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        singular
          ? `Move channel to ${targetAgent.name}?`
          : `Move ${count} channels to ${targetAgent.name}?`
      }
      description="Each messaging channel can be assigned to only one agent at a time."
      size="medium"
      initialFocusRef={cancelButtonRef}
      headerClassName="px-12 sm:px-4"
    >
      <DialogForm
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (!isPending) onConfirm();
        }}
      >
        <DialogBody className="space-y-4">
          <div className="flex gap-3 rounded-md border bg-muted/40 p-3">
            <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 space-y-1 text-sm">
              <p>
                New messages will go to{" "}
                <span className="font-medium text-foreground">
                  {targetAgent.name}
                </span>
                .
              </p>
              <p className="text-muted-foreground">
                The current {singular ? "agent" : "agents"} will stop receiving
                messages from {singular ? "this channel" : "these channels"}.
              </p>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium">Assignment changes</p>
            <Badge variant="secondary">
              {count} {singular ? "channel" : "channels"}
            </Badge>
          </div>

          <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {plan?.reassignments.map((reassignment) => (
              <div
                key={reassignment.bindingId}
                className="rounded-md border bg-card p-3"
              >
                <PlainChannelIdentity
                  provider={reassignment.provider}
                  name={reassignment.channelName}
                />
                <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] grid-rows-[auto_minmax(1.25rem,auto)] items-center gap-x-3 gap-y-1">
                  <p className="text-xs text-muted-foreground">From</p>
                  <span aria-hidden="true" />
                  <p className="text-xs text-muted-foreground">To</p>
                  <div className="min-w-0 self-center">
                    <PlainAgentIdentity
                      agent={
                        agentReferences.get(reassignment.expectedAgentId) ?? {
                          id: reassignment.expectedAgentId,
                          name: reassignment.agentName,
                          icon: null,
                        }
                      }
                    />
                  </div>
                  <span className="flex size-7 items-center justify-center self-center rounded-full bg-muted text-muted-foreground">
                    <ArrowRight className="size-3.5" />
                  </span>
                  <div className="min-w-0 self-center">
                    <PlainAgentIdentity agent={targetAgent} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </DialogBody>
        <DialogStickyFooter>
          <Button
            ref={cancelButtonRef}
            type="button"
            variant="outline"
            disabled={isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={isPending}>
            <span>
              {isPending
                ? "Moving..."
                : singular
                  ? "Move channel"
                  : "Move channels"}
            </span>
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}

function assignmentOptionLabel(option: AssignmentOption) {
  const provider = MESSAGING_CHANNEL_LABELS[option.provider];
  return option.isDm
    ? `${provider} direct message`
    : `${provider} channel ${option.name}`;
}

function AssignmentStatus({
  option,
  checked,
  targetAgent,
  assignedAgent,
}: {
  option: AssignmentOption;
  checked: boolean;
  targetAgent: AgentReferenceData;
  assignedAgent: AgentReferenceData | undefined;
}) {
  if (option.virtualDm) {
    return checked ? (
      <span>
        Save creates a direct message for <AgentReference agent={targetAgent} />
        .
      </span>
    ) : (
      <span>No direct message assigned.</span>
    );
  }
  if (option.assignedAgentId === targetAgent.id) {
    return checked ? (
      <span>
        Assigned to <AgentReference agent={targetAgent} />.
      </span>
    ) : (
      <span>
        Save removes this channel from <AgentReference agent={targetAgent} />.
      </span>
    );
  }
  if (assignedAgent) {
    return checked ? (
      <span>
        Save moves this channel from <AgentReference agent={assignedAgent} /> to{" "}
        <AgentReference agent={targetAgent} />.
      </span>
    ) : (
      <span>
        Assigned to <AgentReference agent={assignedAgent} />.
      </span>
    );
  }
  return checked ? (
    <span>
      Save assigns this channel to <AgentReference agent={targetAgent} />.
    </span>
  ) : (
    <span>No agent assigned.</span>
  );
}

function AgentReference({
  agent,
  allowWrap = false,
}: {
  agent: AgentReferenceData;
  allowWrap?: boolean;
}) {
  const content = (
    <>
      <AgentIcon icon={agent.icon} size={13} />
      <span className={allowWrap ? "break-words" : "truncate"}>
        {agent.name}
      </span>
    </>
  );
  const className = cn(
    "pointer-events-auto relative z-10 inline-flex min-w-0 items-center gap-1 font-medium text-foreground",
    allowWrap && "items-start",
  );

  return agent.href ? (
    <Link
      href={agent.href}
      title={agent.name}
      className={cn(className, "hover:underline")}
    >
      {content}
    </Link>
  ) : (
    <span title={agent.name} className={className}>
      {content}
    </span>
  );
}

function PlainAgentIdentity({ agent }: { agent: AgentReferenceData }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 align-middle font-medium leading-5 text-foreground">
      <AgentIcon icon={agent.icon} size={14} />
      <span className="break-words leading-5">{agent.name}</span>
    </span>
  );
}

function PlainChannelIdentity({
  provider,
  name,
}: {
  provider: ChatProvider;
  name: string;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2 align-middle text-sm font-medium leading-5 text-foreground">
      <ChannelIcon channel={provider} className="size-4 shrink-0" />
      <span className="break-words leading-5">{name}</span>
    </span>
  );
}

function channelName(binding: Binding) {
  return binding.isDm
    ? "Direct message"
    : (binding.channelName ?? binding.channelId);
}
