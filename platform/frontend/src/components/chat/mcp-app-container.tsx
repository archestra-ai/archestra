import { type archestraApiTypes, parseFullToolName } from "@archestra/shared";
import { PanelRight } from "lucide-react";
import type React from "react";
import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { AppDiagnosticsPanel } from "@/components/chat/app-diagnostics-panel";
import { useApps } from "@/components/chat/apps-context";
import { mcpToolLabel } from "@/components/chat/chat-messages.utils";
import { INITIAL_INLINE_HEIGHT } from "@/components/mcp-app/app-height";
import { AppSettingsDialog } from "@/components/mcp-app/app-settings-dialog";
import { McpAppCard } from "@/components/mcp-app/mcp-app-card";
import {
  McpAppFullscreenExitButton,
  McpAppPill,
  McpAppRefreshButton,
  McpAppSettingsButton,
  McpAppStandaloneButton,
  McpAppTopBar,
} from "@/components/mcp-app/mcp-app-chrome";
import {
  type AppResourceMeta,
  isRenderableMcpAppHtml,
  McpAppRuntime,
  type McpCallToolResult,
} from "@/components/mcp-app/mcp-app-view";
import { useAppRuntimeControls } from "@/components/mcp-app/use-app-runtime-controls";
import { Button } from "@/components/ui/button";
import { useApp } from "@/lib/app.query";
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
 * The chat-inline card caps its body at `max(320px, 60vh)` and the runtime
 * clamps the iframe to this ceiling. Some apps size their layout to the iframe
 * viewport (e.g. `100vh`); the auto-resize SDK then measures content that grows
 * with the viewport, so each report makes the next taller and the host would
 * inflate the iframe without bound. Clamping settles the loop (content scrolls
 * within the iframe). Tracks `innerHeight` so the cap follows window resizes.
 */
function computeInlineHeightCap() {
  return typeof window === "undefined"
    ? INITIAL_INLINE_HEIGHT
    : Math.max(INITIAL_INLINE_HEIGHT, Math.round(window.innerHeight * 0.6));
}

function useInlineHeightCap() {
  const [cap, setCap] = useState(computeInlineHeightCap);
  useEffect(() => {
    const update = () => setCap(computeInlineHeightCap());
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return cap;
}

type McpAppSectionProps = {
  uiResourceUri: string;
  agentId: string;
  /**
   * Where this render lives. "inline" (default) is the chat-stream render: a pill
   * plus the app under it when open. "panel" is the right-panel host: the fill
   * card only (no pill), rendered directly — no portal.
   */
  surface?: "inline" | "panel";
  /**
   * Owned-app render: drive the app-bound endpoint (`/api/mcp/app/:appId`)
   * instead of the agent gateway. Set for Archestra-authored apps surfaced by
   * the app-management tools; the management tool's input/result are not
   * forwarded into the iframe (they are not app data).
   */
  appId?: string;
  /**
   * External app render against a concrete install: drive the server endpoint
   * (`/api/mcp/server/:id`) instead of the agent gateway. Set for the apps-page
   * open-in-chat deep link (the conversation's agent need not have the server).
   */
  mcpServerId?: string | null;
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
  /**
   * Expanded tool-call details (input/output) from the host tool card. Rendered
   * at the top of the column below the marker, so it sits above the inline app.
   */
  toolDetails?: React.ReactNode;
  /** Called when the MCP App sends a ui/message request to inject a user message into the conversation */
  onSendMessage?: (text: string) => void;
};

/**
 * Self-contained MCP App section for use inside a Tool collapsible or the
 * right panel. On the inline surface it composes the app pill (row element)
 * with the app content below; the compact tool row renders those two halves
 * separately via {@link McpAppEntryPill} and {@link McpAppEntryContent} so
 * consecutive pills share one line.
 */
export function McpAppSection(props: McpAppSectionProps) {
  if (props.surface === "panel") {
    return <McpAppEntryContent {...props} />;
  }
  return (
    <>
      <McpAppEntryPill
        appId={props.appId}
        appName={props.appName}
        toolName={props.toolName}
        toolCallId={props.toolCallId}
      />
      <McpAppEntryContent {...props} />
    </>
  );
}

/**
 * The app pill in the compact tool-call row: app icon + name, pressed while
 * the app's inline render is expanded. Clicking toggles the inline render, or
 * selects/collapses the panel-hosted copy while the right panel is open.
 * State is shared with {@link McpAppEntryContent} through the apps context
 * (keyed by toolCallId), so the two halves can live in different DOM slots.
 */
export function McpAppEntryPill({
  appId,
  appName,
  toolName,
  toolCallId,
  icon,
  state,
  onClick,
}: {
  appId?: string;
  appName?: string | null;
  /** Full prefixed tool name — fallback label when no app name is known. */
  toolName: string;
  toolCallId?: string;
  /** App icon (e.g. an McpCatalogIcon); falls back to the generic app glyph. */
  icon?: React.ReactNode;
  /** Tool-call state for the status dot, matching the tool-call circles. */
  state?: "running" | "completed" | "error" | "denied";
  /** Runs on every pill click, before the app toggle (e.g. to collapse an
   * expanded tool-call card so only one thing opens under the row). */
  onClick?: () => void;
}) {
  const {
    isAppOpen,
    toggleAppOpen,
    focusAppRender,
    panelToolCallId,
    setPanelApp,
    canonicalToolCallId,
    closePanel,
    portalTarget,
  } = useApps();
  // Owned apps can be renamed from settings; read the live app so the label
  // stays in sync after an edit (the appName prop is captured at render time).
  const { data: ownedApp, isSuccess: ownedAppResolved } = useApp(appId ?? null);
  const ownedAppUnavailable = !!appId && ownedAppResolved && ownedApp === null;
  const headerName = ownedApp?.name || appName || mcpToolLabel(toolName);

  const standalone = !toolCallId;
  const canonicalId = toolCallId ? canonicalToolCallId(toolCallId) : undefined;
  const isPanelFocused =
    !!portalTarget && !!canonicalId && panelToolCallId === canonicalId;
  const pressed =
    !portalTarget && (standalone || (!!toolCallId && isAppOpen(toolCallId)));

  // Runtime-error count for the pill's status dot (owned apps only).
  const diagnosticCounts = useSyncExternalStore(
    subscribeAppDiagnostics,
    getAppDiagnosticCounts,
    getAppDiagnosticCounts,
  );
  const hasRuntimeError = appId
    ? (diagnosticCounts.get(appId)?.errors ?? 0) > 0
    : false;

  return (
    <McpAppPill
      label={headerName}
      icon={icon}
      state={state}
      pressed={pressed}
      hasError={hasRuntimeError || ownedAppUnavailable}
      onClick={() => {
        onClick?.();
        if (!toolCallId) return;
        // With the panel open, pills select the hosted app; otherwise they toggle
        // this app's inline render, leaving other open apps alone.
        if (portalTarget) {
          if (isPanelFocused) {
            // Dismissing the panel via a pill expands the app inline under
            // THIS pill — not wherever the app was last expanded.
            closePanel();
            focusAppRender(toolCallId);
          } else {
            setPanelApp(toolCallId);
          }
        } else {
          toggleAppOpen(toolCallId);
        }
      }}
    />
  );
}

/**
 * The app's content below the tool-call row: the inline app card (while
 * expanded), its panel/diagnostics affordances, or the panel-surface fill
 * card. Owns display-mode / size state and the rawToolResult derivation so
 * the parent only needs to forward the raw output from the tool part.
 * Renders nothing while the app is collapsed inline.
 */
export function McpAppEntryContent({
  uiResourceUri,
  agentId,
  appId,
  mcpServerId,
  appName,
  appVersion,
  toolName,
  toolCallId,
  toolInput,
  rawOutput,
  preloadedResource,
  toolDetails,
  onSendMessage,
  surface = "inline",
}: McpAppSectionProps) {
  const resourceKey = `${agentId}:${uiResourceUri}`;
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

  const {
    isAppOpen,
    setPanelApp,
    openRightPanel,
    portalTarget,
    settingsOpen,
    setSettingsOpen,
  } = useApps();

  // Owned apps can be renamed/re-described from settings. Read the live app so
  // the title stays in sync after an edit (the appName prop is captured at
  // render time) and to seed the settings dialog.
  const inlineHeightCap = useInlineHeightCap();
  const { data: ownedApp, isSuccess: ownedAppResolved } = useApp(appId ?? null);
  // A deleted (or no-longer-accessible) owned app: the fetch settled but
  // `allowNotFound` turned the 404 into a successful `null`. Render a graceful
  // placeholder instead of mounting the runtime, which would 404 again.
  const ownedAppUnavailable = !!appId && ownedAppResolved && ownedApp === null;

  const headerName = ownedApp?.name || appName || mcpToolLabel(toolName);
  const isPanelSurface = surface === "panel";
  const standalone = !toolCallId;
  // Expanded inline when the panel isn't hosting and this render is standalone or
  // the open canonical one. Multiple apps can be expanded at once.
  const expandedInline =
    !isPanelSurface &&
    !portalTarget &&
    (standalone || (!!toolCallId && isAppOpen(toolCallId)));

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

  const handleShowInPanel = () => {
    if (!toolCallId) return;
    setDisplayMode("inline"); // panel is the app's frame — never fullscreen there
    setPanelApp(toolCallId);
    openRightPanel();
  };

  const handleResourceStateChange = useCallback(
    (state: "renderable" | "empty") => {
      setResourceState({ key: resourceKey, state });
    },
    [resourceKey],
  );

  if (effectiveResourceState === "empty") {
    // A blank app document reserves no canvas (a blank render is usually a bug).
    // In the panel — which the user opened deliberately and which passes no tool
    // details — show an explicit empty state rather than a blank panel; inline,
    // keep the tool-call details inspectable (while the pill is expanded)
    // instead of dropping the section.
    if (surface === "panel") {
      return (
        <div className="flex h-full w-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
          This app rendered nothing to display.
        </div>
      );
    }
    return expandedInline && toolDetails ? (
      <div className="mt-2 w-full">{toolDetails}</div>
    ) : null;
  }

  // A deleted (or no-longer-accessible) owned app: it's already dropped from the
  // panel, so this only shows in the chat stream. Its pill carries a red error
  // dot; while expanded, show the unavailable message styled as an error instead
  // of mounting the runtime (which would 404).
  if (ownedAppUnavailable) {
    if (!expandedInline) return null;
    return (
      <div className="mt-2 flex w-full flex-col items-start gap-2">
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          {headerName} app is no longer available
        </div>
      </div>
    );
  }

  const runtimeNode = (
    <McpAppRuntime
      toolResourceUri={uiResourceUri}
      endpoint={
        appId
          ? { kind: "app", appId }
          : mcpServerId
            ? { kind: "server", mcpServerId }
            : {
                kind: "agent",
                agentId,
                serverPrefix:
                  parseFullToolName(toolName).serverName ?? toolName,
              }
      }
      displayMode={displayMode}
      onDisplayModeChange={setDisplayMode}
      // On the panel surface (fill mode) don't report size: that would overwrite
      // the inline instance's last size.
      onSizeChange={isPanelSurface ? noopSizeChange : setSize}
      // Seed the iframe + loading box at the last measured inline height so a
      // fresh mount doesn't collapse then grow.
      inlineInitialHeight={size?.height ?? INITIAL_INLINE_HEIGHT}
      // Cap the inline chat surface at the card's visual ceiling so a
      // viewport-relative app can't inflate the iframe without bound. Panel
      // (fill) and fullscreen stay uncapped.
      containerDimensions={
        !isPanelSurface && displayMode !== "fullscreen"
          ? { maxHeight: inlineHeightCap }
          : undefined
      }
      toolInput={appId ? undefined : toolInput}
      toolResult={toolResult}
      preloadedResource={preloadedResource}
      onResourceStateChange={handleResourceStateChange}
      onSendMessage={onSendMessage}
      // Fall back to the resolved app's head version so a render bound only by
      // appId (e.g. an `__open` launch) still persists diagnostics/screenshots,
      // which the runtime gates on a non-null version.
      appVersion={appVersion ?? ownedApp?.latestVersion ?? null}
      reloadNonce={reloadNonce}
      // Third-party apps (no appId) are incidental to a tool call: if their
      // upstream can't serve the advertised ui:// resource, fold the app away
      // and keep the plain tool result rather than showing a load error.
      // Owned apps keep surfacing errors — a failure there is an authoring bug.
      degradeResourceLoadError={!appId}
    />
  );

  // Side-panel header: Refresh sits ahead of the plainly left-aligned app name;
  // Settings (owned apps) and Open-in-tab (owned apps) are labeled buttons on the
  // right. App selection lives in the chat pills, so there's no switcher here.
  const isOwnedInPanel = isPanelSurface && !!appId && !!ownedApp;
  const panelTopBar = (
    <McpAppTopBar
      left={
        <>
          <McpAppRefreshButton onClick={reload} size="bar" />
          <span className="min-w-0 truncate px-1 text-sm font-medium">
            {headerName}
          </span>
        </>
      }
      right={
        <>
          {appId ? <McpAppStandaloneButton appId={appId} /> : null}
          {isOwnedInPanel ? (
            <McpAppSettingsButton onClick={() => setSettingsOpen(true)} />
          ) : null}
        </>
      }
    />
  );

  // Frameless inline (item 4): no top bar — chat context identifies the app.
  // Only fullscreen-exit floats as a hover overlay (while fullscreen). The
  // open-in-right-panel control is a labeled button below the app instead.
  const inlineOverlay =
    displayMode === "fullscreen" ? (
      <McpAppFullscreenExitButton onClick={toggleFullscreen} />
    ) : null;

  const liveSurface = (
    <McpAppErrorBoundary>
      <McpAppCard
        displayMode={displayMode}
        onToggleFullscreen={toggleFullscreen}
        fillContainer={isPanelSurface}
        capInlineHeight
        topBar={isPanelSurface ? panelTopBar : undefined}
        overlay={isPanelSurface ? undefined : inlineOverlay}
      >
        {runtimeNode}
      </McpAppCard>
    </McpAppErrorBoundary>
  );

  // The panel surface is the right-panel host: just the fill card (with its top
  // bar) plus the owned-app settings modal. No pill, no diagnostics — the inline
  // instance owns those in the chat stream.
  if (isPanelSurface) {
    return (
      <>
        {liveSurface}
        {isOwnedInPanel ? (
          <AppSettingsDialog
            appId={appId}
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
          />
        ) : null}
      </>
    );
  }

  // Nothing below the row while the app is collapsed inline (or hosted in the
  // right panel). The component stays mounted so the last measured size
  // survives a collapse/expand cycle.
  if (!expandedInline) {
    return null;
  }

  // Runtime-error / log summary lives below the app in the chat stream, never
  // inside the height-constrained panel (item 3).
  const diagnostics = appId ? <AppDiagnosticsPanel appId={appId} /> : null;

  // The app card, its "Open in right panel" button, and the diagnostics
  // summary. mt-2 matches the row → expanded-tool-card gap so every panel
  // opening under the pill row sits 8px below it.
  return (
    <div className="mt-2 flex w-full flex-col items-start gap-2">
      {liveSurface}
      {toolCallId && displayMode !== "fullscreen" ? (
        // Match the card's 80% width and right-justify so the buttons line
        // up with the app's right edge, not the full chat width.
        <div className="flex w-full max-w-[80%] justify-end gap-1">
          {appId ? <McpAppStandaloneButton appId={appId} /> : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={handleShowInPanel}
          >
            <PanelRight className="h-3.5 w-3.5" />
            Open in right panel
          </Button>
        </div>
      ) : null}
      {diagnostics}
    </div>
  );
}
