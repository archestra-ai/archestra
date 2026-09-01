"use client";

import {
  type archestraApiTypes,
  MESSAGING_CHANNEL_LABELS,
} from "@archestra/shared";
import {
  ArrowRight,
  ChevronDown,
  Info,
  LockKeyhole,
  Plus,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ChannelDetailsDialog,
  channelDisplayName,
} from "@/app/settings/messaging-channels/_components/channel-details-dialog";
import { AgentEmailSettingsDialog } from "@/app/settings/messaging-channels/email/agent-email-settings-dialog";
import { AgentIcon } from "@/components/agent-icon";
import { ChannelIcon } from "@/components/channel-icon";
import { CopyButton } from "@/components/copy-button";
import { FormDialog } from "@/components/form-dialog";
import { QueryLoadError } from "@/components/query-load-error";
import { SettingsSection } from "@/components/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
} from "@/lib/chatops/chatops.query";
import { useAgentEmailAddress } from "@/lib/chatops/incoming-email.query";
import { useConfig } from "@/lib/config/config.query";
import { useMessagingChannelCatalog } from "@/lib/integration-overrides";
import { cn } from "@/lib/utils";

type Agent = archestraApiTypes.GetAgentResponses["200"];
type Binding =
  archestraApiTypes.ListChatOpsBindingsResponses["200"]["data"][number];
type ChatProvider = "ms-teams" | "slack" | "telegram";
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
  const normalizedSelectedIds = [...selectedIds].sort();
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
  const agentNamesFailed = foreignAgentIds.length > 0 && agentNamesLoadingError;

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

  const assignedOptions = orderedOptions.filter((option) =>
    selectedIds.includes(option.id),
  );
  // Configured, or already carrying channels: a provider whose status has not
  // caught up still has rooms in the pool, and hiding its chip would make them
  // unreachable.
  const connectedProviders = visibleProviders.filter(
    (provider) =>
      providers?.some(
        (status) => status.id === provider && status.configured,
      ) || assignmentOptions.some((option) => option.provider === provider),
  );
  const unconnectedProviders = visibleProviders.filter(
    (provider) => !connectedProviders.includes(provider),
  );
  const nothingConnected =
    !providerAvailabilityPending && connectedProviders.length === 0;
  // Bindings arrive page by page, and a half-loaded pool would show an agent
  // as holding fewer channels than it does.
  const listLoading =
    isPending ||
    !allBindingsLoaded ||
    providersPending ||
    providerAvailabilityPending;

  return (
    <>
      {/* Every chat provider hidden but email still on: there is no pool to
          pick from, so the section would only ever show an empty state. */}
      {visibleProviders.length > 0 && (
        <SettingsSection
          title="Channels"
          description="Where this agent listens and replies."
        >
          {assignmentRefreshFailed ? (
            <QueryLoadError
              title="Cannot refresh channel assignments"
              onRetry={() => void refreshSelection()}
            />
          ) : isLoadingError || isFetchNextPageError ? (
            <QueryLoadError
              title="Cannot load channel assignments"
              onRetry={() => void refetch()}
            />
          ) : providersLoadingError ? (
            /* Which providers are connected decides which chips the picker
               can offer, so an unknown status is not "none connected". */
            <QueryLoadError
              title="Cannot load chat app status"
              onRetry={() => void refetchProviders()}
            />
          ) : agentNamesFailed ? (
            /* Without the names, a transfer cannot say which agent loses
               the channel — so the save is withheld, not guessed at. */
            <QueryLoadError
              title="Cannot load the agents assigned to these channels"
              onRetry={() => void refetchAgentNames()}
            />
          ) : listLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : nothingConnected ? (
            /* Nothing to assign, and the reason is not this agent's to fix:
               providers are connected once for the whole organization. This
               is the only place the section points at Settings. */
            <ProvidersEmptyState providers={visibleProviders} />
          ) : (
            <div className="space-y-2">
              {assignedOptions.length === 0 ? (
                <div className="rounded-md border border-dashed px-4 py-6 text-center">
                  <p className="text-sm font-medium">Not in any channel yet</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Add one and this agent starts answering there.
                  </p>
                </div>
              ) : (
                <ul className="space-y-2">
                  {assignedOptions.map((option) => (
                    <AssignedChannelRow
                      key={option.id}
                      option={option}
                      readOnly={readOnly}
                      isSaving={isSaving}
                      hasPendingDetails={!!pendingChannelDetails[option.id]}
                      onOpenDetails={() => setDetailsBindingId(option.id)}
                      onRemove={() => setOptionChecked(option.id, false)}
                    />
                  ))}
                </ul>
              )}
              {!readOnly && (
                <AddChannelPicker
                  options={orderedOptions}
                  selectedIds={selectedIds}
                  connectedProviders={connectedProviders}
                  unconnectedProviders={unconnectedProviders}
                  agentId={agent.id}
                  agentReferences={agentReferences}
                  disabled={isSaving}
                  onPick={(id) => setOptionChecked(id, true)}
                />
              )}
              {standaloneSave && (
                <div className="flex flex-col gap-3 pt-1 sm:flex-row sm:items-center sm:justify-end">
                  {isDirty && (
                    <p className="mr-auto text-xs text-muted-foreground">
                      Save the channel changes before you continue.
                    </p>
                  )}
                  <PermissionButton
                    type="button"
                    permissions={{ agentTrigger: ["update"] }}
                    onClick={() => void requestSave()}
                    disabled={
                      readOnly || !isDirty || isSaving || !agentNamesReady
                    }
                  >
                    <span>
                      {isSaving ? "Saving..." : "Save channel changes"}
                    </span>
                  </PermissionButton>
                </div>
              )}
            </div>
          )}
        </SettingsSection>
      )}

      <SettingsSection
        title="Email"
        description="An address that reaches this agent."
      >
        <AgentEmailSection
          agent={agent}
          emailAddress={emailAddress}
          providerEnabled={emailProviderEnabled}
          readOnly={readOnly}
          onEdit={() => setEmailSettingsOpen(true)}
        />
      </SettingsSection>

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
    </>
  );
}

/**
 * One channel this agent already answers in. The list is the agent's own and
 * stays short, so a row says what it is and offers the two things you do with
 * it; picking new ones is {@link AddChannelPicker}'s job.
 */
function AssignedChannelRow({
  option,
  readOnly,
  isSaving,
  hasPendingDetails,
  onOpenDetails,
  onRemove,
}: {
  option: AssignmentOption;
  readOnly: boolean;
  isSaving: boolean;
  hasPendingDetails: boolean;
  onOpenDetails: () => void;
  onRemove: () => void;
}) {
  const label = assignmentOptionLabel(option);
  // Listed but not yet ours: a staged claim reads exactly like a saved one
  // otherwise, and the two have very different consequences on Save.
  const staged = option.virtualDm
    ? "New direct message"
    : option.assignedAgentName
      ? `Takes over from ${option.assignedAgentName}`
      : null;
  return (
    // Named: the row's controls say "Settings" and an X, which only mean
    // something next to the channel they belong to.
    <li
      aria-label={label}
      className="flex items-center gap-3 rounded-md border px-3 py-2.5"
    >
      <ChannelIcon channel={option.provider} className="size-4 shrink-0" />
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {/* A flex item will not shrink past its content without min-w-0, so
            without it `truncate` never fires and a long name pushes the row's
            controls off the card instead. */}
        <span className="min-w-0 max-w-full truncate text-sm font-medium">
          {option.name}
        </span>
        <span className="min-w-0 max-w-full truncate text-xs text-muted-foreground">
          {[MESSAGING_CHANNEL_LABELS[option.provider], option.workspaceName]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {staged && (
          <Badge
            variant="outline"
            className="px-1.5 py-0 text-[10px] font-normal"
          >
            {staged}
          </Badge>
        )}
        {hasPendingDetails && (
          <Badge
            variant="outline"
            className="px-1.5 py-0 text-[10px] font-normal"
          >
            Changes pending
          </Badge>
        )}
      </span>
      {/* A direct message that does not exist yet has nothing to configure. */}
      {!option.virtualDm && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onOpenDetails}
        >
          {readOnly ? "View details" : "Settings"}
        </Button>
      )}
      {!readOnly && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${label}`}
          disabled={isSaving || !!option.disabledReason}
          onClick={onRemove}
        >
          <X className="size-4" />
        </Button>
      )}
    </li>
  );
}

/**
 * Claiming a channel out of the organization's pool.
 *
 * One provider at a time, chosen with the chips: a list of lists made the
 * reader parse headers and rows at once, and grouping only earns its place
 * where you are genuinely scanning across products. A provider nobody has
 * connected sits in the same row, so the answer to "where is my Telegram
 * chat" is beside the question rather than in a status strip above it.
 */
function AddChannelPicker({
  options,
  selectedIds,
  connectedProviders,
  unconnectedProviders,
  agentId,
  agentReferences,
  disabled,
  onPick,
}: {
  options: AssignmentOption[];
  selectedIds: string[];
  connectedProviders: ChatProvider[];
  unconnectedProviders: ChatProvider[];
  agentId: string;
  agentReferences: Map<string, { id: string; name: string }>;
  disabled: boolean;
  onPick: (optionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<ChatProvider | null>(null);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  // Opening replaces the button with the panel, so focus would otherwise fall
  // back to the document and leave a keyboard user nowhere.
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);
  const activeProvider = provider ?? connectedProviders[0] ?? null;
  const normalized = query.trim().toLocaleLowerCase();

  const unassigned = options.filter(
    (option) => !selectedIds.includes(option.id),
  );
  const matches = (option: AssignmentOption) =>
    !normalized ||
    assignmentOptionLabel(option).toLocaleLowerCase().includes(normalized);
  const shown = unassigned.filter(
    (option) => option.provider === activeProvider && matches(option),
  );
  // What you can actually click stays the list. An option this agent may never
  // hold — most of the pool, for a personal agent — would otherwise bury the
  // one or two pickable rows under its own copy of the same refusal.
  const available = shown.filter((option) => !option.disabledReason);
  const blocked = groupByDisabledReason(shown);
  // Searched here, found there: rather than an empty list, say where it is.
  // Only pickable ones count — pointing at a tab with nothing claimable in it
  // is a wasted trip.
  const elsewhere = unassigned.filter(
    (option) =>
      option.provider !== activeProvider &&
      !option.disabledReason &&
      matches(option),
  );

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <Plus className="size-4" />
        Add channel
      </Button>
    );
  }

  return (
    <div className="rounded-md border">
      <div className="flex flex-wrap items-center gap-1.5 border-b p-2">
        {connectedProviders.map((candidate) => (
          <Button
            key={candidate}
            type="button"
            size="sm"
            variant={candidate === activeProvider ? "secondary" : "ghost"}
            onClick={() => setProvider(candidate)}
          >
            <ChannelIcon channel={candidate} className="size-3.5" />
            {MESSAGING_CHANNEL_LABELS[candidate]}
          </Button>
        ))}
        {/* An unconnected provider is only worth naming at the moment someone
            looks for one of its channels and does not find it. */}
        {unconnectedProviders.map((candidate) => (
          <Button
            key={candidate}
            type="button"
            size="sm"
            variant="ghost"
            asChild
          >
            <Link href={`/settings/messaging-channels/${candidate}`}>
              <Plus className="size-3.5" />
              {MESSAGING_CHANNEL_LABELS[candidate]}
            </Link>
          </Button>
        ))}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          aria-label="Close channel picker"
          onClick={() => {
            setOpen(false);
            setQuery("");
          }}
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="p-2">
        <Input
          ref={searchRef}
          aria-label="Search channels"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={
            activeProvider
              ? `Search ${MESSAGING_CHANNEL_LABELS[activeProvider]} channels...`
              : "Search channels..."
          }
        />
      </div>
      {/* Radix scrolls its viewport, not the root, and the root here is sized
          by max-height alone — without clipping it, a long pool spills out of
          the panel and over whatever the page renders underneath. */}
      <ScrollArea className="max-h-64 overflow-auto">
        <div className="p-2 pt-0">
          {available.map((option) => {
            const heldBy =
              option.assignedAgentId && option.assignedAgentId !== agentId
                ? (agentReferences.get(option.assignedAgentId)?.name ??
                  option.assignedAgentName ??
                  "another agent")
                : null;
            return (
              <button
                key={option.id}
                type="button"
                className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left hover:bg-muted/60"
                onClick={() => {
                  onPick(option.id);
                  setOpen(false);
                  setQuery("");
                }}
              >
                <span className="min-w-0 flex-1 truncate text-sm">
                  {option.name}
                </span>
                {option.virtualDm ? (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    A private chat with this agent
                  </span>
                ) : (
                  heldBy && (
                    <span
                      className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground"
                      title={`Answered by ${heldBy}`}
                    >
                      Answered by {heldBy}
                    </span>
                  )
                )}
              </button>
            );
          })}
          {available.length === 0 && (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              {elsewhere.length > 0 && activeProvider ? (
                <>
                  No {MESSAGING_CHANNEL_LABELS[activeProvider]} channels match.{" "}
                  <button
                    type="button"
                    className="underline hover:text-foreground"
                    onClick={() => setProvider(elsewhere[0].provider)}
                  >
                    {elsewhere.length} in{" "}
                    {MESSAGING_CHANNEL_LABELS[elsewhere[0].provider]}
                  </button>
                </>
              ) : normalized ? (
                "No channels match."
              ) : blocked.length > 0 ? (
                /* The group below already names them and says why. */
                "Nothing here this agent can take on."
              ) : (
                "Every channel here is already assigned to this agent."
              )}
            </p>
          )}
          {blocked.map(([reason, blockedOptions]) => (
            <BlockedOptions
              key={reason}
              reason={reason}
              options={blockedOptions}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

/**
 * The part of the pool this agent may never hold, folded into one line.
 *
 * Every option in a group is refused for the same reason, so the reason is
 * written once here rather than once per row — a personal agent is refused
 * every shared channel in the organization, and thirty copies of that sentence
 * was the loudest thing on the page. They stay one click from view, because
 * "where did my channel go" is a fair question to ask of a picker.
 */
function BlockedOptions({
  reason,
  options,
}: {
  reason: string;
  options: AssignmentOption[];
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="mt-1 border-t pt-1">
      <button
        type="button"
        aria-expanded={expanded}
        className="flex w-full items-start gap-2 rounded-sm px-2 py-2 text-left hover:bg-muted/60"
        onClick={() => setExpanded((current) => !current)}
      >
        <LockKeyhole className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm">
            {options.length} not available to this agent
          </span>
          <span className="block text-xs text-muted-foreground">{reason}</span>
        </span>
        <ChevronDown
          className={cn(
            "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded && (
        <ul className="pb-1">
          {options.map((option) => (
            <li
              key={option.id}
              className="truncate px-2 py-1.5 pl-9 text-sm text-muted-foreground"
            >
              {option.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Nothing is connected, and connecting is an organization-wide job. */
function ProvidersEmptyState({ providers }: { providers: ChatProvider[] }) {
  return (
    <div className="rounded-md border border-dashed px-4 py-6">
      <p className="text-sm font-medium">No messaging providers connected</p>
      <p className="mt-1 max-w-prose text-xs text-muted-foreground">
        {listProviderNames(providers)} are connected once for the whole
        organization. Until one is, there is nothing to assign here.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {providers.map((provider) => (
          <Button
            key={provider}
            type="button"
            variant="outline"
            size="sm"
            asChild
          >
            <Link href={`/settings/messaging-channels/${provider}`}>
              <ChannelIcon channel={provider} className="size-4" />
              Connect {MESSAGING_CHANNEL_LABELS[provider]}
            </Link>
          </Button>
        ))}
      </div>
    </div>
  );
}

/**
 * Email is one address with its own settings, not a room picked off a list,
 * so it gets its own section and its own three states: not set up for the
 * organization at all, set up but off for this agent, and on.
 */
function AgentEmailSection({
  agent,
  emailAddress,
  providerEnabled,
  readOnly,
  onEdit,
}: {
  agent: Agent;
  emailAddress: string | null;
  providerEnabled: boolean;
  readOnly: boolean;
  onEdit: () => void;
}) {
  if (!providerEnabled) {
    return (
      <div className="rounded-md border border-dashed px-4 py-6">
        <p className="text-sm font-medium">Incoming email isn&apos;t set up</p>
        <p className="mt-1 max-w-prose text-xs text-muted-foreground">
          Set it up once for the organization and every agent gets its own
          address.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-4"
          asChild
        >
          <Link href="/settings/messaging-channels/email">
            Set up email in Settings
          </Link>
        </Button>
      </div>
    );
  }

  if (!agent.incomingEmailEnabled) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
        <span className="text-sm">Give this agent an address</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={readOnly}
          onClick={onEdit}
        >
          Turn on
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 rounded-md border px-3 py-2.5">
        <ChannelIcon channel="email" className="size-4 shrink-0" />
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs"
          title={emailAddress ?? undefined}
        >
          {emailAddress ?? "Address pending"}
        </span>
        {emailAddress && <CopyButton text={emailAddress} />}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={readOnly}
          onClick={onEdit}
        >
          Settings
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Who can email it: {agent.incomingEmailSecurityMode}
      </p>
    </div>
  );
}

/** "Slack, Microsoft Teams and Telegram" — an Oxford-free list for prose. */
function listProviderNames(providers: ChatProvider[]): string {
  const names = providers.map((provider) => MESSAGING_CHANNEL_LABELS[provider]);
  if (names.length <= 1) return names[0] ?? "Messaging providers";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

type AssignmentOption = {
  id: string;
  provider: ChatProvider;
  name: string;
  /** Whose direct message this is, when it is one. Names it in the a11y label. */
  ownerEmail: string | null;
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
    isDm: boolean;
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
    ownerEmail: null,
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
      name: channelDisplayName(binding),
      ownerEmail: binding.isDm ? binding.dmOwnerEmail : null,
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

/**
 * Refused options bucketed by the sentence that explains them, in the order
 * the reasons first appear. Usually one bucket; a personal agent looking at a
 * provider it cannot DM on has two.
 */
function groupByDisabledReason(
  options: AssignmentOption[],
): Array<[string, AssignmentOption[]]> {
  const groups = new Map<string, AssignmentOption[]>();
  for (const option of options) {
    if (!option.disabledReason) continue;
    const group = groups.get(option.disabledReason);
    if (group) group.push(option);
    else groups.set(option.disabledReason, [option]);
  }
  return [...groups];
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
              channelName: channelDisplayName(binding),
              agentName: agentNames.get(binding.agentId) ?? "another agent",
              isDm: binding.isDm,
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
  const noun = reassignmentNoun(plan);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      // Nothing is being moved anywhere: the room stays where it is and the
      // agent answering in it changes. "Move channel to n8n" read as though
      // the channel itself were being relocated between agents.
      title={
        singular
          ? `Change the agent for this ${noun.one}?`
          : `Change the agent for ${count} ${noun.many}?`
      }
      description={`A ${noun.one} answers with one agent at a time.`}
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
                The current {singular ? "agent" : "agents"} will stop answering{" "}
                {singular ? `in this ${noun.one}` : `in these ${noun.many}`}.
              </p>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium">Assignment changes</p>
            <Badge variant="secondary">
              {count} {singular ? noun.one : noun.many}
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
                  <p className="text-xs text-muted-foreground">Answers now</p>
                  <span aria-hidden="true" />
                  <p className="text-xs text-muted-foreground">
                    Answers after saving
                  </p>
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
                ? "Saving..."
                : singular
                  ? "Change agent"
                  : "Change agents"}
            </span>
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}

/**
 * What to call the things being reassigned. A direct message is not a channel,
 * and a confirmation that says "channel" over a row reading "Direct message
 * (someone@example.com)" is the reason this dialog was hard to read.
 */
function reassignmentNoun(plan: AssignmentPlan | null) {
  const items = plan?.reassignments ?? [];
  if (items.length > 0 && items.every((item) => item.isDm)) {
    return { one: "direct message", many: "direct messages" };
  }
  if (items.some((item) => item.isDm)) {
    return { one: "conversation", many: "conversations" };
  }
  return { one: "channel", many: "channels" };
}

function assignmentOptionLabel(option: AssignmentOption) {
  const provider = MESSAGING_CHANNEL_LABELS[option.provider];
  if (!option.isDm) return `${provider} channel ${option.name}`;
  return option.ownerEmail
    ? `${provider} direct message for ${option.ownerEmail}`
    : `${provider} direct message`;
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
