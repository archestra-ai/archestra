"use client";

import { getArchestraAppResourceUri } from "@archestra/shared";
import type { McpUiDisplayMode } from "@modelcontextprotocol/ext-apps";
import { useState } from "react";
import { useInlineCeiling } from "@/components/mcp-app/app-height";
import {
  type McpAppAction,
  McpAppActions,
} from "@/components/mcp-app/mcp-app-actions";
import { McpAppCard } from "@/components/mcp-app/mcp-app-card";
import {
  McpAppRefreshButton,
  McpAppTopBar,
  McpAppVersionBar,
} from "@/components/mcp-app/mcp-app-chrome";
import { McpAppRuntime } from "@/components/mcp-app/mcp-app-view";
import { useApp } from "@/lib/app.query";

// Mounts an app's runtime (sandboxed iframe + AppBridge) against the app-bound
// MCP endpoint, owning the display-mode state that chat's McpAppSection would
// otherwise supply, and wrapping it in the shared McpAppCard so the runtime gets
// the same action chrome (fullscreen, standalone) as chat. Used by the standalone
// run page and the detail preview.
export function AppRuntimeFrame({
  appId,
  actions = ["fullscreen"],
}: {
  appId: string;
  actions?: McpAppAction[];
}) {
  const inlineCeiling = useInlineCeiling();
  const [displayMode, setDisplayMode] = useState<McpUiDisplayMode>("inline");
  const [resourceState, setResourceState] = useState<
    "unknown" | "renderable" | "empty"
  >("unknown");
  const [reloadNonce, setReloadNonce] = useState(0);
  // Resolve the head version before mounting so this render persists
  // diagnostics under a concrete version — mounting earlier would capture (and
  // then discard) entries against a null version while the metadata loads.
  const { data: app } = useApp(appId);

  const handleToggleFullscreen = () =>
    setDisplayMode((mode) => (mode === "fullscreen" ? "inline" : "fullscreen"));

  return (
    <div className="h-full w-full">
      {app && (
        <McpAppCard
          displayMode={displayMode}
          onToggleFullscreen={handleToggleFullscreen}
          size={null}
          inlineCeiling={inlineCeiling}
          fillContainer
          topBar={
            <McpAppTopBar
              left={
                <McpAppRefreshButton
                  onClick={() => setReloadNonce((nonce) => nonce + 1)}
                />
              }
              center={app.name}
              right={
                <McpAppActions
                  appId={appId}
                  actions={actions}
                  isFullscreen={displayMode === "fullscreen"}
                  onToggleFullscreen={handleToggleFullscreen}
                />
              }
            />
          }
          bottomBar={
            app.latestVersion != null ? (
              <McpAppVersionBar appId={appId} version={app.latestVersion} />
            ) : undefined
          }
        >
          <McpAppRuntime
            toolResourceUri={getArchestraAppResourceUri(appId)}
            endpoint={{ kind: "app", appId }}
            appVersion={app.latestVersion}
            displayMode={displayMode}
            onDisplayModeChange={setDisplayMode}
            onSizeChange={() => {}}
            onResourceStateChange={setResourceState}
            reloadNonce={reloadNonce}
          />
        </McpAppCard>
      )}
      {resourceState === "empty" && (
        <p className="p-4 text-sm text-muted-foreground">
          This app has no visible content yet.
        </p>
      )}
    </div>
  );
}

// Mounts an external UI-providing MCP server's app against the server-scoped MCP
// endpoint (POST /api/mcp/server/:id). No app version / diagnostics — those are
// owned-app concepts; this runs the installed server's own UI resource.
export function ExternalAppRuntimeFrame({
  mcpServerId,
  resourceUri,
}: {
  mcpServerId: string;
  resourceUri: string;
}) {
  const [displayMode, setDisplayMode] = useState<McpUiDisplayMode>("inline");
  const [resourceState, setResourceState] = useState<
    "unknown" | "renderable" | "empty"
  >("unknown");

  return (
    <div className="h-full w-full">
      <McpAppRuntime
        toolResourceUri={resourceUri}
        endpoint={{ kind: "server", mcpServerId }}
        displayMode={displayMode}
        onDisplayModeChange={setDisplayMode}
        onSizeChange={() => {}}
        onResourceStateChange={setResourceState}
      />
      {resourceState === "empty" && (
        <p className="p-4 text-sm text-muted-foreground">
          This app has no visible content yet.
        </p>
      )}
    </div>
  );
}
