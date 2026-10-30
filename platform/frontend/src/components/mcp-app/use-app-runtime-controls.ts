import type { McpUiDisplayMode } from "@modelcontextprotocol/ext-apps";
import { useCallback, useState } from "react";
import { isRenderableMcpAppHtml } from "@/components/mcp-app/mcp-app-view";

type ResourceState = "unknown" | "renderable" | "empty" | "error";

/**
 * Shared runtime-frame state every MCP App surface needs: the display mode
 * (inline ↔ fullscreen), a reload nonce that remounts the sandboxed iframe, and
 * the resolved resource state (renderable, empty, or failed). Extracted so the
 * page frame ({@link AppFrame}) and chat's `McpAppSection` don't each re-implement
 * the same `useState` + handlers.
 *
 * `initialHtml` seeds `resourceState` from a pre-fetched (SSE) resource so a
 * surface that already has the HTML renders without a flash of "unknown".
 */
export function useAppRuntimeControls(initialHtml?: string) {
  const [displayMode, setDisplayMode] = useState<McpUiDisplayMode>("inline");
  const [reloadNonce, setReloadNonce] = useState(0);
  const [isReloading, setIsReloading] = useState(false);
  const [resourceState, setResourceState] = useState<ResourceState>(() =>
    initialHtml === undefined
      ? "unknown"
      : isRenderableMcpAppHtml(initialHtml)
        ? "renderable"
        : "empty",
  );

  const toggleFullscreen = useCallback(
    () => setDisplayMode((m) => (m === "fullscreen" ? "inline" : "fullscreen")),
    [],
  );
  const reload = useCallback(() => {
    setIsReloading(true);
    setReloadNonce((n) => n + 1);
  }, []);
  const completeReload = useCallback(() => {
    setIsReloading(false);
  }, []);

  return {
    displayMode,
    setDisplayMode,
    toggleFullscreen,
    reloadNonce,
    isReloading,
    reload,
    completeReload,
    resourceState,
    setResourceState,
  };
}
