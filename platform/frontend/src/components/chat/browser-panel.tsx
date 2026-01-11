"use client";

import type { UIMessage } from "@ai-sdk/react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Globe,
  GripVertical,
  Keyboard,
  Loader2,
  Maximize2,
  Minimize2,
  Type,
  X,
  ZoomIn,
  ZoomOut,
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
import { useChatSession } from "@/contexts/global-chat-context";
import { cn } from "@/lib/utils";
import websocketService from "@/lib/websocket";

interface BrowserPanelProps {
  isOpen: boolean;
  onClose: () => void;
  conversationId: string | undefined;
}

// Fixed size for the browser viewport (matches typical browser dimensions)
const PANEL_WIDTH = 800;
const PANEL_HEIGHT = 600;

export function BrowserPanel({
  isOpen,
  onClose,
  conversationId,
}: BrowserPanelProps) {
  const [isMaximized, setIsMaximized] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState<string>("");
  const [isConnecting, setIsConnecting] = useState(false);
  const [isNavigating, setIsNavigating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  // Dragging state for floating panel
  const [position, setPosition] = useState({ x: 20, y: 20 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0, posX: 0, posY: 0 });

  // Zoom state - toggle between 50% and 100%
  const [isZoomedOut, setIsZoomedOut] = useState(false);

  // URL input editing state - when true, don't sync URL from screenshots
  const [isEditingUrl, setIsEditingUrl] = useState(false);

  // Interaction state
  const [typeText, setTypeText] = useState("");
  const [isInteracting, setIsInteracting] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const subscribedConversationIdRef = useRef<string | null>(null);
  const prevConversationIdRef = useRef<string | undefined>(undefined);
  const isEditingUrlRef = useRef(false);
  const chatSession = useChatSession(conversationId);
  const chatMessages = chatSession?.messages ?? [];
  const setChatMessages = chatSession?.setMessages;
  const chatMessagesRef = useRef<UIMessage[]>([]);
  const setChatMessagesRef = useRef<((messages: UIMessage[]) => void) | null>(
    null,
  );

  chatMessagesRef.current = chatMessages;
  setChatMessagesRef.current = setChatMessages ?? null;

  const appendNavigationMessage = useCallback((text: string) => {
    const updateMessages = setChatMessagesRef.current;
    if (!updateMessages) return;

    const messageId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `nav-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const navigationMessage: UIMessage = {
      id: messageId,
      role: "user",
      parts: [{ type: "text", text }],
    };

    updateMessages([...chatMessagesRef.current, navigationMessage]);
  }, []);

  // Keep ref in sync with state for use in subscription callbacks
  useEffect(() => {
    isEditingUrlRef.current = isEditingUrl;
  }, [isEditingUrl]);

  // Subscribe to browser stream via existing WebSocket
  useEffect(() => {
    if (!isOpen || !conversationId) {
      // Unsubscribe when panel closes
      if (subscribedConversationIdRef.current) {
        websocketService.send({
          type: "unsubscribe_browser_stream",
          payload: { conversationId: subscribedConversationIdRef.current },
        });
        subscribedConversationIdRef.current = null;
      }
      setIsConnected(false);
      setScreenshot(null);
      prevConversationIdRef.current = conversationId;
      return;
    }

    // Clear state when switching conversations
    // Use prevConversationIdRef because subscribedConversationIdRef is cleared in cleanup
    const isConversationSwitch =
      prevConversationIdRef.current !== undefined &&
      prevConversationIdRef.current !== conversationId;

    if (isConversationSwitch) {
      // Unsubscribe from previous conversation if still subscribed
      if (subscribedConversationIdRef.current) {
        websocketService.send({
          type: "unsubscribe_browser_stream",
          payload: { conversationId: subscribedConversationIdRef.current },
        });
        subscribedConversationIdRef.current = null;
      }
      // Clear state for new conversation
      setScreenshot(null);
      setUrlInput("");
      setIsConnected(false);
      setIsEditingUrl(false);
    }

    // Update prevConversationIdRef for next comparison
    prevConversationIdRef.current = conversationId;

    setIsConnecting(true);
    setError(null);

    // Connect to WebSocket if not already connected
    websocketService.connect();

    // Subscribe to browser screenshot messages
    const unsubScreenshot = websocketService.subscribe(
      "browser_screenshot",
      (message) => {
        if (message.payload.conversationId === conversationId) {
          setScreenshot(message.payload.screenshot);
          // Only sync URL from screenshots when user is not editing the address bar
          if (message.payload.url && !isEditingUrlRef.current) {
            setUrlInput(message.payload.url);
          }
          setError(null);
          setIsConnecting(false);
          setIsConnected(true);
        }
      },
    );

    // Subscribe to navigation results
    const unsubNavigate = websocketService.subscribe(
      "browser_navigate_result",
      (message) => {
        if (message.payload.conversationId === conversationId) {
          setIsNavigating(false);
          if (message.payload.success && message.payload.url) {
            appendNavigationMessage(
              `[User manually navigated browser to: ${message.payload.url}]`,
            );
          } else if (message.payload.error) {
            setError(message.payload.error);
          }
        }
      },
    );

    // Subscribe to stream errors
    const unsubError = websocketService.subscribe(
      "browser_stream_error",
      (message) => {
        if (message.payload.conversationId === conversationId) {
          setError(message.payload.error);
          setIsConnecting(false);
        }
      },
    );

    // Subscribe to click results
    const unsubClick = websocketService.subscribe(
      "browser_click_result",
      (message) => {
        if (message.payload.conversationId === conversationId) {
          setIsInteracting(false);
          if (!message.payload.success && message.payload.error) {
            setError(message.payload.error);
          }
        }
      },
    );

    // Subscribe to type results
    const unsubType = websocketService.subscribe(
      "browser_type_result",
      (message) => {
        if (message.payload.conversationId === conversationId) {
          setIsInteracting(false);
          if (!message.payload.success && message.payload.error) {
            setError(message.payload.error);
          }
        }
      },
    );

    // Subscribe to press key results
    const unsubPressKey = websocketService.subscribe(
      "browser_press_key_result",
      (message) => {
        if (message.payload.conversationId === conversationId) {
          setIsInteracting(false);
          if (!message.payload.success && message.payload.error) {
            setError(message.payload.error);
          }
        }
      },
    );

    // Subscribe to zoom results
    const unsubZoom = websocketService.subscribe(
      "browser_set_zoom_result",
      (message) => {
        if (message.payload.conversationId === conversationId) {
          setIsInteracting(false);
          if (!message.payload.success && message.payload.error) {
            setError(message.payload.error);
          }
        }
      },
    );

    // Subscribe to navigate back results
    const unsubNavigateBack = websocketService.subscribe(
      "browser_navigate_back_result",
      (message) => {
        if (message.payload.conversationId === conversationId) {
          setIsNavigating(false);
          if (message.payload.success) {
            appendNavigationMessage(
              "[User navigated browser back to previous page]",
            );
          } else if (message.payload.error) {
            setError(message.payload.error);
          }
        }
      },
    );

    // Send subscribe message after a short delay to ensure connection is ready
    const subscribeTimeout = setTimeout(() => {
      websocketService.send({
        type: "subscribe_browser_stream",
        payload: { conversationId },
      });
      subscribedConversationIdRef.current = conversationId;
    }, 100);

    return () => {
      clearTimeout(subscribeTimeout);
      unsubScreenshot();
      unsubNavigate();
      unsubError();
      unsubClick();
      unsubType();
      unsubPressKey();
      unsubZoom();
      unsubNavigateBack();

      // Unsubscribe from browser stream
      if (subscribedConversationIdRef.current) {
        websocketService.send({
          type: "unsubscribe_browser_stream",
          payload: { conversationId: subscribedConversationIdRef.current },
        });
        subscribedConversationIdRef.current = null;
      }
    };
  }, [isOpen, conversationId, appendNavigationMessage]);

  // Navigate to URL via WebSocket
  const handleNavigate = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      if (!websocketService.isConnected() || !conversationId) return;
      if (!urlInput.trim()) return;

      let url = urlInput.trim();
      // Add https:// if no protocol specified
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        url = `https://${url}`;
      }

      setIsNavigating(true);
      setError(null);
      setUrlInput(url);
      // Resume URL sync from screenshots after user navigates
      setIsEditingUrl(false);

      websocketService.send({
        type: "browser_navigate",
        payload: { conversationId, url },
      });
    },
    [urlInput, conversationId],
  );

  // Navigate back
  const handleNavigateBack = useCallback(() => {
    if (!websocketService.isConnected() || !conversationId) return;

    setIsNavigating(true);
    setError(null);

    websocketService.send({
      type: "browser_navigate_back",
      payload: { conversationId },
    });
  }, [conversationId]);

  // Type text
  const handleType = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      if (!websocketService.isConnected() || !conversationId) return;
      if (!typeText) return;

      setIsInteracting(true);
      setError(null);

      websocketService.send({
        type: "browser_type",
        payload: {
          conversationId,
          text: typeText,
        },
      });
      setTypeText("");
    },
    [typeText, conversationId],
  );

  // Press key
  const handlePressKey = useCallback(
    (key: string) => {
      if (!websocketService.isConnected() || !conversationId) return;

      setIsInteracting(true);
      setError(null);

      websocketService.send({
        type: "browser_press_key",
        payload: { conversationId, key },
      });
    },
    [conversationId],
  );

  // Handle click on browser screenshot
  const handleImageClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (!isConnected || isInteracting || !conversationId) return;

      const img = imageRef.current;
      if (!img) return;

      // Get the actual rendered position of the image (accounting for object-contain)
      const imgRect = img.getBoundingClientRect();
      const naturalRatio = img.naturalWidth / img.naturalHeight;
      const containerRatio = imgRect.width / imgRect.height;

      let renderedWidth: number;
      let renderedHeight: number;
      let offsetX: number;
      let offsetY: number;

      if (naturalRatio > containerRatio) {
        // Image is wider - letterboxed top/bottom
        renderedWidth = imgRect.width;
        renderedHeight = imgRect.width / naturalRatio;
        offsetX = 0;
        offsetY = (imgRect.height - renderedHeight) / 2;
      } else {
        // Image is taller - letterboxed left/right
        renderedHeight = imgRect.height;
        renderedWidth = imgRect.height * naturalRatio;
        offsetX = (imgRect.width - renderedWidth) / 2;
        offsetY = 0;
      }

      const clickX = e.clientX - imgRect.left - offsetX;
      const clickY = e.clientY - imgRect.top - offsetY;

      // Check if click is within the actual image area
      if (
        clickX < 0 ||
        clickX > renderedWidth ||
        clickY < 0 ||
        clickY > renderedHeight
      ) {
        return; // Click was on letterbox area
      }

      // Scale coordinates from displayed size to original image size
      const scaleX = img.naturalWidth / renderedWidth;
      const scaleY = img.naturalHeight / renderedHeight;
      const x = clickX * scaleX;
      const y = clickY * scaleY;

      setIsInteracting(true);
      setError(null);

      websocketService.send({
        type: "browser_click",
        payload: { conversationId, x, y },
      });
    },
    [isConnected, isInteracting, conversationId],
  );

  // Handle dragging for floating panel position
  const handleDragStart = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      setIsDragging(true);
      dragStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        posX: position.x,
        posY: position.y,
      };
    },
    [position],
  );

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - dragStartRef.current.x;
      const deltaY = e.clientY - dragStartRef.current.y;
      setPosition({
        x: Math.max(0, dragStartRef.current.posX + deltaX),
        y: Math.max(0, dragStartRef.current.posY + deltaY),
      });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging]);

  const toggleMaximize = useCallback(() => {
    setIsMaximized((prev) => !prev);
    if (!isMaximized) {
      setIsMinimized(false);
    }
  }, [isMaximized]);

  const toggleMinimize = useCallback(() => {
    setIsMinimized((prev) => !prev);
    if (!isMinimized) {
      setIsMaximized(false);
    }
  }, [isMinimized]);

  if (!isOpen) return null;

  // Calculate dimensions based on state
  // When zoomed out, reduce panel size to 50% to match the image scale
  const effectiveWidth = isZoomedOut ? PANEL_WIDTH * 0.5 : PANEL_WIDTH;
  const effectiveHeight = isZoomedOut ? PANEL_HEIGHT * 0.5 : PANEL_HEIGHT;

  const panelStyle = isMaximized
    ? { left: 0, top: 0, right: 0, bottom: 0, width: "100%", height: "100%" }
    : isMinimized
      ? { right: 20, bottom: 20, width: 300, height: 48 }
      : {
          left: position.x,
          top: position.y,
          width: effectiveWidth,
          height: effectiveHeight,
        };

  return (
    <div
      ref={panelRef}
      className={cn(
        "fixed z-50 bg-background border rounded-lg shadow-2xl flex flex-col overflow-hidden",
        isDragging && "select-none cursor-grabbing",
        isMaximized && "rounded-none",
      )}
      style={panelStyle}
    >
      {/* Draggable Header */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drag handle needs onMouseDown */}
      <div
        className={cn(
          "flex flex-col gap-2 p-2 bg-muted/50",
          !isMinimized && "border-b",
          !isMaximized && !isMinimized && "cursor-grab",
        )}
        onMouseDown={!isMaximized && !isMinimized ? handleDragStart : undefined}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium">Browser Preview</span>
            {isConnected && (
              <span
                className="w-2 h-2 rounded-full bg-green-500"
                title="Connected"
              />
            )}
          </div>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: stops drag propagation */}
          <div
            className="flex items-center gap-1"
            onMouseDown={(e) => e.stopPropagation()}
          >
            {!isMinimized && (
              <>
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
                          onClick={() => handlePressKey("Enter")}
                        >
                          Enter
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() => handlePressKey("Tab")}
                        >
                          Tab
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() => handlePressKey("Escape")}
                        >
                          Escape
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() => handlePressKey("Backspace")}
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
                  onClick={() => handlePressKey("PageUp")}
                  disabled={!isConnected || isInteracting}
                  title="Scroll up"
                >
                  <ChevronUp className="h-3 w-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => handlePressKey("PageDown")}
                  disabled={!isConnected || isInteracting}
                  title="Scroll down"
                >
                  <ChevronDown className="h-3 w-3" />
                </Button>

                {/* Zoom toggle button - CSS scale only */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => setIsZoomedOut((prev) => !prev)}
                  disabled={!isConnected}
                  title={isZoomedOut ? "Zoom to 100%" : "Zoom out to 50%"}
                >
                  {isZoomedOut ? (
                    <ZoomIn className="h-3 w-3" />
                  ) : (
                    <ZoomOut className="h-3 w-3" />
                  )}
                </Button>

                <div className="w-px h-4 bg-border mx-1" />
              </>
            )}

            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={toggleMinimize}
              title={isMinimized ? "Restore" : "Minimize"}
            >
              {isMinimized ? (
                <Maximize2 className="h-3 w-3" />
              ) : (
                <Minimize2 className="h-3 w-3" />
              )}
            </Button>
            {!isMinimized && (
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={toggleMaximize}
                title={isMaximized ? "Restore" : "Maximize"}
              >
                {isMaximized ? (
                  <GripVertical className="h-3 w-3" />
                ) : (
                  <Maximize2 className="h-3 w-3" />
                )}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={onClose}
              title="Close"
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        </div>

        {/* URL input - hidden when minimized */}
        {!isMinimized && (
          <form
            onSubmit={handleNavigate}
            className="flex gap-2"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-7 w-7 flex-shrink-0"
              onClick={handleNavigateBack}
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
              {isNavigating ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                "Go"
              )}
            </Button>
          </form>
        )}
      </div>

      {/* Error display - absolute positioned */}
      {error && !isMinimized && (
        <div className="absolute top-14 left-2 right-2 z-10 text-xs text-destructive bg-destructive/10 border border-destructive/20 px-2 py-1 rounded shadow-sm">
          {error}
        </div>
      )}

      {/* Content - Screenshot with clickable overlay - hidden when minimized */}
      {!isMinimized && (
        <div className="flex-1 overflow-auto bg-black">
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
            <div className="relative w-full h-full flex items-start justify-start">
              <img
                ref={imageRef}
                src={screenshot}
                alt="Browser screenshot"
                className="block w-full h-full object-contain"
              />
              {/* Clickable overlay - captures clicks and sends coordinates */}
              {/* biome-ignore lint/a11y/useSemanticElements: Need div for absolute positioning overlay */}
              <div
                className="absolute inset-0 cursor-pointer"
                onClick={handleImageClick}
                onKeyDown={(e) => {
                  // Handle keyboard navigation
                  if (e.key === "Enter" || e.key === " ") {
                    // For keyboard, we can't get coordinates, so just ignore
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
        </div>
      )}

      {/* Loading overlay */}
      {isInteracting && !isMinimized && (
        <div className="absolute inset-0 bg-black/20 flex items-center justify-center pointer-events-none">
          <Loader2 className="h-8 w-8 animate-spin text-white" />
        </div>
      )}
    </div>
  );
}
