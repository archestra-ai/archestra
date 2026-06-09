"use client";

import type { McpUiDisplayMode } from "@modelcontextprotocol/ext-apps";
import { useState } from "react";
import { McpAppRuntime } from "@/components/mcp-app/mcp-app-view";

// Mounts an app's runtime (sandboxed iframe + AppBridge) against the app-bound
// MCP endpoint, owning the display-mode/size state that chat's McpAppSection
// would otherwise supply. Used by the standalone run page and the detail preview.
export function AppRuntimeFrame({ appId }: { appId: string }) {
  const [displayMode, setDisplayMode] = useState<McpUiDisplayMode>("inline");
  const [resourceState, setResourceState] = useState<
    "unknown" | "renderable" | "empty"
  >("unknown");

  return (
    <div className="h-full w-full">
      <McpAppRuntime
        toolResourceUri={`ui://archestra-app/${appId}`}
        endpoint={{ kind: "app", appId }}
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
