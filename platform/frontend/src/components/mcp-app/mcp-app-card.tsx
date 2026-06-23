import type { McpUiDisplayMode } from "@modelcontextprotocol/ext-apps";
import { RefreshCw } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import {
  clampInlineHeight,
  INITIAL_INLINE_HEIGHT,
} from "@/components/mcp-app/app-height";
import {
  type McpAppAction,
  McpAppActions,
} from "@/components/mcp-app/mcp-app-actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Shared chrome for every MCP App surface (chat, right panel, Apps page). A
 * single top bar holds the refresh control (left), the app name (center), and
 * the {@link McpAppActions} icons (right: fullscreen, side panel, …). Below it
 * sits an optional diagnostics badge and the app body — either the live runtime
 * (`children`) or, when `placeholder` is set, a frozen-height frosted stand-in
 * so moving an app into the side panel doesn't reflow chat.
 *
 * Uses a single stable tree for inline / fullscreen / fill so the iframe child
 * is never unmounted when toggling — only CSS classes change. In fullscreen,
 * uses `position: fixed` covering the viewport.
 */
export function McpAppCard({
  displayMode,
  onToggleFullscreen,
  children,
  diagnostics,
  size,
  inlineCeiling,
  fillContainer = false,
  appName,
  onRefresh,
  placeholder,
  frozenHeight,
  appId,
  actions,
  onShowInSidebar,
}: {
  displayMode: McpUiDisplayMode;
  /** Toggle inline ↔ fullscreen; also invoked by the Escape key while fullscreen. */
  onToggleFullscreen: () => void;
  children?: React.ReactNode;
  /**
   * Diagnostics badge rendered above the app. Kept out of `children` so the
   * fill/fullscreen `[&>div]:!h-full` stretch only hits the app surface — a
   * badge stretched to full height would shove the app below the fold.
   */
  diagnostics?: React.ReactNode;
  size: { width: number; height: number } | null;
  /** Viewport-derived max height for the inline card; reacts to window resize. */
  inlineCeiling: number;
  /** When true, the app fills its parent container (used when portaled to the panel). */
  fillContainer?: boolean;
  /** Center of the top bar. A string renders as the app name; a node (e.g. an
   * app-switcher select used in the panel) renders as-is. */
  appName?: React.ReactNode;
  /** Reload the iframe (bumps the runtime's reload nonce). Refresh icon hidden when absent. */
  onRefresh?: () => void;
  /**
   * When set, the body renders this node — frozen to `frozenHeight`, frosted —
   * instead of `children`. Used in chat while the live iframe lives in the panel.
   */
  placeholder?: React.ReactNode;
  /** Locked body height for the placeholder, so chat keeps the app's footprint. */
  frozenHeight?: number;
  appId?: string;
  actions: McpAppAction[];
  onShowInSidebar?: () => void;
}) {
  const isFullscreen = displayMode === "fullscreen";
  const [bounds, setBounds] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);

  useEffect(() => {
    if (!isFullscreen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onToggleFullscreen();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isFullscreen, onToggleFullscreen]);

  // Cover the entire viewport in fullscreen mode.
  useEffect(() => {
    if (!isFullscreen) {
      setBounds(null);
      return;
    }
    const update = () =>
      setBounds({
        top: 0,
        left: 0,
        width: window.innerWidth,
        height: window.innerHeight,
      });
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [isFullscreen]);

  return (
    <div
      className={cn(
        "will-change-auto origin-center transition-all duration-400 ease-[cubic-bezier(0.23,1,0.32,1)] relative group flex flex-col",
        isFullscreen ? "fixed z-[100] bg-background" : "",
        fillContainer && !isFullscreen ? "h-full" : "",
        !isFullscreen && !fillContainer
          ? "max-w-[80%] rounded-lg border border-border/50 shadow-xs overflow-hidden"
          : "",
        isFullscreen && !bounds
          ? "opacity-0 scale-95 pointer-events-none"
          : "opacity-100 scale-100",
      )}
      style={
        isFullscreen && bounds
          ? {
              top: bounds.top,
              left: bounds.left,
              width: bounds.width,
              height: bounds.height,
            }
          : undefined
      }
    >
      {/* Top bar: refresh (left) · name (center) · action icons (right). Fixed
          height (matches the h-7 icon buttons + padding) so the bar doesn't
          shrink when a surface renders fewer/no buttons — e.g. the placeholder. */}
      <div className="grid h-9 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 border-b px-2">
        <div className="flex items-center justify-start">
          {onRefresh && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground"
              onClick={onRefresh}
              aria-label="Reload app"
              title="Reload app"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
        {typeof appName === "string" ? (
          <span className="truncate text-center text-xs font-medium text-foreground">
            {appName}
          </span>
        ) : (
          <div className="flex min-w-0 justify-center">{appName}</div>
        )}
        <div className="flex items-center justify-end gap-0.5">
          <McpAppActions
            appId={appId}
            actions={actions}
            onShowInSidebar={onShowInSidebar}
            isFullscreen={isFullscreen}
            onToggleFullscreen={onToggleFullscreen}
          />
        </div>
      </div>

      {diagnostics && <div className="shrink-0">{diagnostics}</div>}

      {placeholder ? (
        <div
          style={
            frozenHeight != null ? { height: `${frozenHeight}px` } : undefined
          }
          className="flex items-center justify-center overflow-hidden bg-muted/30 text-xs backdrop-blur-sm"
        >
          {placeholder}
        </div>
      ) : (
        <div
          style={
            fillContainer && !isFullscreen
              ? undefined
              : {
                  maxHeight: isFullscreen
                    ? `${bounds?.height || 1000}px`
                    : `${clampInlineHeight(size?.height ?? INITIAL_INLINE_HEIGHT, inlineCeiling)}px`,
                }
          }
          className={cn(
            "transition-[max-height] duration-400 ease-[cubic-bezier(0.23,1,0.32,1)]",
            isFullscreen
              ? "flex-1 overflow-hidden [&_iframe]:!w-full [&_iframe]:!h-full [&_iframe]:!min-h-0 [&_iframe]:!max-h-none [&>div]:!h-full"
              : fillContainer
                ? "flex-1 min-h-0 overflow-hidden [&_iframe]:!w-full [&_iframe]:!h-full [&_iframe]:!min-h-0 [&_iframe]:!max-h-none [&>div]:!h-full"
                : "[&_iframe]:!w-full overflow-y-hidden [&_div]:!max-h-none",
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}
