"use client";

import {
  AppWindow,
  CalendarClock,
  FileText,
  Globe,
  PanelRightClose,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useApps } from "@/components/chat/apps-context";
import { BrowserPanel } from "@/components/chat/browser-panel";
import { ConversationFilesPanel } from "@/components/chat/conversation-files-panel";
import { ResizableRightPanel } from "@/components/chat/resizable-right-panel";
import { ScheduleRunsList } from "@/components/scheduled-tasks/schedule-runs-list";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useScheduleTrigger } from "@/lib/schedule-trigger.query";

export type RightPanelTab = "runs" | "files" | "browser" | "apps";

interface RightSidePanelProps {
  isOpen: boolean;
  activeTab: RightPanelTab;
  onTabChange: (tab: RightPanelTab) => void;
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
  onTabChange,
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
  const { apps, setPortalTarget, setSettingsOpen } = useApps();
  const portalDivRef = useRef<HTMLDivElement | null>(null);

  let resolvedTab: RightPanelTab = activeTab;
  if (resolvedTab === "browser" && !canShowBrowser) resolvedTab = "files";
  // The Runs tab only exists for scheduled-run chats; fall back otherwise.
  if (resolvedTab === "runs" && !scheduledRun) resolvedTab = "files";

  // Activate the portal target only while the Apps tab is showing — when the
  // user switches to artifact/browser or closes the panel, the app falls back
  // to inline rendering in the chat.
  useEffect(() => {
    const shouldHostApp = isOpen && resolvedTab === "apps";
    setPortalTarget(shouldHostApp ? portalDivRef.current : null);
    return () => {
      setPortalTarget(null);
    };
  }, [isOpen, resolvedTab, setPortalTarget]);

  if (!isOpen) {
    return null;
  }

  return (
    <ResizableRightPanel>
      <Tabs
        value={resolvedTab}
        onValueChange={(value) => onTabChange(value as RightPanelTab)}
        className="flex-1 min-h-0 flex flex-col gap-0"
      >
        <div className="flex items-center gap-2 border-b px-2 py-2">
          {/* Tabs take the remaining space and scroll horizontally when the
              panel is too narrow, so the action buttons on the right are never
              clipped. */}
          <div className="min-w-0 flex-1 overflow-x-auto">
            <TabsList className="h-8 w-max">
              {scheduledRun && (
                <TabsTrigger value="runs" className="text-xs px-3">
                  <CalendarClock className="h-3 w-3" />
                  Runs
                </TabsTrigger>
              )}
              <TabsTrigger value="files" className="text-xs px-3">
                <FileText className="h-3 w-3" />
                Files
              </TabsTrigger>
              {canShowBrowser && (
                <TabsTrigger value="browser" className="text-xs px-3">
                  <Globe className="h-3 w-3" />
                  Browser
                </TabsTrigger>
              )}
              <TabsTrigger value="apps" className="text-xs px-3">
                <AppWindow className="h-3 w-3" />
                Apps
              </TabsTrigger>
            </TabsList>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => {
                // Collapsing the panel drops the owned-app settings form so it
                // reopens on the live app, not the form.
                setSettingsOpen(false);
                onClose();
              }}
              title="Close panel"
            >
              <PanelRightClose className="h-4 w-4" />
              <span className="sr-only">Close panel</span>
            </Button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-hidden relative">
          {resolvedTab === "runs" && scheduledRun && (
            <RunsPanel
              triggerId={scheduledRun.triggerId}
              currentRunId={scheduledRun.runId}
              projectId={projectId ?? null}
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
          {/* Apps tab content: portal target. The app-switcher lives in the
              hosted card's header (see McpAppCard), so the panel only provides
              the portal mount + empty state here. */}
          {resolvedTab === "apps" && (
            <div className="flex flex-col h-full">
              <div ref={portalDivRef} className="flex-1 min-h-0 relative">
                {apps.length === 0 && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-center text-xs text-muted-foreground px-6">
                    <AppWindow className="h-6 w-6 mb-2 opacity-50" />
                    <p className="font-medium">No Apps in this chat</p>
                    <p className="mt-1">
                      Apps from tool calls in this conversation will appear
                      here.
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </Tabs>
    </ResizableRightPanel>
  );
}

// Per-schedule runs-list scroll position. Selecting a run swaps the chat to the
// run's conversation; the page re-renders (and the panel can remount), which
// resets the list to the top. Remembering scrollTop here (module scope survives
// both) lets us restore it so the list stays where you left it after picking a run.
const runsScrollTopByTrigger = new Map<string, number>();

/** The Runs tab content: the schedule's runs, with the current run highlighted. */
function RunsPanel({
  triggerId,
  currentRunId,
  projectId,
}: {
  triggerId: string;
  currentRunId: string | null;
  projectId: string | null;
}) {
  const { data: trigger } = useScheduleTrigger(triggerId);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Restore the saved scroll position whenever the panel (re)mounts OR the
  // selected run changes — selecting a run re-renders without remounting, so a
  // mount-only effect would miss it. Restore before paint, then re-assert next
  // frame in case the reset lands a frame late (content relayout).
  // biome-ignore lint/correctness/useExhaustiveDependencies: currentRunId is a deliberate re-run trigger (restore on run selection), not read in the body.
  useLayoutEffect(() => {
    const saved = runsScrollTopByTrigger.get(triggerId);
    if (saved == null) {
      return;
    }
    if (scrollRef.current) {
      scrollRef.current.scrollTop = saved;
    }
    const raf = requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = saved;
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [triggerId, currentRunId]);

  if (!projectId) {
    return (
      <div className="p-4 text-xs text-muted-foreground">
        Runs are available for project schedules.
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={(e) => {
        runsScrollTopByTrigger.set(triggerId, e.currentTarget.scrollTop);
      }}
      className="flex h-full flex-col overflow-y-auto p-3"
    >
      <div className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Runs · {trigger?.name ?? "Schedule"}
      </div>
      <ScheduleRunsList triggerId={triggerId} currentRunId={currentRunId} />
    </div>
  );
}
