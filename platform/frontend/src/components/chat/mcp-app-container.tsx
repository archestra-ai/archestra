import { type archestraApiTypes, parseFullToolName } from "@archestra/shared";
import type { McpUiDisplayMode } from "@modelcontextprotocol/ext-apps";
import type React from "react";
import {
  Component,
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { type PanelApp, useApps } from "@/components/chat/apps-context";
import {
  clampInlineHeight,
  INITIAL_INLINE_HEIGHT,
  useInlineCeiling,
} from "@/components/mcp-app/app-height";
import type { McpAppAction } from "@/components/mcp-app/mcp-app-actions";
import { McpAppCard } from "@/components/mcp-app/mcp-app-card";
import {
  type AppResourceMeta,
  isRenderableMcpAppHtml,
  McpAppRuntime,
  type McpCallToolResult,
} from "@/components/mcp-app/mcp-app-view";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  getAppDiagnosticCounts,
  subscribeAppDiagnostics,
} from "@/lib/chat/app-diagnostics-store";

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

/** Stable no-op size reporter for the panel-hosted (fill) render. */
const noopSizeChange = () => {};

/**
 * Self-contained MCP App section for use inside a Tool collapsible.
 * Owns display-mode / size state and the rawToolResult derivation so the
 * parent only needs to forward the raw output from the tool part.
 */
export function McpAppSection({
  uiResourceUri,
  agentId,
  appId,
  appName,
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
  /** Human-readable app name for the card header (owned apps); falls back to the short tool name. */
  appName?: string | null;
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
  // Bump to remount (reload) the sandboxed iframe via the runtime's reload nonce.
  const [reloadNonce, setReloadNonce] = useState(0);
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

  const { apps, selectedToolCallId, select, showInSidebar, portalTarget } =
    useApps();

  const parsedToolName = parseFullToolName(toolName);
  const shortToolName = parsedToolName.toolName ?? toolName;
  const headerName = appName || shortToolName;
  const isSelected = !!toolCallId && selectedToolCallId === toolCallId;
  const sidebarHostingActive = portalTarget !== null;
  // When the sidebar Apps tab is open, every inline app is replaced by a
  // placeholder; only the *selected* app's iframe lives in the sidebar.
  const renderInSidebar = sidebarHostingActive && isSelected;
  const renderPlaceholder = sidebarHostingActive;

  // Track the last inline body height while the app shows inline; once it moves
  // to the panel we stop updating, so the chat placeholder keeps that frozen
  // footprint and messages below it don't reflow.
  const lastInlineHeightRef = useRef(INITIAL_INLINE_HEIGHT);
  if (!renderPlaceholder) {
    lastInlineHeightRef.current = clampInlineHeight(
      size?.height ?? INITIAL_INLINE_HEIGHT,
      inlineCeiling,
    );
  }

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

  const handleShowInSidebar = () => {
    if (!toolCallId) return;
    showInSidebar(toolCallId);
  };

  const handleToggleFullscreen = useCallback(() => {
    setDisplayMode((mode) => (mode === "fullscreen" ? "inline" : "fullscreen"));
  }, []);

  const handleRefresh = useCallback(() => {
    setReloadNonce((nonce) => nonce + 1);
  }, []);

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

  // Chat inline shows fullscreen + a side-panel action on the right of the top
  // bar. When portaled into the panel, the side-panel action is dropped (the
  // panel selector governs which app shows there).
  const liveActions: McpAppAction[] = renderInSidebar
    ? ["fullscreen"]
    : ["fullscreen", "showInSidebar"];

  const liveSurface = (
    <McpAppErrorBoundary>
      <McpAppCard
        displayMode={displayMode}
        onToggleFullscreen={handleToggleFullscreen}
        diagnostics={diagnosticsBadge}
        size={size}
        inlineCeiling={inlineCeiling}
        fillContainer={renderInSidebar}
        appName={
          renderInSidebar && apps.length > 1 ? (
            <SidebarAppSwitcher
              apps={apps}
              value={selectedToolCallId}
              onSelect={select}
            />
          ) : (
            headerName
          )
        }
        onRefresh={handleRefresh}
        appId={appId}
        appVersion={appVersion}
        actions={liveActions}
        onShowInSidebar={
          toolCallId && !renderInSidebar ? handleShowInSidebar : undefined
        }
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
          // While portaled into the panel (fill mode), don't report size: that
          // would overwrite the last inline size and make the card return at the
          // panel's height when the panel closes.
          onSizeChange={renderInSidebar ? noopSizeChange : setSize}
          containerMaxHeight={renderInSidebar ? undefined : inlineCeiling}
          // Seed the iframe + loading box at the last measured inline height so a
          // reload (e.g. closing the panel re-mounts it) doesn't collapse then grow.
          inlineInitialHeight={
            size ? clampInlineHeight(size.height, inlineCeiling) : undefined
          }
          toolInput={appId ? undefined : toolInput}
          toolResult={toolResult}
          preloadedResource={preloadedResource}
          onResourceStateChange={handleResourceStateChange}
          onSendMessage={onSendMessage}
          appVersion={appVersion}
          reloadNonce={reloadNonce}
        />
      </McpAppCard>
    </McpAppErrorBoundary>
  );

  if (renderPlaceholder) {
    return (
      <>
        <McpAppCard
          displayMode="inline"
          onToggleFullscreen={handleToggleFullscreen}
          size={size}
          inlineCeiling={inlineCeiling}
          appName={headerName}
          frozenHeight={lastInlineHeightRef.current}
          appId={appId}
          // Unselected placeholders carry the open-in-sidebar action so the user
          // can switch the panel to this app; the selected one already shows it.
          actions={["showInSidebar"]}
          onShowInSidebar={isSelected ? undefined : handleShowInSidebar}
          placeholder={
            <span className="text-muted-foreground">
              {isSelected ? "Showing in sidebar" : "Open in the side panel"}
            </span>
          }
        />
        {renderInSidebar &&
          portalTarget &&
          createPortal(liveSurface, portalTarget)}
      </>
    );
  }

  return liveSurface;
}

/** App-switcher rendered in the panel card's header when the conversation has
 * more than one app, so the user can switch which app the panel shows. */
function SidebarAppSwitcher({
  apps,
  value,
  onSelect,
}: {
  apps: PanelApp[];
  value: string | null;
  onSelect: (toolCallId: string) => void;
}) {
  return (
    <Select value={value ?? undefined} onValueChange={onSelect}>
      <SelectTrigger className="h-7 w-auto max-w-[220px] gap-1 border-none bg-transparent px-2 text-xs font-medium shadow-none focus:ring-0">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {apps.map((app) => (
          <SelectItem key={app.toolCallId} value={app.toolCallId}>
            <span className="truncate">{app.label}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
