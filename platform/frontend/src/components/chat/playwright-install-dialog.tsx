"use client";

import {
  DEFAULT_ARCHESTRA_TOOL_NAMES,
  isAgentTool,
  PLAYWRIGHT_MCP_CATALOG_ID,
} from "@shared";
import { useQueries } from "@tanstack/react-query";
import { Globe, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
} from "@/lib/chat.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useMcpServers } from "@/lib/mcp-server.query";
import {
  applyPendingActions,
  getPendingActions,
  PENDING_TOOL_STATE_CHANGE_EVENT,
} from "@/lib/pending-tool-state";

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
    const defaultIds = profileTools
      .filter(
        (tool) =>
          !tool.name.startsWith("archestra__") ||
          DEFAULT_ARCHESTRA_TOOL_NAMES.includes(tool.name),
      )
      .map((t) => t.id);

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

  const isRequired =
    !isPlaywrightInstalledByCurrentUser &&
    (hasEnabledPlaywrightTool || enabledSubAgentHasPlaywrightTools);

  return { isLoading, isRequired };
}

interface PlaywrightInstallDialogProps {
  agentId: string | undefined;
  conversationId: string | undefined;
}

export function PlaywrightInstallDialog({
  agentId,
  conversationId,
}: PlaywrightInstallDialogProps) {
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

  if (isPlaywrightInstalledByCurrentUser) return null;

  const isInProgress = isInstalling || isAssigningTools;

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/60">
      <Card className="w-full max-w-md mx-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe className="size-5" />
            Browser Setup Required
          </CardTitle>
          <CardDescription>
            This agent or its sub-agents use Playwright browser tools. Each user
            needs their own browser instance installed before these tools can be
            used.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3">
            {isInProgress ? (
              <Button disabled>
                <Loader2 className="size-4 animate-spin" />
                {isAssigningTools
                  ? "Assigning tools..."
                  : "Installing browser..."}
              </Button>
            ) : reinstallRequired || installationFailed ? (
              <Button
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
                onClick={() => agentId && installBrowser(agentId)}
                disabled={!agentId}
              >
                Install Browser
              </Button>
            )}
            {installationFailed && (
              <p className="text-sm text-destructive">
                Browser installation failed. Click to retry.
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
