"use client";

import type { archestraApiTypes } from "@archestra/shared";
import {
  AppWindow,
  CalendarClock,
  Download,
  FileText,
  FolderPlus,
  Globe,
  MoreHorizontal,
  MoreVertical,
  Share2,
  Users,
} from "lucide-react";
import Link from "next/link";
import { AgentIcon } from "@/components/agent-icon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TruncatedTooltip } from "@/components/ui/truncated-tooltip";
import { TypingText } from "@/components/ui/typing-text";
import { getConversationDisplayTitle } from "@/lib/chat/chat-utils";
import { useProject } from "@/lib/projects/projects.query";
import { useScheduleTrigger } from "@/lib/schedule-trigger.query";
import { cn } from "@/lib/utils";
import type { RightPanelTab } from "./right-side-panel";

type Conversation = archestraApiTypes.GetChatConversationResponses["200"];

/** Right-panel state + handlers the header needs to drive open/close/tab. */
interface PanelControls {
  isOpen: boolean;
  /** The tab currently selected (highlighted even while the panel is collapsed). */
  activeTab: RightPanelTab;
  /** Set for scheduled-run chats — enables the Runs tab. */
  scheduledRun: { triggerId: string; runId: string | null } | null;
  isArtifactOpen: boolean;
  isBrowserVisible: boolean;
  showBrowserButton: boolean;
  isPlaywrightSetupVisible: boolean;
  onClose: () => void;
  onOpenTab: (tab: RightPanelTab) => void;
}

interface ConversationHeaderProps {
  conversationId: string | undefined;
  conversation: Conversation | null | undefined;
  messageCount: number;
  /** Whether the title is mid-animation — skips the resize-measuring tooltip. */
  isTitleAnimating: boolean;
  canManageShare: boolean;
  isShared: boolean;
  /** Whether this chat is eligible to be turned into a project. */
  canCreateProject: boolean;
  /**
   * When this chat was opened from a scheduled task, its trigger id — renders a
   * non-clickable "scheduled task" breadcrumb segment for orientation.
   */
  scheduleTriggerId?: string | null;
  onShare: () => void;
  onExportMarkdown: () => void;
  onCreateProject: () => void;
  panel: PanelControls;
}

export function ConversationHeader({
  conversationId,
  conversation,
  messageCount,
  isTitleAnimating,
  canManageShare,
  isShared,
  canCreateProject,
  scheduleTriggerId,
  onShare,
  onExportMarkdown,
  onCreateProject,
  panel,
}: ConversationHeaderProps) {
  const actionsProps = {
    canManageShare,
    isShared,
    canCreateProject,
    messageCount,
    onShare,
    onExportMarkdown,
    onCreateProject,
  };

  // Which tab is highlighted — mirror the panel's fallbacks so the strip never
  // highlights a tab the panel can't actually show.
  const canShowBrowser =
    panel.showBrowserButton && !panel.isPlaywrightSetupVisible;
  let resolvedTab: RightPanelTab = panel.activeTab;
  if (resolvedTab === "browser" && !canShowBrowser) resolvedTab = "files";
  if (resolvedTab === "runs" && !panel.scheduledRun) resolvedTab = "files";

  // Radix Tabs flip the active tab on mousedown (before onClick), so detect a
  // click on the ALREADY-active tab here, where resolvedTab is still pre-click:
  // active + open collapses, active + collapsed opens. A different tab is left
  // to onValueChange, which switches. Left button only (mirrors Radix's guard).
  const handleTabMouseDown = (tab: RightPanelTab) => (e: React.MouseEvent) => {
    if (e.button !== 0 || e.ctrlKey) return;
    if (resolvedTab !== tab) return;
    if (panel.isOpen) panel.onClose();
    else panel.onOpenTab(tab);
  };

  return (
    <div
      className={cn(
        "sticky top-0 z-10 bg-background border-b p-2",
        !conversationId && "hidden",
      )}
    >
      <div className="relative flex min-h-8 items-center justify-between gap-2">
        {/* Left side - conversation title + actions */}
        <div className="flex items-center gap-1 min-w-0">
          {conversationId && conversation && (
            <div className="flex items-center flex-shrink min-w-0 gap-1">
              {/* Project chats read as "{ProjectName}/{Chat title}" — the
                  project segment (emoji + name, like the sidebar) links to the
                  project. Hidden for viewers without project access. */}
              {conversation.projectId && (
                <ProjectTitlePrefix projectId={conversation.projectId} />
              )}
              {/* Non-clickable "scheduled task" segment (orientation only) when
                  this chat was opened from a schedule's run. */}
              {scheduleTriggerId && (
                <ScheduledTaskPrefix triggerId={scheduleTriggerId} />
              )}
              {/* Skip TruncatedTooltip while the title animates: its resize
                  measurement re-renders on every TypingText tick, which loops
                  past React's nested-update cap. */}
              {isTitleAnimating ? (
                <h1 className="text-base font-normal text-muted-foreground truncate max-w-[360px] cursor-default">
                  <TypingText
                    text={getConversationDisplayTitle(
                      conversation.title,
                      conversation.messages,
                    )}
                    typingSpeed={35}
                    showCursor
                    cursorClassName="bg-muted-foreground"
                  />
                </h1>
              ) : (
                <TruncatedTooltip
                  content={getConversationDisplayTitle(
                    conversation.title,
                    conversation.messages,
                  )}
                >
                  <h1 className="text-base font-normal text-muted-foreground truncate max-w-[360px] cursor-default">
                    {getConversationDisplayTitle(
                      conversation.title,
                      conversation.messages,
                    )}
                  </h1>
                </TruncatedTooltip>
              )}
            </div>
          )}
          {/* Desktop: chat actions (Share / Export) next to the title */}
          {conversationId && messageCount > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="hidden md:inline-flex h-7 w-7 flex-shrink-0"
                  title="Chat actions"
                >
                  <MoreHorizontal className="h-4 w-4" />
                  <span className="sr-only">Chat actions</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <ChatActionItems {...actionsProps} />
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {/* Right side - desktop: the Files / Browser / Apps tab strip is always
            visible (open or collapsed) so it never moves. Clicking a different
            tab switches; clicking the already-open tab collapses the panel —
            there is no separate collapse button. */}
        <div className="hidden md:flex items-center flex-shrink-0">
          <Tabs
            value={resolvedTab}
            onValueChange={(value) => {
              // Radix fires this on every mousedown, even on the active tab —
              // guard so it only switches on a real change and never reopens
              // right after handleTabMouseDown collapses the panel. Keyboard
              // activation flows through here too.
              const tab = value as RightPanelTab;
              if (tab !== resolvedTab) panel.onOpenTab(tab);
            }}
          >
            <TabsList className="h-8">
              {panel.scheduledRun && (
                <TabsTrigger
                  value="runs"
                  className="text-xs px-3"
                  onMouseDown={handleTabMouseDown("runs")}
                >
                  <CalendarClock className="h-3 w-3" />
                  Runs
                </TabsTrigger>
              )}
              <TabsTrigger
                value="files"
                className="text-xs px-3"
                onMouseDown={handleTabMouseDown("files")}
              >
                <FileText className="h-3 w-3" />
                Files
              </TabsTrigger>
              {panel.showBrowserButton && (
                <TabsTrigger
                  value="browser"
                  className="text-xs px-3"
                  disabled={panel.isPlaywrightSetupVisible}
                  onMouseDown={handleTabMouseDown("browser")}
                >
                  <Globe className="h-3 w-3" />
                  Browser
                </TabsTrigger>
              )}
              <TabsTrigger
                value="apps"
                className="text-xs px-3"
                onMouseDown={handleTabMouseDown("apps")}
              >
                <AppWindow className="h-3 w-3" />
                Apps
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        {/* Right side - mobile: 3-dot dropdown */}
        <div className="flex md:hidden items-center gap-2 flex-shrink-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                title="More options"
              >
                <MoreVertical className="h-4 w-4" />
                <span className="sr-only">More options</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <ChatActionItems {...actionsProps} />
              <DropdownMenuItem
                onSelect={() => {
                  if (panel.isArtifactOpen) {
                    panel.onClose();
                  } else {
                    panel.onOpenTab("files");
                  }
                }}
              >
                <FileText className="h-4 w-4" />
                {panel.isArtifactOpen ? "Hide Files" : "Show Files"}
              </DropdownMenuItem>
              {panel.showBrowserButton && (
                <DropdownMenuItem
                  onSelect={() => {
                    if (panel.isBrowserVisible) {
                      panel.onClose();
                    } else {
                      panel.onOpenTab("browser");
                    }
                  }}
                  disabled={panel.isPlaywrightSetupVisible}
                >
                  <Globe className="h-4 w-4" />
                  {panel.isBrowserVisible ? "Hide Browser" : "Show Browser"}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}

/**
 * Clickable "{emoji ProjectName} /" segment shown before the chat title when a
 * conversation belongs to a project. Fetches the project so the emoji matches
 * the sidebar; renders nothing while loading or when the viewer can't read the
 * project (the query resolves to null on a not-found, so no error surfaces).
 */
// A non-clickable breadcrumb segment naming the schedule this chat's run belongs
// to (calendar glyph + schedule name), for orientation only. Mirrors
// ProjectTitlePrefix but is a plain span — no navigation.
function ScheduledTaskPrefix({ triggerId }: { triggerId: string }) {
  const { data: trigger } = useScheduleTrigger(triggerId);

  if (!trigger) {
    return null;
  }

  return (
    <>
      <span
        title={`Scheduled task: ${trigger.name}`}
        className="flex items-center gap-1 min-w-0 max-w-[180px] text-base font-normal text-muted-foreground cursor-default"
      >
        <CalendarClock className="h-4 w-4 shrink-0" aria-hidden />
        <span className="truncate">{trigger.name}</span>
      </span>
      <span className="text-muted-foreground/50 select-none" aria-hidden="true">
        /
      </span>
    </>
  );
}

function ProjectTitlePrefix({ projectId }: { projectId: string }) {
  const { data: project } = useProject(projectId);

  if (!project) {
    return null;
  }

  return (
    <>
      <Link
        href={`/projects/${projectId}`}
        title={project.name}
        className="flex items-center gap-1 min-w-0 max-w-[180px] text-base font-normal text-muted-foreground transition-colors hover:text-foreground"
      >
        <AgentIcon icon={project.icon} fallbackType="project" size={16} />
        <span className="truncate">{project.name}</span>
      </Link>
      <span className="text-muted-foreground/50 select-none" aria-hidden="true">
        /
      </span>
    </>
  );
}

/** Share / Export / Create project menu items, shared by desktop + mobile menus. */
function ChatActionItems({
  canManageShare,
  isShared,
  canCreateProject,
  messageCount,
  onShare,
  onExportMarkdown,
  onCreateProject,
}: {
  canManageShare: boolean;
  isShared: boolean;
  canCreateProject: boolean;
  messageCount: number;
  onShare: () => void;
  onExportMarkdown: () => void;
  onCreateProject: () => void;
}) {
  return (
    <>
      {canManageShare && (
        <DropdownMenuItem onSelect={onShare}>
          {isShared ? (
            <>
              <Users className="h-4 w-4 text-primary" />
              <span className="text-primary">Shared</span>
            </>
          ) : (
            <>
              <Share2 className="h-4 w-4" />
              Share
            </>
          )}
        </DropdownMenuItem>
      )}
      {canCreateProject && (
        <DropdownMenuItem onSelect={onCreateProject}>
          <FolderPlus className="h-4 w-4" />
          Create project
        </DropdownMenuItem>
      )}
      {messageCount > 0 && (
        <DropdownMenuItem onSelect={onExportMarkdown}>
          <Download className="h-4 w-4" />
          Export Markdown
        </DropdownMenuItem>
      )}
    </>
  );
}
