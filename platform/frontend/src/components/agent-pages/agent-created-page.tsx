"use client";

import { MESSAGING_CHANNEL_LABELS } from "@archestra/shared";
import { CircleCheck, MessageSquare, TerminalSquare } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { channelDisplayName } from "@/app/settings/messaging-channels/_components/channel-details-dialog";
import { AgentSavedSetupBanner } from "@/components/agent-saved-setup-banner";
import { ChannelIcon } from "@/components/channel-icon";
import { RuntimeCapableIndicator } from "@/components/chat/runtime-capable-indicator";
import { CopyButton } from "@/components/copy-button";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useProfile } from "@/lib/agent.query";
import { useAllPermissions } from "@/lib/auth/auth.query";
import { hasPermissions } from "@/lib/auth/auth.utils";
import { useAllChatOpsBindings } from "@/lib/chatops/chatops.query";
import { useAgentEmailAddress } from "@/lib/chatops/incoming-email.query";
import { useConfig, useFeature } from "@/lib/config/config.query";
import { ACTION_LABEL } from "@/lib/design/resource-lexicon";
import { useMessagingChannelCatalog } from "@/lib/integration-overrides";
import { agentDetailHref } from "./agent-page-config";
import { AgentPageShell } from "./agent-page-shell";
import { useAgentAccess } from "./use-agent-access";

export function AgentCreatedPage({ id }: { id: string }) {
  const { data: agent, isPending, isError, refetch } = useProfile(id);
  const runtimeEnabled = useFeature("agentRuntime") === true;
  const startsRun = runtimeEnabled && agent?.runtime != null;
  const {
    data: permissions,
    isPending: permissionsPending,
    isError: permissionsError,
    refetch: refetchPermissions,
  } = useAllPermissions();
  const canChat = hasPermissions(permissions, { chat: ["read", "create"] });
  const canReadChannels = hasPermissions(permissions, {
    agentTrigger: ["read"],
  });
  const catalog = useMessagingChannelCatalog();
  const { canEdit } = useAgentAccess(agent, "agent");

  return (
    <AgentPageShell
      backHref="/agents"
      backLabel="Agents"
      header={{
        title: agent?.agentType === "agent" ? "Agent created" : "Agent",
        description:
          agent?.agentType === "agent"
            ? "Choose how to reach your new agent."
            : undefined,
      }}
    >
      {isError ? (
        <QueryLoadError
          title="Cannot load the agent"
          onRetry={() => void refetch()}
        />
      ) : isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : !agent || agent.agentType !== "agent" ? (
        <p className="text-muted-foreground">Agent not found.</p>
      ) : (
        <div className="space-y-6">
          <AgentSavedSetupBanner
            agentId={id}
            canEditAgent={canEdit}
            showReady
          />
          <div className="flex flex-col items-start justify-between gap-4 border-b pb-6 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <div className="min-w-0 space-y-1">
                <h2 className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <CircleCheck
                    className="size-4 shrink-0 text-green-600 dark:text-green-400"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 break-words">{agent.name}</span>
                  {startsRun && (
                    <RuntimeCapableIndicator
                      variant="pill"
                      runtime={agent.runtime}
                    />
                  )}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {canChat
                    ? startsRun
                      ? "Your agent is saved. Start a run to give it a task."
                      : "Your agent is saved. Open a chat to start a conversation."
                    : "Your agent is saved."}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {canChat && (
                <Button asChild size="sm">
                  <Link href={`/chat?agentId=${encodeURIComponent(agent.id)}`}>
                    {startsRun ? (
                      <TerminalSquare className="size-4" aria-hidden="true" />
                    ) : (
                      <MessageSquare className="size-4" aria-hidden="true" />
                    )}
                    <span>
                      {startsRun ? ACTION_LABEL.startRun : ACTION_LABEL.chat}
                    </span>
                  </Link>
                </Button>
              )}
              <Button asChild variant="outline" size="sm">
                <Link href={agentDetailHref("agent", agent.id)}>
                  View agent
                </Link>
              </Button>
            </div>
          </div>
          {agent.incomingEmailEnabled && !catalog.isHidden("email") && (
            <AgentEmailSummary agentId={agent.id} />
          )}
          <section className="space-y-3" aria-label="Messaging channels">
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <span>Messaging channels</span>
            </h2>
            {permissionsError ? (
              <QueryLoadError
                title="Cannot load your permissions"
                onRetry={() => void refetchPermissions()}
              />
            ) : permissionsPending ? (
              <Skeleton className="h-20 w-full" />
            ) : canReadChannels ? (
              <AgentMessagingSummary agentId={agent.id} />
            ) : (
              <p className="text-sm text-muted-foreground">
                You do not have permission to view messaging channels.
              </p>
            )}
          </section>
        </div>
      )}
    </AgentPageShell>
  );
}

function AgentEmailSummary({ agentId }: { agentId: string }) {
  const { data, isPending, isError, refetch } = useAgentEmailAddress(agentId, {
    toastOnError: false,
  });
  if (isPending) return <Skeleton className="h-20 w-full" />;
  if (isError) {
    return (
      <QueryLoadError
        title="Cannot load the agent's email address"
        onRetry={() => void refetch()}
      />
    );
  }
  if (
    !data?.providerEnabled ||
    !data.agentIncomingEmailEnabled ||
    !data.emailAddress
  ) {
    return null;
  }
  return (
    <section className="space-y-3" aria-label="Email">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <span>Email</span>
      </h2>
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Send an email to this address to reach your agent.
        </p>
        <div className="flex items-center gap-2">
          <a
            className="min-w-0 break-all text-sm underline underline-offset-4"
            href={`mailto:${data.emailAddress}`}
          >
            {data.emailAddress}
          </a>
          <CopyButton text={data.emailAddress} className="shrink-0" />
        </div>
      </div>
    </section>
  );
}

function AgentMessagingSummary({ agentId }: { agentId: string }) {
  const {
    data,
    isPending,
    isFetching,
    isError,
    refetch,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useAllChatOpsBindings();
  const {
    data: config,
    isPending: configPending,
    isError: configError,
    refetch: refetchConfig,
  } = useConfig();
  const catalog = useMessagingChannelCatalog();

  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isError) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, isError, fetchNextPage]);

  if (configError) {
    return (
      <QueryLoadError
        title="Cannot load messaging channel availability"
        onRetry={() => void refetchConfig()}
      />
    );
  }
  if (isError) {
    return (
      <QueryLoadError
        title="Cannot load messaging channels"
        onRetry={() => void refetch()}
      />
    );
  }
  if (isPending || isFetching || hasNextPage || configPending) {
    return <Skeleton className="h-20 w-full" />;
  }

  const bindings = data?.bindings.filter(
    (binding) =>
      binding.agentId === agentId &&
      !catalog.isHidden(binding.provider) &&
      (binding.provider !== "telegram" ||
        config?.features.chatopsTelegramEnabled === true),
  );
  return (
    <>
      {bindings?.length ? (
        <ul className="divide-y">
          {bindings.map((binding) => (
            <li
              key={binding.id}
              className="flex items-start gap-2 py-3 first:pt-0 last:pb-0"
            >
              <ChannelIcon
                channel={binding.provider}
                className="mt-0.5 size-4 shrink-0"
              />
              <div className="min-w-0 space-y-1">
                <p className="break-words text-sm font-medium">
                  {channelDisplayName(binding)}
                </p>
                <p className="break-words text-xs text-muted-foreground">
                  {MESSAGING_CHANNEL_LABELS[binding.provider]}
                  {binding.workspaceName && (
                    <span> · {binding.workspaceName}</span>
                  )}
                </p>
                <p className="text-sm text-muted-foreground">
                  {binding.isDm
                    ? "Send a direct message to the bot to reach this agent."
                    : binding.answerAllMessages
                      ? "The agent replies to all messages in this channel."
                      : "Mention the bot in this channel to reach this agent."}
                </p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          No messaging channels are configured for this agent.
        </p>
      )}
      <Button
        asChild
        variant="link"
        className="h-auto px-0 py-0 text-sm text-muted-foreground hover:text-foreground"
      >
        <Link href={agentDetailHref("agent", agentId, "messaging")}>
          <span>Manage messaging channels</span>
        </Link>
      </Button>
    </>
  );
}
