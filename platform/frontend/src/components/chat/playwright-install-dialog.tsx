"use client";

import { isAgentTool, PLAYWRIGHT_MCP_CATALOG_ID } from "@shared";
import { useQueries } from "@tanstack/react-query";
import { Globe, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useAgentDelegations } from "@/lib/agent-tools.query";
import {
  fetchAgentMcpTools,
  useConversationEnabledTools,
  useHasPlaywrightMcpTools,
  useProfileToolsWithIds,
  useUpdateConversationEnabledTools,
} from "@/lib/chat.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useMcpServers } from "@/lib/mcp-server.query";
import {
  addPendingAction,
  applyPendingActions,
  getPendingActions,
  PENDING_TOOL_STATE_CHANGE_EVENT,
} from "@/lib/pending-tool-state";
import { cn } from "@/lib/utils";

/**
 * Hook that determines whether the Playwright setup dialog should be shown.
 * Used by both the dialog component and the parent page to avoid async callback delays.
 * TanStack Query deduplicates the underlying fetches.
 */
export function usePlaywrightSetupRequired(
  agentId: string | undefined,
  conversationId: string | undefined,
) {
  // Track pending tool actions reactively (for pre-conversation state)
  const [pendingActionsVersion, setPendingActionsVersion] = useState(0);
  useEffect(() => {
    const handler = () => setPendingActionsVersion((v) => v + 1);
    window.addEventListener(PENDING_TOOL_STATE_CHANGE_EVENT, handler);
    return () =>
      window.removeEventListener(PENDING_TOOL_STATE_CHANGE_EVENT, handler);
  }, []);

  const { data: profileTools = [], isLoading: isLoadingTools } =
    useProfileToolsWithIds(agentId);
  const { data: enabledToolsData } =
    useConversationEnabledTools(conversationId);
  const { data: delegatedAgents = [], isLoading: isLoadingDelegations } =
    useAgentDelegations(agentId);

  // Check if current user has Playwright installed using lightweight queries only
  // (no mutations) to avoid interfering with install state in the dialog/right panel
  const { data: playwrightServers = [] } = useMcpServers({
    catalogId: PLAYWRIGHT_MCP_CATALOG_ID,
  });
  const { data: session } = authClient.useSession();
  const isPlaywrightInstalledByCurrentUser = playwrightServers.some(
    (s) => s.ownerId === session?.user?.id,
  );

  // Identify Playwright tool IDs from the parent agent's profile tools
  const playwrightToolIds = useMemo(
    () =>
      profileTools
        .filter((t) => t.catalogId === PLAYWRIGHT_MCP_CATALOG_ID)
        .map((t) => t.id),
    [profileTools],
  );

  // Determine which tool IDs are currently enabled on the parent agent
  // Mirrors the logic in ChatToolsDisplay including pending actions for pre-conversation state
  // biome-ignore lint/correctness/useExhaustiveDependencies: pendingActionsVersion triggers recompute when localStorage changes
  const currentEnabledToolIds = useMemo(() => {
    if (conversationId && enabledToolsData?.hasCustomSelection) {
      return enabledToolsData.enabledToolIds;
    }
    const defaultIds = profileTools.map((t) => t.id);

    if (!conversationId && agentId) {
      const pendingActions = getPendingActions(agentId);
      if (pendingActions.length > 0) {
        return applyPendingActions(defaultIds, pendingActions);
      }
    }

    return defaultIds;
  }, [
    conversationId,
    enabledToolsData,
    profileTools,
    agentId,
    pendingActionsVersion,
  ]);

  const enabledSet = useMemo(
    () => new Set(currentEnabledToolIds),
    [currentEnabledToolIds],
  );

  const hasEnabledPlaywrightTool = playwrightToolIds.some((id) =>
    enabledSet.has(id),
  );

  // Map sub-agent ID → delegation tool ID so we can check if the sub-agent is enabled
  const enabledSubAgentIds = useMemo(() => {
    const delegationToolMap = new Map<string, string>();
    for (const tool of profileTools) {
      if (isAgentTool(tool.name) && tool.delegateToAgentId) {
        delegationToolMap.set(tool.delegateToAgentId, tool.id);
      }
    }
    return delegatedAgents
      .filter((agent) => {
        const toolId = delegationToolMap.get(agent.id);
        return toolId ? enabledSet.has(toolId) : false;
      })
      .map((agent) => agent.id);
  }, [profileTools, delegatedAgents, enabledSet]);

  // Fetch tools for each enabled sub-agent to check for Playwright tools
  const subAgentToolQueries = useQueries({
    queries: enabledSubAgentIds.map((id) => ({
      queryKey: ["agents", id, "tools", "mcp-only"] as const,
      queryFn: () => fetchAgentMcpTools(id),
    })),
  });

  const enabledSubAgentHasPlaywrightTools = useMemo(
    () =>
      subAgentToolQueries.some((query) =>
        query.data?.some(
          (tool) => tool.catalogId === PLAYWRIGHT_MCP_CATALOG_ID,
        ),
      ),
    [subAgentToolQueries],
  );

  const isLoadingSubAgentTools = subAgentToolQueries.some((q) => q.isLoading);
  const isLoading =
    !isPlaywrightInstalledByCurrentUser &&
    (isLoadingTools || isLoadingDelegations || isLoadingSubAgentTools);

  // When a conversation exists but enabled tools haven't loaded yet, we don't
  // know the actual tool selection — don't claim setup is required based on
  // defaults that may not reflect the user's custom selection.
  const isAwaitingEnabledTools = !!conversationId && !enabledToolsData;

  const isRequired =
    !isPlaywrightInstalledByCurrentUser &&
    !isAwaitingEnabledTools &&
    (hasEnabledPlaywrightTool || enabledSubAgentHasPlaywrightTools);

  return { isLoading, isRequired };
}

interface PlaywrightInstallDialogProps {
  agentId: string | undefined;
  conversationId: string | undefined;
}

/**
 * Hook that provides a callback to disable all Playwright-related tools
 * (direct Playwright tools + delegation tools for sub-agents with Playwright).
 * Queries are deduplicated with usePlaywrightSetupRequired via TanStack Query.
 */
function useDisablePlaywrightTools(
  agentId: string | undefined,
  conversationId: string | undefined,
) {
  const { data: profileTools = [] } = useProfileToolsWithIds(agentId);
  const { data: enabledToolsData } =
    useConversationEnabledTools(conversationId);
  const { data: delegatedAgents = [] } = useAgentDelegations(agentId);
  const updateEnabledTools = useUpdateConversationEnabledTools();

  const subAgentToolQueries = useQueries({
    queries: delegatedAgents.map((agent) => ({
      queryKey: ["agents", agent.id, "tools", "mcp-only"] as const,
      queryFn: () => fetchAgentMcpTools(agent.id),
    })),
  });

  const delegationToolMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const tool of profileTools) {
      if (isAgentTool(tool.name) && tool.delegateToAgentId) {
        map.set(tool.delegateToAgentId, tool.id);
      }
    }
    return map;
  }, [profileTools]);

  const toolIdsToDisable = useMemo(() => {
    const ids = new Set<string>();
    for (const tool of profileTools) {
      if (tool.catalogId === PLAYWRIGHT_MCP_CATALOG_ID) {
        ids.add(tool.id);
      }
    }
    for (let i = 0; i < delegatedAgents.length; i++) {
      const tools = subAgentToolQueries[i]?.data;
      if (tools?.some((t) => t.catalogId === PLAYWRIGHT_MCP_CATALOG_ID)) {
        const toolId = delegationToolMap.get(delegatedAgents[i].id);
        if (toolId) ids.add(toolId);
      }
    }
    return Array.from(ids);
  }, [profileTools, delegatedAgents, subAgentToolQueries, delegationToolMap]);

  const disablePlaywright = useCallback(() => {
    if (toolIdsToDisable.length === 0) return;

    if (conversationId) {
      const currentEnabled = enabledToolsData?.hasCustomSelection
        ? enabledToolsData.enabledToolIds
        : profileTools.map((t) => t.id);

      const disableSet = new Set(toolIdsToDisable);
      const newEnabledIds = currentEnabled.filter((id) => !disableSet.has(id));
      updateEnabledTools.mutate({ conversationId, toolIds: newEnabledIds });
    } else if (agentId) {
      addPendingAction(
        { type: "disableAll", toolIds: toolIdsToDisable },
        agentId,
      );
    }
  }, [
    toolIdsToDisable,
    conversationId,
    agentId,
    enabledToolsData,
    profileTools,
    updateEnabledTools,
  ]);

  return { disablePlaywright, isDisabling: updateEnabledTools.isPending };
}

function PlaywrightInstallContent({
  agentId,
  conversationId,
  isInline = false,
}: PlaywrightInstallDialogProps & { isInline?: boolean }) {
  const {
    isPlaywrightInstalledByCurrentUser,
    reinstallRequired,
    installationFailed,
    playwrightServerId,
    isInstalling,
    isAssigningTools,
    installBrowser,
    reinstallBrowser,
  } = useHasPlaywrightMcpTools(agentId, conversationId);

  const { disablePlaywright, isDisabling } = useDisablePlaywrightTools(
    agentId,
    conversationId,
  );

  if (isPlaywrightInstalledByCurrentUser) return null;

  const isInProgress = isInstalling || isAssigningTools;

  const buttonSize = isInline ? "sm" : "default";

  return (
    <Card
      className={isInline ? "w-full max-w-xl mx-4" : "w-full max-w-md mx-4"}
    >
      <CardHeader>
        <CardTitle
          className={cn(
            "flex items-center gap-2",
            isInline ? "text-sm" : "text-md",
          )}
        >
          <Globe className={cn(isInline ? "size-4" : "size-5")} />
          Browser Setup Required
        </CardTitle>
        <CardDescription className={isInline ? "text-xs" : "text-sm"}>
          This agent or its sub-agents use Playwright browser tools. Each user
          needs their own browser instance installed before these tools can be
          used.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3">
          <div className="flex gap-3">
            {isInProgress ? (
              <Button disabled className="flex-1" size={buttonSize}>
                <Loader2 className="size-4 animate-spin" />
                {isAssigningTools
                  ? "Assigning tools..."
                  : "Installing browser..."}
              </Button>
            ) : reinstallRequired || installationFailed ? (
              <Button
                className="flex-1"
                size={buttonSize}
                onClick={() =>
                  playwrightServerId && reinstallBrowser(playwrightServerId)
                }
                disabled={!playwrightServerId}
              >
                {installationFailed
                  ? "Retry Installation"
                  : "Reinstall Browser"}
              </Button>
            ) : (
              <Button
                className="flex-1"
                size={buttonSize}
                onClick={() => agentId && installBrowser(agentId)}
                disabled={!agentId}
              >
                Install Browser
              </Button>
            )}
            <Button
              variant="secondary"
              className="flex-1"
              size={buttonSize}
              onClick={disablePlaywright}
              disabled={isInProgress || isDisabling}
            >
              {isDisabling ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Disabling...
                </>
              ) : (
                "Disable Browser Tools"
              )}
            </Button>
          </div>
          {installationFailed && (
            <p className="text-sm text-destructive">
              Browser installation failed. Click to retry.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function PlaywrightInstallDialog({
  agentId,
  conversationId,
}: PlaywrightInstallDialogProps) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/60">
      <PlaywrightInstallContent
        agentId={agentId}
        conversationId={conversationId}
      />
    </div>
  );
}

export function PlaywrightInstallInline({
  agentId,
  conversationId,
}: PlaywrightInstallDialogProps) {
  return (
    <PlaywrightInstallContent
      agentId={agentId}
      conversationId={conversationId}
      isInline
    />
  );
}
