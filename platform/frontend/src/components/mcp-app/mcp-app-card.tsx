import type { McpUiDisplayMode } from "@modelcontextprotocol/ext-apps";
import type React from "react";
import { useEffect, useState } from "react";
import {
  type AppShellRegion,
  findAppShellMain,
  readAppShellRegion,
} from "@/lib/app-shell-region";
import { cn } from "@/lib/utils";

/**
 * Shared layout chrome for every MCP App surface (chat, right panel, Apps page).
 * Owns the card frame, the inline / fullscreen / fill geometry, and body sizing.
 * The per-surface controls are passed in as the `topBar` slot (side panel) or the
 * hover `overlay` slot (frameless chat inline) — see the building blocks in
 * `mcp-app-chrome` ({@link McpAppTopBar} / {@link McpAppRefreshButton} and the
 * discrete action buttons) — so the card itself stays free of action wiring.
 *
 * Uses a single stable tree for inline / fullscreen / fill so the iframe child
 * is never unmounted when toggling — only CSS classes change. In fullscreen it
 * is `position: fixed` over the app shell's main region rather than the
 * viewport, so the sidebar stays on screen: hiding the navigation is the
 * sidebar's own collapse control to do, not a side effect of enlarging an app.
 */
export function McpAppCard({
  displayMode,
  onToggleFullscreen,
  children,
  fillContainer = false,
  capInlineHeight = false,
  topBar,
  overlay,
}: {
  displayMode: McpUiDisplayMode;
  onToggleFullscreen: () => void;
  children?: React.ReactNode;
  fillContainer?: boolean;
  /**
   * Cap the (non-fullscreen, non-fill) inline body at 60% of the viewport
   * (floored at 320px) so a tall app can't push the chat off-screen; content
   * past the cap scrolls within the card. Only the chat-inline surface sets
   * this — the standalone page and right panel stay full height.
   */
  capInlineHeight?: boolean;
  topBar?: React.ReactNode;
  /**
   * Floating controls shown top-right on hover/focus, over the app body. Used by
   * the frameless chat-inline surface (which has no `topBar`) to keep the
   * fullscreen / show-in-panel affordances without a full browser bar.
   */
  overlay?: React.ReactNode;
}) {
  const isFullscreen = displayMode === "fullscreen";
  const [bounds, setBounds] = useState<AppShellRegion | null>(null);

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
    const update = () => setBounds(readAppShellRegion());
    update();
    // The main region also changes width when the sidebar is collapsed or
    // expanded, which no window resize reports — and it animates, so observing
    // the element keeps the app pinned to its edge for the whole transition.
    const main = findAppShellMain();
    const observer = main ? new ResizeObserver(update) : null;
    observer?.observe(main as HTMLElement);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [isFullscreen]);

  return (
    <div
      className={cn(
        "will-change-auto origin-center transition-all duration-400 ease-[cubic-bezier(0.23,1,0.32,1)] relative group flex flex-col",
        // Above the page's own content (the tallest of which is a z-20 sticky
        // divider) but below the z-50 portal layer, so a dialog opened from the
        // app's chrome — and the sidebar's collapse handle, which straddles the
        // main region's left edge — still sit on top of a fullscreen app.
        isFullscreen ? "fixed z-40 bg-background" : "",
        fillContainer && !isFullscreen ? "h-full" : "",
        !isFullscreen && !fillContainer
          ? "w-full max-w-[80%] rounded-lg border border-border/50 shadow-xs overflow-hidden"
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

      {overlay && (
        <div className="absolute top-2 right-2 z-20 flex items-center gap-0.5 rounded-md border border-border/50 bg-background/80 p-0.5 opacity-0 shadow-sm backdrop-blur-sm transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {overlay}
        </div>
      )}

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
                ? // The runtime already clamps the iframe to this cap and scrolls
                  // its content internally, so clip here (not `overflow-y-auto`)
                  // to avoid a second, outer scrollbar next to the iframe's.
                  "[&_iframe]:!w-full max-h-[max(320px,60vh)] overflow-hidden"
                : "[&_iframe]:!w-full",
        )}
      >
        {children}
      </div>
    </div>
  );
}
