"use client";

import { FileText, Globe, MoreVertical, Share2, Users } from "lucide-react";
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

type HeaderConversation = {
  id: string;
  title: string | null;
  messages: unknown[];
};

export function ChatHeader({
  canManageShare,
  conversation,
  conversationId,
  headerAnimatingTitles,
  isArtifactOpen,
  isBrowserPanelOpen,
  isPlaywrightSetupVisible,
  isShared,
  onArtifactToggle,
  onBrowserToggle,
  onShareOpen,
  showBrowserButton,
}: {
  canManageShare: boolean;
  conversation: HeaderConversation | null | undefined;
  conversationId: string | undefined;
  headerAnimatingTitles: Set<string>;
  isArtifactOpen: boolean;
  isBrowserPanelOpen: boolean;
  isPlaywrightSetupVisible: boolean;
  isShared: boolean;
  onArtifactToggle: () => void;
  onBrowserToggle: () => void;
  onShareOpen: () => void;
  showBrowserButton: boolean;
}) {
  const title = conversation
    ? getConversationDisplayTitle(conversation.title, conversation.messages)
    : "";

  return (
    <div
      className={cn(
        "sticky top-0 z-10 bg-background border-b p-2",
        !conversationId && "hidden",
      )}
    >
      <div className="relative flex items-center justify-between gap-2">
        {conversationId && conversation && (
          <div className="flex items-center shrink min-w-0">
            <TruncatedTooltip content={title}>
              <h1 className="text-base font-normal text-muted-foreground truncate max-w-[360px] cursor-default">
                {headerAnimatingTitles.has(conversation.id) ? (
                  <TypingText
                    text={title}
                    typingSpeed={35}
                    showCursor
                    cursorClassName="bg-muted-foreground"
                  />
                ) : (
                  title
                )}
              </h1>
            </TruncatedTooltip>
          </div>
        )}

        <div className="hidden md:flex items-center gap-2 shrink-0">
          {canManageShare && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onShareOpen}
              className="text-xs"
            >
              {isShared ? (
                <>
                  <Users className="h-3 w-3 mr-1 text-primary" />
                  <span className="text-primary">Shared</span>
                </>
              ) : (
                <>
                  <Share2 className="h-3 w-3 mr-1" />
                  Share
                </>
              )}
            </Button>
          )}
          {canManageShare && <div className="w-px h-4 bg-border" />}
          <Button
            variant={isArtifactOpen ? "secondary" : "ghost"}
            size="sm"
            onClick={onArtifactToggle}
            className="text-xs"
          >
            <FileText className="h-3 w-3 mr-1" />
            Artifact
          </Button>

          {showBrowserButton && (
            <>
              <div className="w-px h-4 bg-border" />
              <Button
                variant={
                  isBrowserPanelOpen && !isPlaywrightSetupVisible
                    ? "secondary"
                    : "ghost"
                }
                size="sm"
                onClick={onBrowserToggle}
                className="text-xs"
                disabled={isPlaywrightSetupVisible}
              >
                <Globe className="h-3 w-3 mr-1" />
                Browser
              </Button>
            </>
          )}
        </div>

        <div className="flex md:hidden items-center gap-2 shrink-0">
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
              {canManageShare && (
                <DropdownMenuItem onSelect={onShareOpen}>
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
              <DropdownMenuItem onSelect={onArtifactToggle}>
                <FileText className="h-4 w-4" />
                {isArtifactOpen ? "Hide Artifact" : "Show Artifact"}
              </DropdownMenuItem>
              {showBrowserButton && (
                <DropdownMenuItem
                  onSelect={onBrowserToggle}
                  disabled={isPlaywrightSetupVisible}
                >
                  <Globe className="h-4 w-4" />
                  {isBrowserPanelOpen && !isPlaywrightSetupVisible
                    ? "Hide Browser"
                    : "Show Browser"}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}
