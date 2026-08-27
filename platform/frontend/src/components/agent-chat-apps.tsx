"use client";

import {
  type archestraApiTypes,
  MESSAGING_CHANNEL_LABELS,
} from "@archestra/shared";
import { MessageSquareText, MessagesSquare } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ChannelInstructionsDialog } from "@/app/messaging-channels/_components/channel-instructions-dialog";
import { ChannelIcon } from "@/components/channel-icon";
import { QueryLoadError } from "@/components/query-load-error";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import {
  MultiSelectCombobox,
  type MultiSelectOption,
} from "@/components/ui/multi-select-combobox";
import { PermissionButton } from "@/components/ui/permission-button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useSession } from "@/lib/auth/auth.query";
import {
  useAllChatOpsBindings,
  useBulkUpdateChatOpsBindings,
  useChatOpsStatus,
  useCreateChatOpsDmBinding,
  useUpdateChatOpsBinding,
} from "@/lib/chatops/chatops.query";

type Agent = archestraApiTypes.GetAgentResponses["200"];
type ChatProvider = "ms-teams" | "slack" | "telegram";

const CHAT_PROVIDERS = [
  "ms-teams",
  "slack",
  "telegram",
] as const satisfies readonly ChatProvider[];
const VIRTUAL_DM_PREFIX = "virtual-dm:";

export function AgentChatApps({ agent }: { agent: Agent }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [instructionsBindingId, setInstructionsBindingId] = useState<
    string | null
  >(null);
  const { data: session } = useSession();
  const {
    data,
    isPending,
    isLoadingError,
    refetch,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useAllChatOpsBindings();
  const { data: providers } = useChatOpsStatus();
  const updateBindings = useBulkUpdateChatOpsBindings();
  const createDmBinding = useCreateChatOpsDmBinding();
  const updateBinding = useUpdateChatOpsBinding();

  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  const bindings = data?.bindings ?? [];
  const assignedBindings = bindings.filter(
    (binding) => binding.agentId === agent.id,
  );
  const instructionsBinding =
    assignedBindings.find((binding) => binding.id === instructionsBindingId) ??
    null;
  const existingDmProviders = new Set(
    bindings
      .filter((binding) => binding.isDm)
      .map((binding) => binding.provider),
  );
  const configuredDmProviders = CHAT_PROVIDERS.filter(
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
  const options = useMemo<MultiSelectOption[]>(() => {
    const realOptions = bindings.map((binding) => {
      const personalAssignmentRefused =
        agent.scope === "personal" &&
        (!binding.isDm || agent.authorId !== session?.user?.id);
      const provider = binding.provider as ChatProvider;
      return {
        value: binding.id,
        label: `${MESSAGING_CHANNEL_LABELS[provider]} · ${channelName(binding)}`,
        icon: <ChannelIcon channel={provider} />,
        description: personalAssignmentRefused
          ? "Personal agents can only use their owner's direct messages."
          : binding.agentId && binding.agentId !== agent.id
            ? "Assigned to another agent; selecting it will reassign the channel."
            : binding.workspaceName || undefined,
        disabled: personalAssignmentRefused,
      };
    });
    const virtualDmOptions = configuredDmProviders.map((provider) => ({
      value: `${VIRTUAL_DM_PREFIX}${provider}`,
      label: `${MESSAGING_CHANNEL_LABELS[provider]} · Direct message`,
      icon: <ChannelIcon channel={provider} />,
      description: "Created when this assignment is saved.",
      disabled:
        agent.scope === "personal" && agent.authorId !== session?.user?.id,
    }));
    return [...virtualDmOptions, ...realOptions];
  }, [
    agent.authorId,
    agent.id,
    agent.scope,
    bindings,
    configuredDmProviders,
    session?.user?.id,
  ]);

  const normalizedSelectedIds = [...selectedIds].sort();
  const isDirty =
    normalizedSelectedIds.length !== currentIds.length ||
    normalizedSelectedIds.some((id, index) => id !== currentIds[index]);
  const isSaving = updateBindings.isPending || createDmBinding.isPending;
  const allBindingsLoaded = !hasNextPage && !isFetchingNextPage;

  const openDialog = () => {
    setSelectedIds(currentIds);
    setDialogOpen(true);
  };

  const saveAssignments = async () => {
    const selectedRealIds = selectedIds.filter(
      (id) => !id.startsWith(VIRTUAL_DM_PREFIX),
    );
    const toAssign = bindings
      .filter(
        (binding) =>
          selectedRealIds.includes(binding.id) && binding.agentId !== agent.id,
      )
      .map((binding) => binding.id);
    const toUnassign = assignedBindings
      .filter((binding) => !selectedRealIds.includes(binding.id))
      .map((binding) => binding.id);

    if (toAssign.length > 0) {
      await updateBindings.mutateAsync({ ids: toAssign, agentId: agent.id });
    }
    if (toUnassign.length > 0) {
      await updateBindings.mutateAsync({ ids: toUnassign, agentId: null });
    }
    for (const id of selectedIds.filter((value) =>
      value.startsWith(VIRTUAL_DM_PREFIX),
    )) {
      await createDmBinding.mutateAsync({
        provider: id.slice(VIRTUAL_DM_PREFIX.length) as ChatProvider,
        agentId: agent.id,
      });
    }
    setDialogOpen(false);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <MessagesSquare className="h-4 w-4 text-muted-foreground" />
            <h4 className="text-sm font-medium">Chat Apps</h4>
          </div>
          <p className="text-xs text-muted-foreground">
            Choose which chat channels use this agent by default. Provider
            credentials are managed under{" "}
            <Link
              href="/settings/messaging-channels"
              className="underline hover:text-foreground"
            >
              Settings → Messaging Channels
            </Link>
            .
          </p>
        </div>
        <PermissionButton
          permissions={{ agentTrigger: ["update"] }}
          variant="outline"
          size="sm"
          onClick={openDialog}
          disabled={isPending || !allBindingsLoaded}
        >
          Manage channels
        </PermissionButton>
      </div>

      {isPending ? (
        <div className="flex gap-2">
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-7 w-36" />
        </div>
      ) : isLoadingError ? (
        <QueryLoadError
          title="Couldn't load assigned channels"
          onRetry={() => refetch()}
        />
      ) : assignedBindings.length > 0 ? (
        <div className="divide-y rounded-md border">
          {assignedBindings.map((binding) => (
            <div
              key={binding.id}
              className="flex flex-wrap items-center justify-between gap-3 px-3 py-2"
            >
              <div className="flex min-w-0 items-center gap-2 text-sm">
                <ChannelIcon
                  channel={binding.provider as ChatProvider}
                  className="size-4"
                />
                <span className="truncate">{channelName(binding)}</span>
              </div>
              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setInstructionsBindingId(binding.id)}
                >
                  <MessageSquareText className="size-4" />
                  {binding.channelInstructions
                    ? "Edit instructions"
                    : "Add instructions"}
                </Button>
                {!binding.isDm && binding.provider !== "telegram" && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Switch
                      aria-label={`Reply to all messages in ${channelName(binding)}`}
                      checked={!!binding.answerAllMessages}
                      disabled={updateBinding.isPending}
                      onCheckedChange={(answerAllMessages) =>
                        updateBinding.mutate({
                          id: binding.id,
                          answerAllMessages,
                        })
                      }
                    />
                    <span>Reply to all messages</span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No chat channels are assigned to this agent.
        </p>
      )}

      <StandardDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={`Manage chat channels for ${agent.name}`}
        description="Selecting a channel already used by another agent moves its default assignment here."
        isDirty={isDirty}
        footer={
          <>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <PermissionButton
              permissions={{ agentTrigger: ["update"] }}
              onClick={() => void saveAssignments()}
              disabled={!isDirty || isSaving}
            >
              {isSaving ? "Saving..." : "Save assignments"}
            </PermissionButton>
          </>
        }
      >
        <MultiSelectCombobox
          options={options}
          value={selectedIds}
          onChange={setSelectedIds}
          placeholder="Search channels..."
          emptyMessage="No discovered channels are available."
          disabled={!allBindingsLoaded || isSaving}
        />
        <p className="mt-2 text-xs text-muted-foreground">
          New group channels appear after the bot is added and receives its
          first interaction.
        </p>
      </StandardDialog>

      {instructionsBinding && (
        <ChannelInstructionsDialog
          open
          onOpenChange={(open) => {
            if (!open) setInstructionsBindingId(null);
          }}
          channelLabel={channelName(instructionsBinding)}
          agentName={agent.name}
          instructions={instructionsBinding.channelInstructions ?? null}
          isSaving={updateBinding.isPending}
          onSave={(channelInstructions) =>
            updateBinding.mutate(
              { id: instructionsBinding.id, channelInstructions },
              { onSuccess: () => setInstructionsBindingId(null) },
            )
          }
        />
      )}
    </div>
  );
}

function channelName(
  binding: archestraApiTypes.ListChatOpsBindingsResponses["200"]["data"][number],
) {
  return binding.isDm
    ? "Direct message"
    : (binding.channelName ?? binding.channelId);
}
