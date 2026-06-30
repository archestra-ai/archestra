import { type archestraApiTypes, parseFullToolName } from "@archestra/shared";
import { AppWindow } from "lucide-react";
import type React from "react";
import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { useApps } from "@/components/chat/apps-context";
import {
  getAppRenderVerb,
  isSupersededRender,
  mcpToolLabel,
} from "@/components/chat/chat-messages.utils";
import { INITIAL_INLINE_HEIGHT } from "@/components/mcp-app/app-height";
import { AppSettingsForm } from "@/components/mcp-app/app-settings-form";
import { McpAppCard } from "@/components/mcp-app/mcp-app-card";
import {
  McpAppAddressPill,
  McpAppBackButton,
  McpAppChangelogPill,
  McpAppFullscreenExitButton,
  McpAppPanelButton,
  McpAppRefreshButton,
  McpAppSaveButton,
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
import { useApp } from "@/lib/app.query";
import {
  getAppDiagnosticCounts,
  subscribeAppDiagnostics,
} from "@/lib/chat/app-diagnostics-store";

// Ties the settings form to its top-bar save button via the HTML `form` attr.
// Only the selected panel app shows settings (one at a time), so a single id is
// safe.
const APP_SETTINGS_FORM_ID = "app-settings-form";

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
  const { displayMode, setDisplayMode, toggleFullscreen, reloadNonce, reload } =
    useAppRuntimeControls();
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  // Mirrors the settings form's save state so the top bar's save button (which
  // lives outside that form) can disable / show a spinner.
  const [settingsSaveStatus, setSettingsSaveStatus] = useState({
    saving: false,
    disabled: false,
  });
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
    settingsOpen,
    setSettingsOpen,
  } = useApps();

  // Owned apps can be renamed/re-described from the address bar. Read the live
  // app so the title stays in sync after an edit (the appName prop is captured
  // at render time) and to seed the edit dialog.
  const inlineHeightCap = useInlineHeightCap();
  const { data: ownedApp, isSuccess: ownedAppResolved } = useApp(appId ?? null);
  // A deleted (or no-longer-accessible) owned app: the fetch settled but
  // `allowNotFound` turned the 404 into a successful `null`. Render a graceful
  // placeholder instead of mounting the runtime, which would 404 again.
  const ownedAppUnavailable = !!appId && ownedAppResolved && ownedApp === null;

  const headerName = ownedApp?.name || appName || mcpToolLabel(toolName);
  const isSelected = !!toolCallId && selectedToolCallId === toolCallId;
  const panelHostingActive = portalTarget !== null;
  // Only the *selected* app moves to the panel: its iframe is portaled into
  // the panel and its inline spot becomes a placeholder. Every other inline app
  // keeps rendering live in the chat.
  const renderInPanel = panelHostingActive && isSelected;

  // Track the last inline body height while the app shows inline; once it moves
  // to the panel we stop updating, so the chat placeholder keeps that frozen
  // footprint and messages below it don't reflow.
  const lastInlineHeightRef = useRef(INITIAL_INLINE_HEIGHT);
  if (!renderInPanel) {
    lastInlineHeightRef.current = size?.height ?? INITIAL_INLINE_HEIGHT;
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

  const handleShowInPanel = () => {
    if (!toolCallId) return;
    setDisplayMode("inline"); // panel is the app's frame — never fullscreen there
    showInPanel(toolCallId);
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

  // A superseded render (a newer render of the same app — keyed by
  // uiResourceUri — exists in the conversation) collapses to a static changelog
  // pill instead of mounting the live runtime, so only the latest render of each
  // app stays live. Applies to both owned apps and external MCP-UI calls; the
  // pill degrades to just the label for non-owned renders (no version/verb).
  if (isSupersededRender({ apps, toolCallId, appId })) {
    return (
      <McpAppChangelogPill
        appName={appName ?? mcpToolLabel(toolName)}
        version={appVersion ?? null}
        verb={getAppRenderVerb(toolName)}
      />
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

  // The address bar every surface shares: refresh as the leading icon and
  // open-in-new-tab as the trailing in-pill action (matching the side panel).
  // The switcher only applies in the single panel slot; inline renders are each
  // their own card, so they always get the static pill.
  const refreshLeading = <McpAppRefreshButton onClick={reload} />;
  const standaloneAction = appId ? (
    <McpAppStandaloneButton appId={appId} />
  ) : null;
  const addressBar =
    renderInPanel && apps.length > 1 ? (
      <McpAppSwitcher
        value={selectedToolCallId}
        options={apps.map((app) => ({
          value: app.toolCallId,
          label: app.label,
        }))}
        onChange={select}
        leading={refreshLeading}
        actions={standaloneAction}
      />
    ) : (
      <McpAppAddressPill
        label={headerName}
        leading={refreshLeading}
        actions={standaloneAction}
      />
    );

  const runtimeNode = (
    <McpAppRuntime
      toolResourceUri={uiResourceUri}
      endpoint={
        appId
          ? { kind: "app", appId }
          : {
              kind: "agent",
              agentId,
              serverPrefix: parseFullToolName(toolName).serverName ?? toolName,
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

  // Every surface shows the same centered address bar. The owned-app side panel
  // adds a single settings gear on the right that swaps the body for the inline
  // settings form; in settings mode the bar becomes cancel/save — a back arrow
  // (left, discards edits) and a save action (right, submits the form). The
  // inline chat surface adds the fullscreen-exit (only while fullscreen) and
  // show-in-panel controls.
  let topBar: React.ReactNode;
  let body: React.ReactNode;
  if (renderInPanel && appId && ownedApp && settingsOpen) {
    topBar = (
      <McpAppTopBar
        left={<McpAppBackButton onClick={() => setSettingsOpen(false)} />}
        right={
          <McpAppSaveButton
            formId={APP_SETTINGS_FORM_ID}
            disabled={settingsSaveStatus.disabled}
            saving={settingsSaveStatus.saving}
          />
        }
      >
        <span className="px-1 text-xs font-medium text-muted-foreground">
          Settings
        </span>
      </McpAppTopBar>
    );
    body = (
      <AppSettingsForm
        app={ownedApp}
        onBack={() => setSettingsOpen(false)}
        formId={APP_SETTINGS_FORM_ID}
        onStatusChange={setSettingsSaveStatus}
        onDeleted={closePanel}
      />
    );
  } else {
    const right =
      renderInPanel && appId && ownedApp ? (
        <McpAppSettingsButton onClick={() => setSettingsOpen(true)} />
      ) : (
        <>
          {displayMode === "fullscreen" && (
            <McpAppFullscreenExitButton onClick={toggleFullscreen} />
          )}
          {toolCallId && !renderInPanel && (
            <McpAppPanelButton onClick={handleShowInPanel} />
          )}
        </>
      );
    topBar = <McpAppTopBar right={right}>{addressBar}</McpAppTopBar>;
    body = runtimeNode;
  }

  const liveSurface = (
    <McpAppErrorBoundary>
      <McpAppCard
        displayMode={displayMode}
        onToggleFullscreen={toggleFullscreen}
        diagnostics={diagnosticsBadge}
        fillContainer={renderInPanel}
        capInlineHeight
        topBar={topBar}
      >
        {body}
      </McpAppCard>
    </McpAppErrorBoundary>
  );

  const surface = renderInPanel ? (
    <>
      <McpAppCard
        displayMode="inline"
        onToggleFullscreen={toggleFullscreen}
        frozenHeight={lastInlineHeightRef.current}
        capInlineHeight
        topBar={
          <McpAppTopBar>
            <McpAppAddressPill label={headerName} />
          </McpAppTopBar>
        }
        placeholder={
          <span className="text-muted-foreground">Showing in panel</span>
        }
      />
      {portalTarget && createPortal(liveSurface, portalTarget)}
    </>
  ) : (
    liveSurface
  );

  return surface;
}
