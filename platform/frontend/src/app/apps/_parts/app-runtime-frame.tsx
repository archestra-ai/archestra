"use client";

import { getArchestraAppResourceUri } from "@archestra/shared";
import type { McpUiDisplayMode } from "@modelcontextprotocol/ext-apps";
import { useState } from "react";
import { McpAppRuntime } from "@/components/mcp-app/mcp-app-view";
import { useApp } from "@/lib/app.query";

// Mounts an app's runtime (sandboxed iframe + AppBridge) against the app-bound
// MCP endpoint, owning the display-mode/size state that chat's McpAppSection
// would otherwise supply. Used by the standalone run page and the detail preview.
export function AppRuntimeFrame({ appId }: { appId: string }) {
  const [displayMode, setDisplayMode] = useState<McpUiDisplayMode>("inline");
  const [resourceState, setResourceState] = useState<
    "unknown" | "renderable" | "empty"
  >("unknown");
  // Resolve the head version before mounting so this render persists
  // diagnostics under a concrete version — mounting earlier would capture (and
  // then discard) entries against a null version while the metadata loads.
  const { data: app } = useApp(appId);

  return (
    <div className="h-full w-full">
      {app && (
        <McpAppRuntime
          toolResourceUri={getArchestraAppResourceUri(appId)}
          endpoint={{ kind: "app", appId }}
          appVersion={app.latestVersion}
          displayMode={displayMode}
          onDisplayModeChange={setDisplayMode}
          onSizeChange={() => {}}
          onResourceStateChange={setResourceState}
        />
      )}
      {resourceState === "empty" && (
        <p className="p-4 text-sm text-muted-foreground">
          This app has no visible content yet.
        </p>
      )}
    </div>
  );
}
