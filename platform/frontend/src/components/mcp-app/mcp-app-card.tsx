import type { McpUiDisplayMode } from "@modelcontextprotocol/ext-apps";
import type React from "react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared layout chrome for every MCP App surface (chat, right panel, Apps page).
 * Owns the card frame, the inline / fullscreen / fill geometry, body sizing, and
 * the optional frozen placeholder. The per-surface controls are passed in as the
 * `topBar` slot — see the building blocks in `mcp-app-chrome`
 * ({@link McpAppTopBar} / {@link McpAppRefreshButton} and the discrete action
 * buttons) — so the card itself stays free of action wiring.
 *
 * Between the bars sit an optional diagnostics badge and the app body — either
 * the live runtime (`children`) or, when `placeholder` is set, a frozen-height
 * frosted stand-in so moving an app into the side panel doesn't reflow chat.
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
  fillContainer = false,
  capInlineHeight = false,
  placeholder,
  frozenHeight,
  topBar,
}: {
  displayMode: McpUiDisplayMode;
  onToggleFullscreen: () => void;
  children?: React.ReactNode;
  /**
   * Diagnostics badge rendered above the app. Kept out of `children` so the
   * fill/fullscreen `[&>div]:!h-full` stretch only hits the app surface — a
   * badge stretched to full height would shove the app below the fold.
   */
  diagnostics?: React.ReactNode;
  fillContainer?: boolean;
  /**
   * Cap the (non-fullscreen, non-fill) inline body at 60% of the viewport
   * (floored at 320px) so a tall app can't push the chat off-screen; content
   * past the cap scrolls within the card. Only the chat-inline surface sets
   * this — the standalone page and right panel stay full height.
   */
  capInlineHeight?: boolean;
  /**
   * When set, the body renders this node — frozen to `frozenHeight`, frosted —
   * instead of `children`. Used in chat while the live iframe lives in the panel.
   */
  placeholder?: React.ReactNode;
  frozenHeight?: number;
  topBar?: React.ReactNode;
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
      {topBar}

      {diagnostics && <div className="shrink-0">{diagnostics}</div>}

      {placeholder ? (
        <div
          style={
            frozenHeight != null ? { height: `${frozenHeight}px` } : undefined
          }
          className={cn(
            "flex items-center justify-center overflow-hidden bg-muted/30 text-xs backdrop-blur-sm",
            capInlineHeight && "max-h-[max(320px,60vh)]",
          )}
        >
          {placeholder}
        </div>
      ) : (
        <div
          style={
            isFullscreen
              ? { maxHeight: `${bounds?.height || 1000}px` }
              : undefined
          }
          className={cn(
            "transition-[max-height] duration-400 ease-[cubic-bezier(0.23,1,0.32,1)]",
            isFullscreen
              ? "flex-1 overflow-hidden [&_iframe]:!w-full [&_iframe]:!h-full [&_iframe]:!min-h-0 [&_iframe]:!max-h-none [&>div]:!h-full"
              : fillContainer
                ? "flex-1 min-h-0 overflow-hidden [&_iframe]:!w-full [&_iframe]:!h-full [&_iframe]:!min-h-0 [&_iframe]:!max-h-none [&>div]:!h-full"
                : capInlineHeight
                  ? "[&_iframe]:!w-full max-h-[max(320px,60vh)] overflow-y-auto"
                  : "[&_iframe]:!w-full",
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}
