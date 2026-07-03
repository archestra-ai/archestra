"use client";

import { getArchestraAppResourceUri } from "@archestra/shared";
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
 * Bare full-page MCP App runtime, shared by the owned-app standalone run page
 * (`/a/[appId]`) and the external catalog run page (`/a/catalog/[catalogId]`).
 * Wires the shared runtime-frame state (display mode / reload / resource state)
 * around {@link McpAppRuntime} with no Archestra chrome — each run page owns its
 * own header.
 *
 * Owned apps (`endpoint.kind === "app"`) derive their resource URI + head
 * version from the app id; external servers pass an explicit `resourceUri`.
 */
export function AppFrame({
  endpoint,
  resourceUri,
  fillContainer = false,
}: {
  endpoint:
    | { kind: "app"; appId: string }
    | { kind: "server"; mcpServerId: string };
  /** Required for server endpoints; owned apps derive it from the app id. */
  resourceUri?: string;
  fillContainer?: boolean;
}) {
  const {
    displayMode,
    setDisplayMode,
    reloadNonce,
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
