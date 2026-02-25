"use client";

import {
  DEFAULT_BROWSER_PREVIEW_VIEWPORT_HEIGHT,
  DEFAULT_BROWSER_PREVIEW_VIEWPORT_WIDTH,
} from "@shared";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Globe,
  Keyboard,
  Loader2,
  Type,
} from "lucide-react";
import {
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { useBrowserStream } from "@/hooks/use-browser-stream";
import { useConversation, useHasPlaywrightMcpTools } from "@/lib/chat.query";
import { cn } from "@/lib/utils";
import { LoadingSpinner } from "../loading";

interface BrowserPreviewContentProps {
  conversationId: string | undefined;
  isActive: boolean;
  /** Extra buttons to render in the header (e.g., open in new window, close) */
  headerActions?: React.ReactNode;
  /** Additional class names for the container */
  className?: string;
  /** Fallback agentId for pre-conversation case when conversationId is undefined */
  agentId?: string;
  /** When true, this is a popup that follows the active conversation */
  isPopup?: boolean;
  /** Called when user enters a URL without a conversation - should create conversation and navigate */
  onCreateConversationWithUrl?: (url: string) => void;
  /** Whether conversation creation is in progress */
  isCreatingConversation?: boolean;
  /** URL to navigate to once connected (after conversation creation) */
  initialNavigateUrl?: string;
  /** Called after initial navigation is triggered */
  onInitialNavigateComplete?: () => void;
}

export function BrowserPreviewContent({
  conversationId,
  isActive,
  headerActions,
  className,
  agentId: agentIdProp,
  isPopup = false,
  onCreateConversationWithUrl,
  isCreatingConversation = false,
  initialNavigateUrl,
  onInitialNavigateComplete,
}: BrowserPreviewContentProps) {
  // Resolve agentId: prefer conversation's agentId, fall back to prop
  const { data: conversation } = useConversation(conversationId);
  const resolvedAgentId = conversation?.agentId ?? agentIdProp;

  const {
    hasPlaywrightMcpTools,
    isPlaywrightInstalledByCurrentUser,
    reinstallRequired,
    installationFailed,
    playwrightServerId,
    isInstalling: isInstallingBrowser,
    isAssigningTools,
    installBrowser,
    reinstallBrowser,
    assignToolsToAgent,
  } = useHasPlaywrightMcpTools(resolvedAgentId, conversationId);
  const [typeText, setTypeText] = useState("");
  const imageRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const initialNavigateTriggeredRef = useRef(false);

  const {
    screenshot,
    urlInput,
    isConnected,
    isConnecting,
    isNavigating,
    isInteracting,
    error,
    canGoBack,
    navigate,
    navigateBack,
    click,
    type,
    pressKey,
    setUrlInput,
    setIsEditingUrl,
  } = useBrowserStream({
    conversationId,
    isActive: isActive && hasPlaywrightMcpTools,
    isPopup,
    initialUrl: initialNavigateUrl,
  });

  const handleNavigate = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      if (!urlInput.trim()) return;

      // Normalize URL
      let normalizedUrl = urlInput.trim();
      if (
        !normalizedUrl.startsWith("http://") &&
        !normalizedUrl.startsWith("https://")
      ) {
        normalizedUrl = `https://${normalizedUrl}`;
      }

      if (conversationId) {
        // Has conversation - navigate directly
        navigate(normalizedUrl);
      } else if (onCreateConversationWithUrl) {
        // No conversation - create one and navigate
        onCreateConversationWithUrl(normalizedUrl);
      }
    },
    [urlInput, conversationId, navigate, onCreateConversationWithUrl],
  );

  const handleType = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      if (!typeText) return;
      type(typeText);
      setTypeText("");
    },
    [typeText, type],
  );

  const handleImageClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (!isConnected || isInteracting) return;

      const img = imageRef.current;
      const container = containerRef.current;
      if (!img || !container) return;

      const containerRect = container.getBoundingClientRect();

      // Fixed viewport dimensions (backend always uses these)
      const viewportW = DEFAULT_BROWSER_PREVIEW_VIEWPORT_WIDTH;
      const viewportH = DEFAULT_BROWSER_PREVIEW_VIEWPORT_HEIGHT;

      // Calculate how the image is displayed with object-contain
      // Scale is determined by whichever dimension constrains the fit
      const scaleX = containerRect.width / viewportW;
      const scaleY = containerRect.height / viewportH;
      const scale = Math.min(scaleX, scaleY);

      // Actual displayed image size
      const displayedW = viewportW * scale;
      const displayedH = viewportH * scale;

      // Offset from container edges (centering - object-contain centers by default)
      const offsetX = (containerRect.width - displayedW) / 2;
      const offsetY = (containerRect.height - displayedH) / 2;

      // Click position relative to container
      const clickX = e.clientX - containerRect.left;
      const clickY = e.clientY - containerRect.top;

      // Convert to image-relative coordinates (accounting for letterboxing)
      const imageClickX = clickX - offsetX;
      const imageClickY = clickY - offsetY;

      // Check if click is within the actual image area (not in letterboxing)
      if (
        imageClickX < 0 ||
        imageClickX > displayedW ||
        imageClickY < 0 ||
        imageClickY > displayedH
      ) {
        return;
      }

      // Convert to viewport coordinates
      const x = imageClickX / scale;
      const y = imageClickY / scale;

      click(x, y);
    },
    [isConnected, isInteracting, click],
  );

  // Clear initial URL state once connected (backend handles initial navigation via subscription)
  useEffect(() => {
    if (
      initialNavigateUrl &&
      isConnected &&
      conversationId &&
      !initialNavigateTriggeredRef.current
    ) {
      initialNavigateTriggeredRef.current = true;
      onInitialNavigateComplete?.();
    }
  }, [
    initialNavigateUrl,
    isConnected,
    conversationId,
    onInitialNavigateComplete,
  ]);

  // Reset the trigger ref when conversationId changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally reset ref when conversationId changes
  useEffect(() => {
    initialNavigateTriggeredRef.current = false;
  }, [conversationId]);

  return (
    <div
      className={cn(
        "flex flex-col bg-background h-full overflow-hidden",
        className,
      )}
    >
      {/* Header */}
      <div className="flex flex-col px-2 py-3 border-b">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs font-medium">Browser Preview</span>
            {isConnected && (
              <span
                className="w-2 h-2 rounded-full bg-green-500"
                title="Connected"
              />
            )}
          </div>
          <div className="flex items-center gap-1">
            {/* Type tool */}
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  disabled={!isConnected || isInteracting}
                  title="Type text into focused input"
                >
                  <Type className="h-3 w-3" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-64" align="end">
                <form onSubmit={handleType} className="space-y-2">
                  <div className="text-xs font-medium">
                    Type into focused input
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Click on an input field first, then type here
                  </p>
                  <Textarea
                    placeholder="Text to type..."
                    value={typeText}
                    onChange={(e) => setTypeText(e.target.value)}
                    className="text-xs min-h-[60px]"
                    autoFocus
                  />
                  <Button
                    type="submit"
                    size="sm"
                    className="w-full h-7 text-xs"
                    disabled={!typeText}
                  >
                    Type
                  </Button>
                </form>
              </PopoverContent>
            </Popover>

            {/* Keyboard tool */}
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  disabled={!isConnected || isInteracting}
                  title="Press key"
                >
                  <Keyboard className="h-3 w-3" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-48" align="end">
                <div className="space-y-2">
                  <div className="text-xs font-medium">Press Key</div>
                  <div className="grid grid-cols-2 gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => pressKey("Enter")}
                    >
                      Enter
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => pressKey("Tab")}
                    >
                      Tab
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => pressKey("Escape")}
                    >
                      Escape
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => pressKey("Backspace")}
                    >
                      Backspace
                    </Button>
                  </div>
                </div>
              </PopoverContent>
            </Popover>

            {/* Scroll buttons */}
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => pressKey("PageUp")}
              disabled={!isConnected || isInteracting}
              title="Scroll up"
            >
              <ChevronUp className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => pressKey("PageDown")}
              disabled={!isConnected || isInteracting}
              title="Scroll down"
            >
              <ChevronDown className="h-3 w-3" />
            </Button>

            {/* Extra header actions (open in new window, close, etc.) */}
            {headerActions}
          </div>
        </div>
        <div className="border-b pb-3 w-[120%] -translate-x-[10%] translate-y-[-1px]" />
        {/* URL input */}
        <form onSubmit={handleNavigate} className="flex gap-2 mt-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-7 w-7 flex-shrink-0"
            onClick={navigateBack}
            disabled={isNavigating || !isConnected || !canGoBack}
            title="Go back"
          >
            <ArrowLeft className="h-3 w-3" />
          </Button>
          <Input
            type="text"
            placeholder="Enter URL..."
            value={urlInput}
            onChange={(e) => {
              setIsEditingUrl(true);
              setUrlInput(e.target.value);
            }}
            onFocus={() => setIsEditingUrl(true)}
            className="h-7 text-xs!"
            disabled={isNavigating || isCreatingConversation}
          />
          <Button
            type="submit"
            size="sm"
            className="h-7 px-3 text-xs"
            disabled={
              isNavigating ||
              isCreatingConversation ||
              !urlInput.trim() ||
              (!conversationId && !onCreateConversationWithUrl)
            }
          >
            {isNavigating || isCreatingConversation ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              "Go"
            )}
          </Button>
        </form>
      </div>

      {/* Error display - hidden when reinstall is required since the reinstall UI handles it */}
      {error && !reinstallRequired && (
        <div className="text-xs text-destructive bg-destructive/10 border-b border-destructive/20 px-2 py-1">
          {error}
        </div>
      )}

      {/* Content - Screenshot with clickable overlay */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden min-h-0 relative"
      >
        {isConnecting && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center space-y-2 mt-20">
              <LoadingSpinner />
              <p className="text-sm text-muted-foreground">Connecting...</p>
            </div>
          </div>
        )}
        {!isConnecting && screenshot && (
          <div className="relative w-full h-full">
            <img
              ref={imageRef}
              src={screenshot}
              alt="Browser screenshot"
              className="block w-full h-full object-contain object-top"
            />
            {/* Clickable overlay */}
            {/* biome-ignore lint/a11y/useSemanticElements: Need div for absolute positioning overlay */}
            <div
              className="absolute inset-0 cursor-pointer"
              onClick={handleImageClick}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                }
              }}
              role="button"
              tabIndex={0}
              aria-label="Click to interact with browser"
            />
          </div>
        )}
        {!isConnecting && !screenshot && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center space-y-4">
              {(isInstallingBrowser || isAssigningTools) &&
              !hasPlaywrightMcpTools ? (
                // Installing or assigning in progress - show unified loading
                <>
                  <Button disabled className="mt-10">
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    {isAssigningTools ? "Assigning tools" : "Installing"}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    {isAssigningTools
                      ? "Assigning Playwright tools to the agent"
                      : "Required only before first usage of the Browser Preview"}
                  </p>
                </>
              ) : !isPlaywrightInstalledByCurrentUser && !installationFailed ? (
                // Not installed at all - show install button
                <>
                  <Button
                    onClick={() =>
                      resolvedAgentId && installBrowser(resolvedAgentId)
                    }
                    disabled={!resolvedAgentId || isInstallingBrowser}
                    className="mt-10"
                  >
                    {isInstallingBrowser ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Installing
                      </>
                    ) : (
                      "Install Browser"
                    )}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Required only before first usage of the Browser Preview
                  </p>
                </>
              ) : !hasPlaywrightMcpTools &&
                !reinstallRequired &&
                !installationFailed ? (
                // Installed but tools not assigned to current agent
                <>
                  <Button
                    onClick={() =>
                      resolvedAgentId &&
                      assignToolsToAgent({
                        agentId: resolvedAgentId,
                        conversationId,
                      })
                    }
                    disabled={!resolvedAgentId}
                    className="mt-10"
                  >
                    Assign tools to agent
                  </Button>
                  <p className="text-xs text-muted-foreground max-w-[280px]">
                    In order to use Browser Preview, Playwright tools need to be
                    assigned to the agent
                  </p>
                </>
              ) : reinstallRequired || installationFailed ? (
                // Installed but needs reinstall due to config change
                <>
                  <Button
                    onClick={() =>
                      playwrightServerId && reinstallBrowser(playwrightServerId)
                    }
                    disabled={isInstallingBrowser || !playwrightServerId}
                    className="mt-10"
                  >
                    {isInstallingBrowser ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Reinstalling
                      </>
                    ) : (
                      "Reinstall Browser"
                    )}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    {installationFailed
                      ? "Browser installation failed. Click to retry."
                      : "Browser configuration has been updated and requires reinstallation"}
                  </p>
                </>
              ) : (
                // Installed - show normal empty state
                <>
                  <Globe className="h-10 w-10 xs text-muted-foreground mx-auto mt-14" />
                  <p className="text-sm text-muted-foreground">
                    Ready to browse
                  </p>
                </>
              )}
            </div>
          </div>
        )}

        {/* Loading overlay */}
        {isInteracting && (
          <div className="absolute inset-0 bg-black/20 flex items-center justify-center pointer-events-none">
            <Loader2 className="h-8 w-8 animate-spin text-white" />
          </div>
        )}
      </div>
    </div>
  );
}
