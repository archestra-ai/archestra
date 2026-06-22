"use client";

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
import type { RightPanelTab } from "@/components/chat/right-side-panel";
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
import { useIsMobile } from "@/lib/hooks/use-mobile";
import { cn } from "@/lib/utils";

interface ChatTopBarConversation {
  id: string;
  title: string | null;
  // biome-ignore lint/suspicious/noExplicitAny: UIMessage structure from AI SDK is dynamic
  messages?: any[];
}

interface ChatTopBarProps {
  conversationId: string | undefined;
  conversation: ChatTopBarConversation | null | undefined;
  /** Conversation ids whose title is currently typing-animating in the header. */
  headerAnimatingTitles: Set<string>;
  isRightPanelOpen: boolean;
  /** The tab the right panel is currently showing. */
  activeTab: RightPanelTab;
  /** Whether the Browser tab is currently available for this agent. */
  canShowBrowser: boolean;
  onToggleRightPanel: () => void;
  /** Open the panel directly on a tab (used by the mobile menu). */
  onOpenTab: (tab: RightPanelTab) => void;
  onCloseRightPanel: () => void;

  // Actions menu
  canManageShare: boolean;
  isShared: boolean;
  /** True when there is a conversation with at least one message. */
  hasMessages: boolean;
  onShare: () => void;
  onExportMarkdown: () => void;
}

/**
 * Full-width chat top bar spanning the content area above the right panel.
 * Desktop: conversation title with a 3-dots actions menu (Share, Export) on the
 * left and the panel open/close toggle anchored on the right. Mobile: the title
 * with a single 3-dots menu on the right that holds the actions plus Show/Hide
 * Files and Show/Hide Browser, which open the inline panel straight to that tab.
 */
export function ChatTopBar({
  conversationId,
  conversation,
  headerAnimatingTitles,
  isRightPanelOpen,
  activeTab,
  canShowBrowser,
  onToggleRightPanel,
  onOpenTab,
  onCloseRightPanel,
  canManageShare,
  isShared,
  hasMessages,
  onShare,
  onExportMarkdown,
}: ChatTopBarProps) {
  const isMobile = useIsMobile();
  const hasActions = canManageShare || hasMessages;

  return (
    <header
      className={cn(
        "shrink-0 z-10 bg-background border-b h-12 px-2",
        !conversationId && "hidden",
      )}
    >
      <div className="relative flex h-full items-center justify-between gap-2">
        {/* Left - conversation title (+ desktop actions menu) */}
        {conversationId && conversation && (
          <div className="flex items-center gap-1 shrink min-w-0">
            {/* Skip TruncatedTooltip while the title animates: its resize
                measurement re-renders on every TypingText tick, which loops
                past React's nested-update cap. */}
            {headerAnimatingTitles.has(conversation.id) ? (
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

            {!isMobile && hasActions && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 flex-shrink-0"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                    <span className="sr-only">More options</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <ActionMenuItems
                    canManageShare={canManageShare}
                    isShared={isShared}
                    hasMessages={hasMessages}
                    onShare={onShare}
                    onExportMarkdown={onExportMarkdown}
                  />
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}

        {/* Right - desktop: panel toggle; mobile: actions + panel tabs menu */}
        {conversationId &&
          (isMobile ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 flex-shrink-0 -mr-2"
                  title="More options"
                >
                  <MoreVertical className="h-4 w-4" />
                  <span className="sr-only">More options</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <ActionMenuItems
                  canManageShare={canManageShare}
                  isShared={isShared}
                  hasMessages={hasMessages}
                  onShare={onShare}
                  onExportMarkdown={onExportMarkdown}
                />
                <DropdownMenuItem
                  onSelect={() => {
                    if (isRightPanelOpen && activeTab === "files") {
                      onCloseRightPanel();
                    } else {
                      onOpenTab("files");
                    }
                  }}
                >
                  <FileText className="h-4 w-4" />
                  {isRightPanelOpen && activeTab === "files"
                    ? "Hide Files"
                    : "Show Files"}
                </DropdownMenuItem>
                {canShowBrowser && (
                  <DropdownMenuItem
                    onSelect={() => {
                      if (isRightPanelOpen && activeTab === "browser") {
                        onCloseRightPanel();
                      } else {
                        onOpenTab("browser");
                      }
                    }}
                  >
                    <Globe className="h-4 w-4" />
                    {isRightPanelOpen && activeTab === "browser"
                      ? "Hide Browser"
                      : "Show Browser"}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            // Desktop: when the panel is open it hosts its own toggle in the
            // same spot, so hide this one to avoid a duplicate.
            !isRightPanelOpen && (
              <Button
                variant="ghost"
                size="icon"
                onClick={onToggleRightPanel}
                aria-pressed={isRightPanelOpen}
                title="Toggle panel"
                className="h-8 w-8 flex-shrink-0"
              >
                <PanelRight className="h-4 w-4" />
                <span className="sr-only">Toggle panel</span>
              </Button>
            )
          ))}
      </div>
    </header>
  );
}

function ActionMenuItems({
  canManageShare,
  isShared,
  hasMessages,
  onShare,
  onExportMarkdown,
}: {
  canManageShare: boolean;
  isShared: boolean;
  hasMessages: boolean;
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
      {hasMessages && (
        <DropdownMenuItem onSelect={onExportMarkdown}>
          <Download className="h-4 w-4" />
          Export conversation
        </DropdownMenuItem>
      )}
    </>
  );
}
