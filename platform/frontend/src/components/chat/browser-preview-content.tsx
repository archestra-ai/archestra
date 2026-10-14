"use client";

import {
  DEFAULT_BROWSER_PREVIEW_VIEWPORT_HEIGHT,
  DEFAULT_BROWSER_PREVIEW_VIEWPORT_WIDTH,
} from "@archestra/shared";
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
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { DialogStickyFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { useProfile } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useBrowserStream } from "@/lib/browser-stream.hook";
import {
  useConversation,
  useHasPlaywrightMcpTools,
} from "@/lib/chat/chat.query";
import { cn } from "@/lib/utils/tailwind";
import { LoadingState } from "../loading";

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
  /** When true, hide the title row (parent already provides chrome). */
  hideHeader?: boolean;
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
  hideHeader = false,
  onCreateConversationWithUrl,
  isCreatingConversation = false,
  initialNavigateUrl,
  onInitialNavigateComplete,
}: BrowserPreviewContentProps) {
  // Resolve agentId: prefer conversation's agentId, fall back to prop
  const { data: conversation } = useConversation(conversationId);
  const resolvedAgentId = conversation?.agentId ?? agentIdProp;
  const { data: canUpdateAgent } = useHasPermissions(
    { agent: ["update"] },
    resolvedAgentId ?? "",
  );

  const { data: agent } = useProfile(resolvedAgentId);
  const isSharedAgent = agent?.scope !== "personal";

  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  const { hasPlaywrightMcpTools, isAssigningTools, assignToolsToAgent } =
    useHasPlaywrightMcpTools(resolvedAgentId);
  const [typeText, setTypeText] = useState("");
  const imageRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const initialNavigateTriggeredRef = useRef(false);
  // Clicks and keystrokes go out at once (the backend keeps them in order) up
  // to MAX_INPUTS_IN_FLIGHT; beyond that they wait here, consecutive
  // characters merged into one type call.
  const inputQueueRef = useRef<BrowserInputOp[]>([]);
  const inFlightInputsRef = useRef<BrowserInputOp[]>([]);
  const lastSettledInputsRef = useRef(0);
  const [isKeyboardFocused, setIsKeyboardFocused] = useState(false);
  const urlJustFocusedRef = useRef(false);
  // Everything sent or queued and not yet done, shown instead of a spinner
  const [pendingInputLabel, setPendingInputLabel] = useState<string | null>(
    null,
  );

  const {
    screenshot,
    urlInput,
    isConnected,
    isConnecting,
    isNavigating,
    settledInputs,
    error,
    canGoBack,
    navigate,
    navigateBack,
    click,
    type,
    pressKey,
    scroll,
    reconnect,
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

  const refreshPendingInputLabel = useCallback(() => {
    setPendingInputLabel(
      describeInputOps([
        ...inFlightInputsRef.current,
        ...inputQueueRef.current,
      ]),
    );
  }, []);

  const drainInputQueue = useCallback(() => {
    if (!isConnected) return;
    while (
      inFlightInputsRef.current.length < MAX_INPUTS_IN_FLIGHT &&
      inputQueueRef.current.length > 0
    ) {
      const next = inputQueueRef.current.shift() as BrowserInputOp;
      inFlightInputsRef.current.push(next);
      if (next.kind === "click") {
        click(next.x, next.y);
      } else if (next.kind === "scroll") {
        scroll(next);
      } else if (next.kind === "text") {
        type(next.value);
      } else {
        pressKey(next.value);
      }
    }
    refreshPendingInputLabel();
  }, [isConnected, click, scroll, type, pressKey, refreshPendingInputLabel]);

  const enqueueInputOp = useCallback(
    (op: BrowserInputOp) => {
      const queue = inputQueueRef.current;
      const last = queue.at(-1);
      if (op.kind === "text" && last?.kind === "text") {
        last.value += op.value;
      } else if (op.kind === "scroll" && last?.kind === "scroll") {
        last.deltaX += op.deltaX;
        last.deltaY += op.deltaY;
        last.x = op.x;
        last.y = op.y;
      } else {
        queue.push({ ...op });
      }
      drainInputQueue();
    },
    [drainInputQueue],
  );

  const resetInputQueue = useCallback(() => {
    inputQueueRef.current = [];
    inFlightInputsRef.current = [];
    setPendingInputLabel(null);
  }, []);

  const handleOverlayKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!isConnected) return;
      // Leave browser shortcuts (copy, paste, tab switching) to the host page;
      // Shift+Tab moves focus out of the preview instead of into the page.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Tab" && e.shiftKey) return;
      if (e.key.length === 1) {
        e.preventDefault();
        enqueueInputOp({ kind: "text", value: e.key });
      } else if (FORWARDED_KEYS.has(e.key)) {
        e.preventDefault();
        enqueueInputOp({ kind: "key", value: e.key });
      }
    },
    [isConnected, enqueueInputOp],
  );

  const handleOverlayPaste = useCallback(
    (e: ReactClipboardEvent<HTMLDivElement>) => {
      if (!isConnected) return;
      const text = e.clipboardData.getData("text/plain");
      if (!text) return;
      e.preventDefault();
      enqueueInputOp({ kind: "text", value: text });
    },
    [isConnected, enqueueInputOp],
  );

  /** Map a pointer position on the screenshot to remote viewport coordinates. */
  const toViewportPoint = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const container = containerRef.current;
      if (!imageRef.current || !container) return null;

      const containerRect = container.getBoundingClientRect();

      // Fixed viewport dimensions (backend always uses these)
      const viewportW = DEFAULT_BROWSER_PREVIEW_VIEWPORT_WIDTH;
      const viewportH = DEFAULT_BROWSER_PREVIEW_VIEWPORT_HEIGHT;

      // Calculate how the image is displayed with object-contain
      // Scale is determined by whichever dimension constrains the fit
      const scale = Math.min(
        containerRect.width / viewportW,
        containerRect.height / viewportH,
      );

      // Actual displayed image size
      const displayedW = viewportW * scale;
      const displayedH = viewportH * scale;

      // The image is centered horizontally but pinned to the top
      // (object-top), so letterboxing is only beside and below it
      const offsetX = (containerRect.width - displayedW) / 2;

      // Pointer position relative to the displayed image
      const imageX = clientX - containerRect.left - offsetX;
      const imageY = clientY - containerRect.top;

      // Outside the actual image area (in letterboxing)
      if (
        imageX < 0 ||
        imageX > displayedW ||
        imageY < 0 ||
        imageY > displayedH
      ) {
        return null;
      }

      return { x: imageX / scale, y: imageY / scale };
    },
    [],
  );

  const handleImageClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (!isConnected) return;
      const point = toViewportPoint(e.clientX, e.clientY);
      if (point) enqueueInputOp({ kind: "click", ...point });
    },
    [isConnected, toViewportPoint, enqueueInputOp],
  );

  const handleOverlayWheel = useCallback(
    (e: ReactWheelEvent<HTMLDivElement>) => {
      if (!isConnected) return;
      const point = toViewportPoint(e.clientX, e.clientY);
      if (!point) return;
      // deltaMode 1 = lines; convert to pixels like browsers do
      const factor = e.deltaMode === 1 ? 40 : 1;
      enqueueInputOp({
        kind: "scroll",
        ...point,
        deltaX: e.deltaX * factor,
        deltaY: e.deltaY * factor,
      });
    },
    [isConnected, toViewportPoint, enqueueInputOp],
  );

  /** Header scroll buttons: wheel at the viewport center. */
  const scrollPage = useCallback(
    (deltaY: number) => {
      enqueueInputOp({
        kind: "scroll",
        x: DEFAULT_BROWSER_PREVIEW_VIEWPORT_WIDTH / 2,
        y: DEFAULT_BROWSER_PREVIEW_VIEWPORT_HEIGHT / 2,
        deltaX: 0,
        deltaY,
      });
    },
    [enqueueInputOp],
  );

  // Each settled action frees a slot: drop the oldest in-flight op and send
  // queued ones
  useEffect(() => {
    const settled = settledInputs - lastSettledInputsRef.current;
    lastSettledInputsRef.current = settledInputs;
    if (settled <= 0) return;
    inFlightInputsRef.current.splice(0, settled);
    drainInputQueue();
  }, [settledInputs, drainInputQueue]);

  // Drop queued input when the session changes or disconnects
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally reset queue when conversationId changes
  useEffect(() => {
    resetInputQueue();
  }, [conversationId, isConnected, resetInputQueue]);

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
      {/* Title row: only when no parent chrome names the panel */}
      {!hideHeader && (
        <div className="flex items-center gap-2 px-2 pt-2">
          <Globe className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs font-medium">Browser Preview</span>
        </div>
      )}

      {/* Toolbar: one row, like a browser's address bar */}
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        <span
          className={cn(
            "mx-1 h-2 w-2 shrink-0 rounded-full",
            isConnected ? "bg-green-500" : "bg-muted-foreground/30",
          )}
          title={isConnected ? "Connected" : "Not connected"}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="shrink-0"
          onClick={navigateBack}
          disabled={isNavigating || !isConnected || !canGoBack}
          title="Go back"
        >
          <ArrowLeft className="h-3 w-3" />
        </Button>
        <form
          onSubmit={handleNavigate}
          className="flex min-w-0 flex-1 items-center gap-1"
        >
          <Input
            type="text"
            placeholder="Enter URL..."
            aria-label="URL to navigate"
            value={urlInput}
            onChange={(e) => {
              setIsEditingUrl(true);
              setUrlInput(e.target.value);
            }}
            onFocus={(e) => {
              setIsEditingUrl(true);
              // Like a browser address bar: the first click selects the
              // whole URL; the mouseup below keeps it from collapsing
              e.currentTarget.select();
              urlJustFocusedRef.current = true;
            }}
            onMouseUp={(e) => {
              if (urlJustFocusedRef.current) {
                urlJustFocusedRef.current = false;
                e.preventDefault();
              }
            }}
            className="h-7 min-w-0 text-xs!"
            disabled={isNavigating || isCreatingConversation}
          />
          <Button
            type="submit"
            size="xs"
            className="shrink-0"
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
              <span>Go</span>
            )}
          </Button>
        </form>

        <div className="flex shrink-0 items-center">
          {/* Type tool */}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={!isConnected}
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
                  aria-label="Text to type"
                  value={typeText}
                  onChange={(e) => setTypeText(e.target.value)}
                  className="text-xs min-h-[60px]"
                  autoFocus
                />
                <Button
                  type="submit"
                  size="xs"
                  className="w-full"
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
                size="icon-xs"
                disabled={!isConnected}
                title="Press key"
              >
                <Keyboard className="h-3 w-3" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-48" align="end">
              <div className="space-y-2">
                <div className="text-xs font-medium">Press Key</div>
                <div className="grid grid-cols-2 gap-1">
                  {["Enter", "Tab", "Escape", "Backspace"].map((key) => (
                    <Button
                      key={key}
                      size="xs"
                      variant="outline"
                      onClick={() =>
                        enqueueInputOp({ kind: "key", value: key })
                      }
                    >
                      {key}
                    </Button>
                  ))}
                </div>
              </div>
            </PopoverContent>
          </Popover>

          {/* Scroll buttons */}
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => scrollPage(-600)}
            disabled={!isConnected}
            title="Scroll up"
          >
            <ChevronUp className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => scrollPage(600)}
            disabled={!isConnected}
            title="Scroll down"
          >
            <ChevronDown className="h-3 w-3" />
          </Button>

          {/* Extra header actions (open in new window, close, etc.) */}
          {headerActions}
        </div>
      </div>

      {error && (
        <div className="flex items-center justify-between gap-2 text-xs text-destructive bg-destructive/10 border-b border-destructive/20 px-2 py-1">
          <span className="min-w-0">{error}</span>
          {conversationId && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="shrink-0"
              onClick={() => {
                resetInputQueue();
                reconnect();
              }}
            >
              Reconnect
            </Button>
          )}
        </div>
      )}

      {/* Content - Screenshot with clickable overlay */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden min-h-0 relative"
      >
        {isConnecting && (
          <div className="flex items-center justify-center h-full">
            <LoadingState label="Connecting…" />
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
            {/*
              Interaction overlay: clicks forward the exact pointer position to
              the remote browser (see handleImageClick), and once focused,
              keystrokes and pastes are forwarded to whatever is focused in the
              remote page. Shift+Tab or clicking elsewhere leaves it.
            */}
            <div
              role="application"
              aria-label="Remote browser. Click to focus a field, then type. Shift+Tab to leave."
              // biome-ignore lint/a11y/noNoninteractiveTabindex: role="application" surface must take focus to forward keystrokes to the remote browser
              tabIndex={0}
              className="absolute inset-0 cursor-pointer outline-none"
              onClick={handleImageClick}
              onKeyDown={handleOverlayKeyDown}
              onPaste={handleOverlayPaste}
              onWheel={handleOverlayWheel}
              onFocus={() => setIsKeyboardFocused(true)}
              onBlur={() => setIsKeyboardFocused(false)}
            />
            {isKeyboardFocused && (
              <div className="pointer-events-none absolute inset-0 ring-2 ring-inset ring-primary">
                <span className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded bg-primary px-2 py-0.5 text-[10px] text-primary-foreground">
                  Typing goes to the page · Shift+Tab to leave
                </span>
              </div>
            )}
          </div>
        )}
        {!isConnecting && !screenshot && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center space-y-4">
              {isAssigningTools && !hasPlaywrightMcpTools ? (
                <>
                  <Button size="sm" disabled className="mt-10">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Assigning tools
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Assigning Playwright tools to the agent
                  </p>
                </>
              ) : !hasPlaywrightMcpTools ? (
                <>
                  <Button
                    size="sm"
                    onClick={() => {
                      if (!resolvedAgentId) return;
                      const action = () =>
                        assignToolsToAgent({
                          agentId: resolvedAgentId,
                          conversationId,
                        });
                      if (isSharedAgent) {
                        setPendingAction(() => action);
                      } else {
                        action();
                      }
                    }}
                    disabled={!resolvedAgentId || !canUpdateAgent}
                    className="mt-10"
                  >
                    Assign tools to agent
                  </Button>
                  <p className="text-xs text-muted-foreground max-w-[280px]">
                    Assign the built-in Playwright tools to use Browser Preview
                  </p>
                </>
              ) : (
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

        {/* Status: what the remote browser is doing; non-blocking, input queues */}
        {pendingInputLabel && (
          <div className="absolute top-2 right-2 flex max-w-[85%] items-center gap-1.5 rounded-full bg-background/90 px-2.5 py-1 text-xs text-muted-foreground shadow pointer-events-none">
            <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
            {/* Truncate from the left so the newest input stays visible */}
            <span className="truncate [direction:rtl]">
              <bdi>{pendingInputLabel}</bdi>
            </span>
          </div>
        )}
      </div>

      <FormDialog
        open={!!pendingAction}
        onOpenChange={(open) => {
          if (!open) setPendingAction(null);
        }}
        title="Modify shared agent?"
        description={
          <>
            This agent is shared across your{" "}
            {agent?.scope === "team" ? "team" : "organization"}. Adding browser
            tools will affect all users of this agent.
          </>
        }
        size="small"
      >
        <DialogStickyFooter className="mt-0">
          <Button
            type="button"
            variant="outline"
            onClick={() => setPendingAction(null)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              pendingAction?.();
              setPendingAction(null);
            }}
          >
            Confirm
          </Button>
        </DialogStickyFooter>
      </FormDialog>
    </div>
  );
}

// ===

type BrowserInputOp =
  | { kind: "click"; x: number; y: number }
  | { kind: "scroll"; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: "text" | "key"; value: string };

/** Most inputs sent but not yet done; more wait in the queue, merged. */
const MAX_INPUTS_IN_FLIGHT = 3;

/** All pending inputs in order, e.g. `Typing “hello” · Enter · Clicking`. */
function describeInputOps(ops: BrowserInputOp[]): string | null {
  const parts: string[] = [];
  let text = "";
  const flushText = () => {
    if (text) parts.push(`Typing “${text}”`);
    text = "";
  };
  for (const op of ops) {
    if (op.kind === "text") {
      text += op.value;
      continue;
    }
    flushText();
    const label =
      op.kind === "click"
        ? "Clicking"
        : op.kind === "scroll"
          ? "Scrolling"
          : op.value;
    if (parts.at(-1) !== label) parts.push(label);
  }
  flushText();
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Non-character keys forwarded to the remote page as Playwright key presses. */
const FORWARDED_KEYS = new Set([
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);
