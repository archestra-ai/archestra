"use client";

import type { UIMessage } from "@ai-sdk/react";
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
import { cn } from "@/lib/utils";

interface BrowserPreviewContentProps {
  conversationId: string | undefined;
  isActive: boolean;
  /** Chat messages for syncing browser state */
  chatMessages?: UIMessage[];
  /** Setter for chat messages */
  setChatMessages?: (messages: UIMessage[]) => void;
  /** Extra buttons to render in the header (e.g., open in new window, close) */
  headerActions?: React.ReactNode;
  /** Additional class names for the container */
  className?: string;
}

export function BrowserPreviewContent({
  conversationId,
  isActive,
  chatMessages,
  setChatMessages,
  headerActions,
  className,
}: BrowserPreviewContentProps) {
  const [typeText, setTypeText] = useState("");
  const imageRef = useRef<HTMLImageElement>(null);

  const {
    screenshot,
    urlInput,
    isConnected,
    isConnecting,
    isNavigating,
    isInteracting,
    error,
    navigate,
    navigateBack,
    click,
    type,
    pressKey,
    setUrlInput,
    setIsEditingUrl,
  } = useBrowserStream({
    conversationId,
    isActive,
    chatMessages,
    setChatMessages,
  });

  const handleNavigate = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      navigate(urlInput);
    },
    [urlInput, navigate],
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
      if (!img) return;

      const imgRect = img.getBoundingClientRect();
      const naturalRatio = img.naturalWidth / img.naturalHeight;
      const containerRatio = imgRect.width / imgRect.height;

      let renderedWidth: number;
      let renderedHeight: number;
      let offsetX = 0;
      const offsetY = 0;

      // With object-contain object-top, we need to calculate offsets
      // - No vertical offset needed (image aligns to top via object-top)
      // - Horizontal offset needed when image is narrower than container (letterboxed on sides)
      if (naturalRatio > containerRatio) {
        // Image is wider than container - fits width, letterboxed top/bottom
        // With object-top, image starts at top, so no offsetY needed
        renderedWidth = imgRect.width;
        renderedHeight = imgRect.width / naturalRatio;
      } else {
        // Image is taller than container - fits height, letterboxed left/right
        // Image is centered horizontally, so we need offsetX
        renderedHeight = imgRect.height;
        renderedWidth = imgRect.height * naturalRatio;
        offsetX = (imgRect.width - renderedWidth) / 2;
      }

      const clickX = e.clientX - imgRect.left - offsetX;
      const clickY = e.clientY - imgRect.top - offsetY;

      if (
        clickX < 0 ||
        clickX > renderedWidth ||
        clickY < 0 ||
        clickY > renderedHeight
      ) {
        return;
      }

      const scaleX = img.naturalWidth / renderedWidth;
      const scaleY = img.naturalHeight / renderedHeight;
      const x = clickX * scaleX;
      const y = clickY * scaleY;

      click(x, y);
    },
    [isConnected, isInteracting, click],
  );

  return (
    <div className={cn("flex flex-col bg-background h-full", className)}>
      {/* Header */}
      <div className="flex flex-col gap-2 p-2 bg-muted/50 border-b">
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

        {/* URL input */}
        <form onSubmit={handleNavigate} className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-7 w-7 flex-shrink-0"
            onClick={navigateBack}
            disabled={isNavigating || !isConnected}
            title="Go back"
          >
            <ArrowLeft className="h-3 w-3" />
          </Button>
          <Input
            type="text"
            placeholder="Enter URL..."
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onFocus={() => setIsEditingUrl(true)}
            className="h-7 text-xs"
            disabled={isNavigating || !isConnected}
          />
          <Button
            type="submit"
            size="sm"
            className="h-7 px-3 text-xs"
            disabled={isNavigating || !urlInput.trim() || !isConnected}
          >
            {isNavigating ? <Loader2 className="h-3 w-3 animate-spin" /> : "Go"}
          </Button>
        </form>
      </div>

      {/* Error display */}
      {error && (
        <div className="text-xs text-destructive bg-destructive/10 border-b border-destructive/20 px-2 py-1">
          {error}
        </div>
      )}

      {/* Content - Screenshot with clickable overlay */}
      <div className="flex-1 overflow-auto bg-muted min-h-0 relative">
        {isConnecting && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center space-y-2">
              <div className="animate-pulse">
                <Globe className="h-12 w-12 text-muted-foreground mx-auto" />
              </div>
              <p className="text-sm text-muted-foreground">Connecting...</p>
            </div>
          </div>
        )}
        {!isConnecting && screenshot && (
          <div className="relative w-full h-full bg-black/60">
            <img
              ref={imageRef}
              src={screenshot}
              alt="Browser screenshot"
              className="block w-full h-full object-contain"
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
            <div className="text-center space-y-2">
              <Globe className="h-12 w-12 text-muted-foreground mx-auto" />
              <p className="text-sm text-muted-foreground">
                Enter a URL above to start browsing
              </p>
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
