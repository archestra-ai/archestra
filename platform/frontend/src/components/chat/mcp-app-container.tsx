import { type archestraApiTypes, parseFullToolName } from "@archestra/shared";
import type { McpUiDisplayMode } from "@modelcontextprotocol/ext-apps";
import { PanelRightOpen } from "lucide-react";
import type React from "react";
import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { useApps } from "@/components/chat/apps-context";
import {
  clampInlineHeight,
  INITIAL_INLINE_HEIGHT,
  useInlineCeiling,
} from "@/components/mcp-app/app-height";
import {
  type AppResourceMeta,
  isRenderableMcpAppHtml,
  McpAppRuntime,
  type McpCallToolResult,
} from "@/components/mcp-app/mcp-app-view";
import { Button } from "@/components/ui/button";
import {
  getAppDiagnosticCounts,
  subscribeAppDiagnostics,
} from "@/lib/chat/app-diagnostics-store";
import { cn } from "@/lib/utils";

/**
 * Shape of MCP tool output stored by the backend in the AI SDK's tool result.
 * Contains a text string for model context plus rich metadata for UI rendering.
 *
 * Matches the return type of `executeMcpTool` in chat-mcp-client.ts.
 */
export type McpToolOutput = {
  /** Text representation for the model and text-only hosts */
  content: string;
  /** Additional metadata (timestamps, version info, etc.) not intended for model context */
  _meta?: Record<string, unknown>;
  /** Unsafe-context boundary marker preserved in the live tool stream */
  unsafeContextBoundary?: archestraApiTypes.GetInteractionResponses["200"]["unsafeContextBoundary"];
  /** Structured data optimized for UI rendering (not added to model context) */
  structuredContent?: Record<string, unknown>;
  /** Original MCP content blocks from the tool response */
  rawContent?: McpCallToolResult["content"];
};

/** Catches render errors from MCP App iframes so a crashing app doesn't take down the chat. */
class McpAppErrorBoundary extends Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          MCP App crashed: {this.state.error.message}
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Self-contained MCP App section for use inside a Tool collapsible.
 * Owns display-mode / size state and the rawToolResult derivation so the
 * parent only needs to forward the raw output from the tool part.
 */
export function McpAppSection({
  uiResourceUri,
  agentId,
  appId,
  appVersion,
  toolName,
  toolCallId,
  toolInput,
  rawOutput,
  preloadedResource,
  onSendMessage,
}: {
  uiResourceUri: string;
  agentId: string;
  /**
   * Owned-app render: drive the app-bound endpoint (`/api/mcp/app/:appId`)
   * instead of the agent gateway. Set for Archestra-authored apps surfaced by
   * the app-management tools; the management tool's input/result are not
   * forwarded into the iframe (they are not app data).
   */
  appId?: string;
  /** Owned-app version this render shows — keys the render-loop diagnostics. */
  appVersion?: number | null;
  /** Full prefixed tool name (e.g. "system__get-system-stats") — used to derive the server prefix for oncalltool */
  toolName: string;
  /** Stable identifier for this app, used to select it in the panel. */
  toolCallId?: string;
  toolInput?: Record<string, unknown>;
  /** Tool result for the iframe; omitted for owned apps (management payloads are not app data) */
  rawOutput?: McpToolOutput;
  /** HTML pre-fetched by the backend and delivered via SSE — skips the in-browser HTTP fetch */
  preloadedResource?: AppResourceMeta;
  /** Called when the MCP App sends a ui/message request to inject a user message into the conversation */
  onSendMessage?: (text: string) => void;
}) {
  const resourceKey = `${agentId}:${uiResourceUri}`;
  const inlineCeiling = useInlineCeiling();
  const [displayMode, setDisplayMode] = useState<McpUiDisplayMode>("inline");
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  const [resourceState, setResourceState] = useState<{
    key: string;
    state: "unknown" | "renderable" | "empty";
  }>(() => ({
    key: resourceKey,
    state: preloadedResource
      ? isRenderableMcpAppHtml(preloadedResource.html)
        ? "renderable"
        : "empty"
      : "unknown",
  }));
  const effectiveResourceState =
    resourceState.key === resourceKey ? resourceState.state : "unknown";

  const { selectedToolCallId, select, showInSidebar, portalTarget } = useApps();

  const parsedToolName = parseFullToolName(toolName);
  const shortToolName = parsedToolName.toolName ?? toolName;
  const isSelected = !!toolCallId && selectedToolCallId === toolCallId;
  const sidebarHostingActive = portalTarget !== null;
  // When the sidebar Apps tab is open, every inline app is replaced by a
  // placeholder; only the *selected* app's iframe lives in the sidebar.
  const renderInSidebar = sidebarHostingActive && isSelected;
  const renderPlaceholder = sidebarHostingActive;

  // Reconstruct McpCallToolResult for AppFrame. Owned apps get none — the
  // management tool's result is not app data.
  const toolResult = useMemo((): McpCallToolResult | undefined => {
    if (!rawOutput || appId) return undefined;
    return {
      content: rawOutput.rawContent ?? [
        { type: "text" as const, text: rawOutput.content },
      ],
      structuredContent: rawOutput.structuredContent,
      _meta: rawOutput._meta,
      isError: false,
    };
  }, [rawOutput, appId]);

  const handleSelect = () => {
    if (!toolCallId) return;
    select(toolCallId);
  };

  const handleShowInSidebar = () => {
    if (!toolCallId) return;
    showInSidebar(toolCallId);
  };

  const handleResourceStateChange = useCallback(
    (state: "renderable" | "empty") => {
      setResourceState({ key: resourceKey, state });
    },
    [resourceKey],
  );

  // Error badge: runtime errors / CSP violations captured from this app's
  // sandboxed render (owned apps only).
  const diagnosticCounts = useSyncExternalStore(
    subscribeAppDiagnostics,
    getAppDiagnosticCounts,
    getAppDiagnosticCounts,
  );
  const appDiagnosticCounts = appId ? diagnosticCounts.get(appId) : undefined;
  const errorCount = appDiagnosticCounts?.errors ?? 0;
  const logCount = appDiagnosticCounts?.logs ?? 0;

  if (effectiveResourceState === "empty") {
    return null;
  }

  const diagnosticsBadge =
    errorCount > 0 || logCount > 0 ? (
      <div className="mb-2 flex w-fit flex-wrap items-center gap-1.5">
        {errorCount > 0 && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-2 py-0.5 text-xs text-destructive">
            {errorCount === 1
              ? "1 runtime error"
              : `${errorCount} runtime errors`}{" "}
            in this app
          </div>
        )}
        {logCount > 0 && (
          <div className="rounded-md border border-border bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground">
            {logCount === 1 ? "1 log" : `${logCount} logs`} from this app
          </div>
        )}
      </div>
    ) : null;

  const appSurface = (
    <McpAppErrorBoundary>
      <McpAppContainer
        displayMode={displayMode}
        onClose={() => setDisplayMode("inline")}
        diagnostics={diagnosticsBadge}
        size={size}
        inlineCeiling={inlineCeiling}
        onShowInSidebar={
          toolCallId && !renderInSidebar ? handleShowInSidebar : undefined
        }
        fillContainer={renderInSidebar}
      >
        <McpAppRuntime
          toolResourceUri={uiResourceUri}
          endpoint={
            appId
              ? { kind: "app", appId }
              : {
                  kind: "agent",
                  agentId,
                  serverPrefix:
                    parseFullToolName(toolName).serverName ?? toolName,
                }
          }
          displayMode={displayMode}
          onDisplayModeChange={setDisplayMode}
          onSizeChange={setSize}
          containerMaxHeight={renderInSidebar ? undefined : inlineCeiling}
          toolInput={appId ? undefined : toolInput}
          toolResult={toolResult}
          preloadedResource={preloadedResource}
          onResourceStateChange={handleResourceStateChange}
          onSendMessage={onSendMessage}
          appVersion={appVersion}
        />
      </McpAppContainer>
    </McpAppErrorBoundary>
  );

  if (renderPlaceholder) {
    return (
      <>
        <SidebarAppPlaceholder
          label={shortToolName}
          isSelected={isSelected}
          onSelect={handleSelect}
        />
        {renderInSidebar &&
          portalTarget &&
          createPortal(appSurface, portalTarget)}
      </>
    );
  }

  return appSurface;
}

function SidebarAppPlaceholder({
  label,
  isSelected,
  onSelect,
}: {
  label: string;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      className={cn(
        "rounded-md border border-dashed bg-muted/30 p-3 flex items-center justify-between gap-2 text-xs",
        isSelected
          ? "border-primary/50 text-foreground"
          : "border-border text-muted-foreground",
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <PanelRightOpen className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate font-medium">{label}</span>
      </div>
      {isSelected && (
        <span className="h-7 flex items-center px-3 text-xs text-primary shrink-0">
          Showing in sidebar
        </span>
      )}
      {!isSelected && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs shrink-0"
          onClick={onSelect}
        >
          Show in sidebar
        </Button>
      )}
    </div>
  );
}

/**
 * Container that handles display mode switching (inline ↔ fullscreen).
 *
 * Uses a single stable React tree for both modes so that children (iframe)
 * are never unmounted/remounted when toggling — only CSS classes change.
 *
 * In fullscreen, uses `position: fixed` sized to the Conversation scroll area
 * (found via `role="log"`) so the chat input remains visible below.
 */
function McpAppContainer({
  displayMode,
  onClose,
  children,
  diagnostics,
  size,
  inlineCeiling,
  onShowInSidebar,
  fillContainer = false,
}: {
  displayMode: McpUiDisplayMode;
  onClose: () => void;
  children: React.ReactNode;
  /**
   * Diagnostics badge rendered above the app. Kept out of `children` so the
   * fill/fullscreen `[&>div]:!h-full` stretch only hits the app surface — a
   * badge stretched to full height would shove the app below the fold.
   */
  diagnostics?: React.ReactNode;
  size: { width: number; height: number } | null;
  /** Viewport-derived max height for the inline card; reacts to window resize. */
  inlineCeiling: number;
  /** Inline-mode action: send this app to the sidebar. */
  onShowInSidebar?: () => void;
  /** When true, the app fills its parent container (used when portaled to sidebar). */
  fillContainer?: boolean;
}) {
  const isFullscreen = displayMode === "fullscreen";
  const [bounds, setBounds] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);

  useEffect(() => {
    if (!isFullscreen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isFullscreen, onClose]);

  // Cover the entire viewport in fullscreen mode
  useEffect(() => {
    if (!isFullscreen) {
      setBounds(null);
      return;
    }
    setBounds({
      top: 0,
      left: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    });
    const update = () => {
      setBounds({
        top: 0,
        left: 0,
        width: window.innerWidth,
        height: window.innerHeight,
      });
    };
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
    };
  }, [isFullscreen]);

  return (
    <div
      className={cn(
        "will-change-auto origin-center transition-all duration-400 ease-[cubic-bezier(0.23,1,0.32,1)] relative group",
        isFullscreen ? "fixed z-[100] bg-background flex flex-col" : "",
        fillContainer && !isFullscreen ? "h-full flex flex-col" : "",
        isFullscreen && !bounds
          ? "opacity-0 scale-95 pointer-events-none"
          : "opacity-100 scale-100",
      )}
      style={
        isFullscreen && bounds
          ? {
              top: bounds.top,
              left: bounds.left,
              width: bounds.width,
              height: bounds.height,
            }
          : undefined
      }
    >
      {/* Top toolbar — collapses to 0 height when there are no actions to show. */}
      {(isFullscreen || onShowInSidebar) && (
        <div
          className={cn(
            "flex items-center justify-end gap-1 transition-all duration-300 overflow-hidden",
            isFullscreen
              ? "h-12 p-2 border-b opacity-100"
              : fillContainer
                ? "h-8 p-1 border-b opacity-100"
                : "absolute top-1 right-1 z-10 h-7",
          )}
        >
          {onShowInSidebar && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-muted-foreground"
              onClick={onShowInSidebar}
              aria-label="Show in sidebar"
              title="Show in sidebar"
            >
              Show in sidebar
            </Button>
          )}
          {isFullscreen && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onClose}
              aria-label="Exit fullscreen"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </Button>
          )}
        </div>
      )}

      {diagnostics && <div className="shrink-0">{diagnostics}</div>}

      <div
        style={
          fillContainer && !isFullscreen
            ? undefined
            : {
                maxHeight: isFullscreen
                  ? `${bounds?.height || 1000}px`
                  : `${clampInlineHeight(size?.height ?? INITIAL_INLINE_HEIGHT, inlineCeiling)}px`,
              }
        }
        className={cn(
          "transition-[max-height] duration-400 ease-[cubic-bezier(0.23,1,0.32,1)]",
          isFullscreen
            ? "flex-1 overflow-hidden [&_iframe]:!w-full [&_iframe]:!h-full [&_iframe]:!min-h-0 [&_iframe]:!max-h-none [&>div]:!h-full"
            : fillContainer
              ? "flex-1 min-h-0 overflow-hidden [&_iframe]:!w-full [&_iframe]:!h-full [&_iframe]:!min-h-0 [&_iframe]:!max-h-none [&>div]:!h-full"
              : "max-w-[80%] shadow-xs border border-border/50 rounded-lg [&_iframe]:!w-full overflow-y-hidden [&_div]:!max-h-none",
        )}
      >
        {children}
      </div>
    </div>
  );
}
