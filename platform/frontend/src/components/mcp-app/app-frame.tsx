"use client";

import { getArchestraAppResourceUri } from "@archestra/shared";
import type { ReactNode } from "react";
import { useInlineCeiling } from "@/components/mcp-app/app-height";
import { McpAppCard } from "@/components/mcp-app/mcp-app-card";
import {
  McpAppAddressPill,
  McpAppFullscreenExitButton,
  McpAppRefreshButton,
  McpAppTopBar,
  McpAppVersionBar,
} from "@/components/mcp-app/mcp-app-chrome";
import { McpAppRuntime } from "@/components/mcp-app/mcp-app-view";
import { useAppRuntimeControls } from "@/components/mcp-app/use-app-runtime-controls";
import { useApp } from "@/lib/app.query";
import { cn } from "@/lib/utils";

/** Stable no-op size reporter: page surfaces fill their own layout. */
const noopSizeChange = () => {};

const EMPTY_MESSAGE = (
  <p className="p-4 text-sm text-muted-foreground">
    This app has no visible content yet.
  </p>
);

/**
 * The full-page MCP App frame, shared by the app detail preview, the standalone
 * run page, and external MCP-server run pages. Owns the display-mode / reload /
 * resource state (via {@link useAppRuntimeControls}) and wraps {@link McpAppRuntime}
 * in the shared {@link McpAppCard} with the standard chrome — replacing the
 * former route-local `AppRuntimeFrame` / `ExternalAppRuntimeFrame`.
 *
 * Owned apps (`endpoint.kind === "app"`) resolve their name + head version here
 * so the runtime mounts under a concrete version (diagnostics keying). External
 * servers pass an explicit `resourceUri` and render bare via `chrome={false}`.
 *
 * Extra address-pill buttons (e.g. open-standalone) are composed by the caller
 * and passed via `actions` — there is no action enum.
 */
export function AppFrame({
  endpoint,
  resourceUri,
  label,
  actions,
  fillContainer = false,
  chrome = true,
}: {
  endpoint:
    | { kind: "app"; appId: string }
    | { kind: "server"; mcpServerId: string };
  /** Required for server endpoints; owned apps derive it from the app id. */
  resourceUri?: string;
  /** Address-pill label; owned apps fall back to the resolved app name. */
  label?: string;
  actions?: ReactNode;
  fillContainer?: boolean;
  /** When false, render the bare runtime with no card/chrome (external run page). */
  chrome?: boolean;
}) {
  const inlineCeiling = useInlineCeiling();
  const {
    displayMode,
    setDisplayMode,
    toggleFullscreen,
    reloadNonce,
    reload,
    resourceState,
    setResourceState,
  } = useAppRuntimeControls();

  const appId = endpoint.kind === "app" ? endpoint.appId : null;
  const { data: app } = useApp(appId);
  const resolvedResourceUri = appId
    ? getArchestraAppResourceUri(appId)
    : resourceUri;

  const runtime = resolvedResourceUri ? (
    <McpAppRuntime
      toolResourceUri={resolvedResourceUri}
      endpoint={endpoint}
      appVersion={app?.latestVersion}
      displayMode={displayMode}
      onDisplayModeChange={setDisplayMode}
      onSizeChange={noopSizeChange}
      onResourceStateChange={setResourceState}
      reloadNonce={reloadNonce}
    />
  ) : null;

  if (!chrome) {
    // fillContainer forces the iframe to fill (same override as McpAppCard);
    // otherwise it sizes to the guest's reported content height.
    return (
      <div
        className={cn(
          "h-full w-full",
          fillContainer &&
            "overflow-hidden [&>div]:!h-full [&_iframe]:!h-full [&_iframe]:!max-h-none [&_iframe]:!min-h-0 [&_iframe]:!w-full",
        )}
      >
        {runtime}
        {resourceState === "empty" && EMPTY_MESSAGE}
      </div>
    );
  }

  // Owned-app chrome path: wait for the head version before mounting so this
  // render persists diagnostics under a concrete version.
  return (
    <div className="h-full w-full">
      {app && (
        <McpAppCard
          displayMode={displayMode}
          onToggleFullscreen={toggleFullscreen}
          size={null}
          inlineCeiling={inlineCeiling}
          fillContainer={fillContainer}
          topBar={
            <McpAppTopBar
              right={
                displayMode === "fullscreen" ? (
                  <McpAppFullscreenExitButton onClick={toggleFullscreen} />
                ) : undefined
              }
            >
              <McpAppAddressPill
                label={label ?? app.name}
                actions={
                  <>
                    <McpAppRefreshButton onClick={reload} />
                    {actions}
                  </>
                }
              />
            </McpAppTopBar>
          }
          bottomBar={
            appId && app.latestVersion != null ? (
              <McpAppVersionBar appId={appId} version={app.latestVersion} />
            ) : undefined
          }
        >
          {runtime}
        </McpAppCard>
      )}
      {resourceState === "empty" && EMPTY_MESSAGE}
    </div>
  );
}
