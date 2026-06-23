"use client";

import type { archestraApiTypes } from "@archestra/shared";
import {
  Download,
  FileText,
  Globe,
  MoreHorizontal,
  MoreVertical,
  PanelRight,
  Share2,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TruncatedTooltip } from "@/components/ui/truncated-tooltip";
import { TypingText } from "@/components/ui/typing-text";
import { getConversationDisplayTitle } from "@/lib/chat/chat-utils";
import { cn } from "@/lib/utils";
import type { RightPanelTab } from "./right-side-panel";

type Conversation = archestraApiTypes.GetChatConversationResponses["200"];

/** Right-panel state + handlers the header needs to drive open/close/tab. */
interface PanelControls {
  isOpen: boolean;
  isArtifactOpen: boolean;
  isBrowserVisible: boolean;
  showBrowserButton: boolean;
  isPlaywrightSetupVisible: boolean;
  onToggle: () => void;
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
  onShare: () => void;
  onExportMarkdown: () => void;
  panel: PanelControls;
}

export function ConversationHeader({
  conversationId,
  conversation,
  messageCount,
  isTitleAnimating,
  canManageShare,
  isShared,
  onShare,
  onExportMarkdown,
  panel,
}: ConversationHeaderProps) {
  const actionsProps = {
    canManageShare,
    isShared,
    messageCount,
    onShare,
    onExportMarkdown,
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
            <div className="flex items-center flex-shrink min-w-0">
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
        {/* Right side - desktop: open panel (hidden while open; the panel's own
            close button is the only way to close it) */}
        {!panel.isOpen && (
          <div className="hidden md:flex items-center gap-2 flex-shrink-0">
            <Button
              variant="ghost"
              size="icon"
              onClick={panel.onToggle}
              className="h-8 w-8"
              title="Open panel"
            >
              <PanelRight className="h-4 w-4" />
              <span className="sr-only">Open panel</span>
            </Button>
          </div>
        )}
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

/** Share + Export Markdown menu items, shared by the desktop and mobile menus. */
function ChatActionItems({
  canManageShare,
  isShared,
  messageCount,
  onShare,
  onExportMarkdown,
}: {
  canManageShare: boolean;
  isShared: boolean;
  messageCount: number;
  onShare: () => void;
  onExportMarkdown: () => void;
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
      {messageCount > 0 && (
        <DropdownMenuItem onSelect={onExportMarkdown}>
          <Download className="h-4 w-4" />
          Export Markdown
        </DropdownMenuItem>
      )}
    </>
  );
}
