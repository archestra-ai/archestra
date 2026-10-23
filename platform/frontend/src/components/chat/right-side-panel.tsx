"use client";

import { AppWindow } from "lucide-react";
import { useEffect, useRef } from "react";
import { useApps } from "@/components/chat/apps-context";
import { BrowserPanel } from "@/components/chat/browser-panel";
import { ConversationFilesPanel } from "@/components/chat/conversation-files-panel";
import { McpAppSection } from "@/components/chat/mcp-app-container";
import { ResizableRightPanel } from "@/components/chat/resizable-right-panel";
import { ScheduleRunsPanel } from "@/components/scheduled-tasks/schedule-runs-panel";
export type RightPanelTab = "runs" | "files" | "browser" | "apps";

interface RightSidePanelProps {
  isOpen: boolean;
  activeTab: RightPanelTab;
  onClose: () => void;
  canShowBrowser: boolean;

  /**
   * Set when the open chat is a scheduled run — enables the Runs tab, which
   * lists the schedule's runs and marks `runId` as current.
   */
  scheduledRun?: { triggerId: string; runId: string | null } | null;

  // Artifact props
  artifact?: string | null;

  /** Set when the chat belongs to a project — enables the pinned instructions. */
  projectId?: string | null;

  // Browser props
  conversationId: string | undefined;
  /** Fallback agentId for pre-conversation case */
  agentId?: string;
  /** Called when user enters a URL without a conversation - should create conversation and navigate */
  onCreateConversationWithUrl?: (url: string) => void;
  /** Whether conversation creation is in progress */
  isCreatingConversation?: boolean;
  /** URL to navigate to once connected (after conversation creation) */
  initialNavigateUrl?: string;
  /** Called after initial navigation is triggered */
  onInitialNavigateComplete?: () => void;
}

export function RightSidePanel({
  isOpen,
  activeTab,
  onClose,
  canShowBrowser,
  scheduledRun,
  artifact,
  projectId,
  conversationId,
  agentId,
  onCreateConversationWithUrl,
  isCreatingConversation = false,
  initialNavigateUrl,
  onInitialNavigateComplete,
}: RightSidePanelProps) {
  const { setSettingsOpen } = useApps();

  let resolvedTab: RightPanelTab = activeTab;
  if (resolvedTab === "browser" && !canShowBrowser) resolvedTab = "files";
  // The Runs tab only exists for scheduled-run chats; fall back otherwise.
  if (resolvedTab === "runs" && !scheduledRun) resolvedTab = "files";

  // Collapsing the panel drops the owned-app settings form so it reopens on the
  // live app, not the form. The tab strip (in the header) now drives collapse,
  // so reset here whenever the panel closes, regardless of how.
  useEffect(() => {
    if (!isOpen) {
      setSettingsOpen(false);
    }
  }, [isOpen, setSettingsOpen]);

  if (!isOpen) {
    return null;
  }

  // Content only — the Files/Browser/Apps/Runs tab strip lives in the header's
  // top bar now, so the panel just renders the selected tab's content.
  return (
    <ResizableRightPanel>
      <div className="flex-1 min-h-0 overflow-hidden relative">
        {resolvedTab === "runs" && scheduledRun && (
          <ScheduleRunsPanel
            triggerId={scheduledRun.triggerId}
            currentRunId={scheduledRun.runId}
          />
        )}
        {resolvedTab === "files" && (
          <ConversationFilesPanel
            key={conversationId ?? "none"}
            conversationId={conversationId}
            artifact={artifact}
            projectId={projectId}
            onClose={onClose}
          />
        )}
        {resolvedTab === "browser" && canShowBrowser && (
          <BrowserPanel
            isOpen
            onClose={onClose}
            conversationId={conversationId}
            agentId={agentId}
            onCreateConversationWithUrl={onCreateConversationWithUrl}
            isCreatingConversation={isCreatingConversation}
            initialNavigateUrl={initialNavigateUrl}
            onInitialNavigateComplete={onInitialNavigateComplete}
            hideHeader
          />
        )}
        {/* Apps tab content: renders the open app directly (no portal). The
            app-switcher lives in the hosted card's header (see McpAppCard). */}
        {resolvedTab === "apps" && <AppsPanelContent agentId={agentId} />}
      </div>
    </ResizableRightPanel>
  );
}

/**
 * The Apps tab content: the hosted app (or the no-apps empty state). Shared by
 * the desktop right panel and the chat page's inline mobile panel. While
 * mounted it registers as the apps portal target, which collapses inline app
 * renders in the chat and switches pill clicks to select-the-hosted-app mode —
 * so mount it only while the Apps tab is actually showing.
 */
export function AppsPanelContent({ agentId }: { agentId?: string }) {
  const { apps, setPortalTarget } = useApps();
  const portalDivRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setPortalTarget(portalDivRef.current);
    return () => {
      setPortalTarget(null);
    };
  }, [setPortalTarget]);

  return (
    <div className="flex flex-col h-full">
      <div ref={portalDivRef} className="flex-1 min-h-0 relative">
        {apps.length === 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center text-xs text-muted-foreground px-6">
            <AppWindow className="h-6 w-6 mb-2 opacity-50" />
            <p className="font-medium">No Apps in this chat</p>
            <p className="mt-1">
              Apps from tool calls in this conversation will appear here.
            </p>
          </div>
        ) : (
          <PanelAppHost agentId={agentId} />
        )}
      </div>
    </div>
  );
}

/**
 * Renders the single hosted app (`panelToolCallId`) directly in the panel.
 * Switching the hosted app remounts via the key; the app-endpoint is rebuilt from
 * the list entry (owned apps need no extra data, external apps use the agent).
 */
function PanelAppHost({ agentId }: { agentId?: string }) {
  const { apps, panelToolCallId } = useApps();
  const app = apps.find((a) => a.toolCallId === panelToolCallId);
  if (!app) {
    return null;
  }

  // An external app drives the agent gateway; mounting a fresh iframe against an
  // empty agent (`/api/mcp/`) would 404, so bail like the inline render's guard.
  if (!app.appId && !app.mcpServerId && !agentId) {
    return null;
  }

  return (
    <McpAppSection
      key={app.toolCallId}
      surface="panel"
      uiResourceUri={app.uiResourceUri}
      agentId={agentId ?? ""}
      appId={app.appId ?? undefined}
      mcpServerId={app.mcpServerId}
      appName={app.label}
      appVersion={app.version}
      toolName={app.toolName ?? ""}
      toolCallId={app.toolCallId}
      rawOutput={app.rawOutput ?? undefined}
      toolInput={app.toolInput ?? undefined}
    />
  );
}

// Per-schedule runs-list scroll position. Selecting a run swaps the chat to the
// run's conversation; the page re-renders (and the panel can remount), which
// resets the list to the top. Remembering scrollTop here (module scope survives
// both) lets us restore it so the list stays where you left it after picking a run.
