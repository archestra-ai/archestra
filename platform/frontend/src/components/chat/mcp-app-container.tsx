import { type archestraApiTypes, parseFullToolName } from "@archestra/shared";
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
import { useApps } from "@/components/chat/apps-context";
import {
  getAppRenderVerb,
  humanizeToolLabel,
  isSupersededOwnedRender,
} from "@/components/chat/chat-messages.utils";
import {
  clampInlineHeight,
  INITIAL_INLINE_HEIGHT,
  useInlineCeiling,
} from "@/components/mcp-app/app-height";
import { McpAppCard } from "@/components/mcp-app/mcp-app-card";
import {
  McpAppAddressPill,
  McpAppChangelogPill,
  McpAppFullscreenExitButton,
  McpAppRefreshButton,
  McpAppSidebarButton,
  McpAppStandaloneButton,
  McpAppSwitcher,
  McpAppTopBar,
  McpAppVersionBar,
} from "@/components/mcp-app/mcp-app-chrome";
import {
  type AppResourceMeta,
  isRenderableMcpAppHtml,
  McpAppRuntime,
  type McpCallToolResult,
} from "@/components/mcp-app/mcp-app-view";
import { useAppRuntimeControls } from "@/components/mcp-app/use-app-runtime-controls";
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
  const { displayMode, setDisplayMode, toggleFullscreen, reloadNonce, reload } =
    useAppRuntimeControls();
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

  const { apps, selectedToolCallId, select, showInSidebar, portalTarget } =
    useApps();

  const headerName = appName || humanizeToolLabel(toolName);
  const isSelected = !!toolCallId && selectedToolCallId === toolCallId;
  const sidebarHostingActive = portalTarget !== null;
  // Only the *selected* app moves to the sidebar: its iframe is portaled into
  // the panel and its inline spot becomes a placeholder. Every other inline app
  // keeps rendering live in the chat.
  const renderInSidebar = sidebarHostingActive && isSelected;

  // Track the last inline body height while the app shows inline; once it moves
  // to the panel we stop updating, so the chat placeholder keeps that frozen
  // footprint and messages below it don't reflow.
  const lastInlineHeightRef = useRef(INITIAL_INLINE_HEIGHT);
  if (!renderInSidebar) {
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

  // A superseded owned-app render (a newer render of the same app exists in the
  // conversation) collapses to a static changelog pill instead of mounting the
  // live runtime — only the latest render of each app stays live. External
  // MCP-UI renders have no appId and are distinct invocations, never superseded.
  if (appId && isSupersededOwnedRender({ apps, appId, toolCallId })) {
    return (
      <McpAppChangelogPill
        appName={appName ?? null}
        version={appVersion ?? null}
        verb={getAppRenderVerb(toolName)}
      />
    );
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

  const pillActions = (
    <>
      <McpAppRefreshButton onClick={reload} />
      {displayMode === "fullscreen" && (
        <McpAppFullscreenExitButton onClick={toggleFullscreen} />
      )}
      {appId && <McpAppStandaloneButton appId={appId} />}
    </>
  );

  const liveSurface = (
    <McpAppErrorBoundary>
      <McpAppCard
        displayMode={displayMode}
        onToggleFullscreen={toggleFullscreen}
        diagnostics={diagnosticsBadge}
        size={size}
        inlineCeiling={inlineCeiling}
        fillContainer={renderInSidebar}
        topBar={
          // Refresh, plus a fullscreen-exit button that only appears while
          // fullscreen (the enter icon is hidden for now, but app-requested
          // fullscreen stays usable), plus open-standalone for owned apps.
          <McpAppTopBar
            right={
              toolCallId && !renderInSidebar ? (
                <McpAppSidebarButton onClick={handleShowInSidebar} />
              ) : undefined
            }
          >
            {renderInSidebar && apps.length > 1 ? (
              <McpAppSwitcher
                value={selectedToolCallId}
                options={apps.map((app) => ({
                  value: app.toolCallId,
                  label: app.label,
                }))}
                onChange={select}
                actions={pillActions}
              />
            ) : (
              <McpAppAddressPill label={headerName} actions={pillActions} />
            )}
          </McpAppTopBar>
        }
        bottomBar={
          appId && appVersion != null ? (
            <McpAppVersionBar appId={appId} version={appVersion} />
          ) : undefined
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
          containerDimensions={
            renderInSidebar ? undefined : { maxHeight: inlineCeiling }
          }
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

  if (renderInSidebar) {
    return (
      <>
        <McpAppCard
          displayMode="inline"
          onToggleFullscreen={toggleFullscreen}
          size={size}
          inlineCeiling={inlineCeiling}
          frozenHeight={lastInlineHeightRef.current}
          topBar={
            <McpAppTopBar>
              <McpAppAddressPill label={headerName} />
            </McpAppTopBar>
          }
          placeholder={
            <span className="text-muted-foreground">Showing in sidebar</span>
          }
        />
        {portalTarget && createPortal(liveSurface, portalTarget)}
      </>
    );
  }

  return liveSurface;
}
