import { type archestraApiTypes, parseFullToolName } from "@archestra/shared";
import { AppWindow, MoreVertical, PanelRight, Trash2 } from "lucide-react";
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
import { AppDeleteDialog } from "@/app/apps/_parts/app-delete-dialog";
import { AppDiagnosticsPanel } from "@/components/chat/app-diagnostics-panel";
import { useApps } from "@/components/chat/apps-context";
import {
  isSupersededRender,
  mcpToolLabel,
} from "@/components/chat/chat-messages.utils";
import { INITIAL_INLINE_HEIGHT } from "@/components/mcp-app/app-height";
import { AppSettingsDialog } from "@/components/mcp-app/app-settings-dialog";
import { McpAppCard } from "@/components/mcp-app/mcp-app-card";
import {
  McpAppAddressPill,
  McpAppFullscreenExitButton,
  McpAppMarkerCircle,
  McpAppRefreshButton,
  McpAppSettingsButton,
  McpAppStandaloneButton,
  McpAppSwitcher,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useApp } from "@/lib/app.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
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

/**
 * Self-contained MCP App section for use inside a Tool collapsible.
 * Owns display-mode / size state and the rawToolResult derivation so the
 * parent only needs to forward the raw output from the tool part.
 */
export function McpAppSection({
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
}) {
  const resourceKey = `${agentId}:${uiResourceUri}`;
  const { displayMode, setDisplayMode, toggleFullscreen, reloadNonce, reload } =
    useAppRuntimeControls();
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  const [deleteOpen, setDeleteOpen] = useState(false);
  // Inline app visibility (the pill toggles it). Expanded/pressed by default so
  // the app shows inline as soon as it renders.
  const [expanded, setExpanded] = useState(true);
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
    apps,
    selectedToolCallId,
    select,
    showInPanel,
    closePanel,
    portalTarget,
    panelToolCallId,
    settingsOpen,
    setSettingsOpen,
  } = useApps();

  // Owned apps can be renamed/re-described from settings. Read the live app so
  // the title stays in sync after an edit (the appName prop is captured at
  // render time) and to seed the settings dialog.
  const inlineHeightCap = useInlineHeightCap();
  const { data: ownedApp, isSuccess: ownedAppResolved } = useApp(appId ?? null);
  const { data: canDelete } = useHasPermissions({ app: ["delete"] });
  // A deleted (or no-longer-accessible) owned app: the fetch settled but
  // `allowNotFound` turned the 404 into a successful `null`. Render a graceful
  // placeholder instead of mounting the runtime, which would 404 again.
  const ownedAppUnavailable = !!appId && ownedAppResolved && ownedApp === null;

  const headerName = ownedApp?.name || appName || mcpToolLabel(toolName);
  // This render is the one hosted in the right panel: its iframe is portaled
  // there and its inline spot becomes a compact marker circle. Every other
  // inline app keeps rendering live in the chat. Driven by the shared
  // `panelToolCallId` so chat and panel agree on which app is open.
  const renderInPanel = !!toolCallId && panelToolCallId === toolCallId;

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
    showInPanel(toolCallId);
  };

  // The pill toggles the inline app: press it to show the app inline (closing the
  // right panel if that's where it currently lives), press again to collapse.
  const handleTogglePill = () => {
    if (renderInPanel) {
      closePanel();
      setExpanded(true);
    } else {
      setExpanded((e) => !e);
    }
  };

  // Runtime-error count for the pill's status dot (owned apps only).
  const diagnosticCounts = useSyncExternalStore(
    subscribeAppDiagnostics,
    getAppDiagnosticCounts,
    getAppDiagnosticCounts,
  );
  const hasRuntimeError = appId
    ? (diagnosticCounts.get(appId)?.errors ?? 0) > 0
    : false;

  // Whether this owned app's latest render is the one currently displayed in the
  // right panel (drives the superseded marker's pressed state and toggle-to-close).
  const latestToolCallId = apps.find((a) => a.appId === appId)?.toolCallId;
  const shownInRightPanel =
    latestToolCallId !== undefined && panelToolCallId === latestToolCallId;

  const handleResourceStateChange = useCallback(
    (state: "renderable" | "empty") => {
      setResourceState({ key: resourceKey, state });
    },
    [resourceKey],
  );

  if (effectiveResourceState === "empty") {
    return null;
  }

  // A superseded render (a newer render of the same owned app exists in the
  // conversation) collapses to a compact app-icon pill instead of mounting the
  // live runtime, so only the latest render stays live. This older render is
  // never shown inline (never pressed); clicking it jumps to the latest render
  // in the right panel.
  if (isSupersededRender({ apps, toolCallId, appId })) {
    return (
      <>
        <McpAppMarkerCircle
          label={
            shownInRightPanel
              ? `${headerName} · Shown in right panel`
              : headerName
          }
          pressed={false}
          onClick={() => {
            if (latestToolCallId) showInPanel(latestToolCallId);
          }}
        />
        {toolDetails ? <div className="w-full">{toolDetails}</div> : null}
      </>
    );
  }

  // A deleted (or no-longer-accessible) owned app: it's already dropped from the
  // panel, so this only shows in the chat stream. Degrade to a small, light pill
  // instead of mounting the runtime (which would 404) behind browser-like chrome.
  if (ownedAppUnavailable) {
    return (
      <div className="flex w-fit items-center gap-1.5 rounded-md border border-border/60 bg-muted/30 px-2 py-1 text-xs text-muted-foreground">
        <AppWindow className="h-3.5 w-3.5 shrink-0" />
        <span>{headerName} app is no longer available</span>
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
      // While portaled into the panel (fill mode), don't report size: that
      // would overwrite the last inline size and make the card return at the
      // panel's height when the panel closes.
      onSizeChange={renderInPanel ? noopSizeChange : setSize}
      // Seed the iframe + loading box at the last measured inline height so a
      // reload (e.g. closing the panel re-mounts it) doesn't collapse then grow.
      inlineInitialHeight={size?.height ?? INITIAL_INLINE_HEIGHT}
      // Cap the inline chat surface at the card's visual ceiling so a
      // viewport-relative app can't inflate the iframe without bound. Panel
      // (fill) and fullscreen stay uncapped.
      containerDimensions={
        !renderInPanel && displayMode !== "fullscreen"
          ? { maxHeight: inlineHeightCap }
          : undefined
      }
      toolInput={appId ? undefined : toolInput}
      toolResult={toolResult}
      preloadedResource={preloadedResource}
      onResourceStateChange={handleResourceStateChange}
      onSendMessage={onSendMessage}
      appVersion={appVersion}
      reloadNonce={reloadNonce}
    />
  );

  // Side-panel header (item 5): full-size buttons — refresh, open-standalone,
  // settings (owned apps) and a kebab with delete (owned apps). Center is the
  // app name, or an app switcher when the panel hosts several apps.
  const isOwnedInPanel = renderInPanel && !!appId && !!ownedApp;
  const panelCenter =
    renderInPanel && apps.length > 1 ? (
      <McpAppSwitcher
        value={selectedToolCallId}
        options={apps.map((app) => ({
          value: app.toolCallId,
          label: app.label,
        }))}
        onChange={select}
      />
    ) : (
      <McpAppAddressPill label={headerName} />
    );
  const panelTopBar = (
    <McpAppTopBar
      right={
        <>
          <McpAppRefreshButton onClick={reload} size="bar" />
          {appId ? <McpAppStandaloneButton appId={appId} size="bar" /> : null}
          {isOwnedInPanel ? (
            <McpAppSettingsButton onClick={() => setSettingsOpen(true)} />
          ) : null}
          {isOwnedInPanel && canDelete ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground"
                  aria-label="More actions"
                >
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => setDeleteOpen(true)}
                >
                  <Trash2 className="h-4 w-4" />
                  Delete app
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </>
      }
    >
      {panelCenter}
    </McpAppTopBar>
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
        fillContainer={renderInPanel}
        capInlineHeight
        topBar={renderInPanel ? panelTopBar : undefined}
        overlay={renderInPanel ? undefined : inlineOverlay}
      >
        {runtimeNode}
      </McpAppCard>
    </McpAppErrorBoundary>
  );

  // Runtime-error / log summary lives below the app in the chat stream, never
  // inside the height-constrained panel (item 3).
  const diagnostics = appId ? <AppDiagnosticsPanel appId={appId} /> : null;

  // The app marker is always a top-level flex item, so it sits on the same row
  // as the host tool-call circle. Pressed = the app is expanded inline; it reads
  // unpressed while the app lives in the right panel. A red dot flags a runtime
  // error. Clicking toggles the inline app (and closes the panel if the app is
  // there — see handleTogglePill).
  const pressed = !renderInPanel && expanded;
  const marker = (
    <McpAppMarkerCircle
      label={
        renderInPanel ? `${headerName} · Shown in right panel` : headerName
      }
      pressed={pressed}
      hasError={hasRuntimeError}
      onClick={handleTogglePill}
    />
  );

  // Everything under the circle+marker row stacks in one full-width column:
  // tool-call details (above the app), then the inline app card + its
  // "Open in right panel" button, then the diagnostics summary. The inline app
  // is CSS-hidden (not unmounted) when collapsed so its iframe keeps its state;
  // it's absent entirely while the app is portaled into the panel.
  const belowColumn = (
    <div className="flex w-full flex-col items-start gap-2">
      {toolDetails ? <div className="w-full">{toolDetails}</div> : null}
      {!renderInPanel ? (
        <div
          className={cn(
            "flex w-full flex-col items-start gap-2",
            !expanded && "hidden",
          )}
        >
          {liveSurface}
          {toolCallId && displayMode !== "fullscreen" ? (
            // Match the card's 80% width and right-justify so the button lines
            // up with the app's right edge, not the full chat width.
            <div className="flex w-full max-w-[80%] justify-end">
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
        </div>
      ) : null}
      {diagnostics}
    </div>
  );

  return (
    <>
      {marker}
      {belowColumn}
      {renderInPanel && portalTarget
        ? createPortal(liveSurface, portalTarget)
        : null}
      {/* Settings + delete for the panel-hosted owned app. Both are modals
          (portal to body), so their position here is irrelevant (items 6, 7). */}
      {isOwnedInPanel && ownedApp ? (
        <>
          <AppSettingsDialog
            appId={appId}
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
          />
          <AppDeleteDialog
            app={{ id: ownedApp.id, name: ownedApp.name }}
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            onDeleted={closePanel}
          />
        </>
      ) : null}
    </>
  );
}
