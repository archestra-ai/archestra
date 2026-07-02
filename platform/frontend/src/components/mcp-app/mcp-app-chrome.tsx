import {
  AppWindow,
  type LucideIcon,
  Minimize2,
  RefreshCw,
  Settings,
  SquareArrowOutUpRight,
} from "lucide-react";
import Link from "next/link";
import type React from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Ghost icon + text button shared by the app top bar's labeled actions. */
const LABELED_BUTTON_CLASS =
  "h-auto gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-foreground";

/**
 * Pure-layout top bar for an {@link McpAppCard}: a fixed-height row with a
 * left-aligned `left` zone that grows and a right-aligned `right` zone that hugs
 * the far edge. The fixed height keeps the bar from shrinking when a surface
 * renders fewer controls.
 */
export function McpAppTopBar({
  left,
  right,
}: {
  left?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="relative z-10 flex h-9 shrink-0 items-center gap-2 px-2 shadow-[0_1px_2px_-1px_rgb(0_0_0/0.08)]">
      <div className="flex min-w-0 flex-1 items-center justify-start gap-0.5">
        {left}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-0.5">
        {right}
      </div>
    </div>
  );
}

// Two sizes: "sm" (h-6 w-6) for the frameless-inline hover overlay's compact
// icons, "bar" (h-8 w-8) for the side-panel header where buttons line up with the
// panel's collapse button.
type McpAppButtonSize = "sm" | "bar";

const sizeClasses = (size: McpAppButtonSize) =>
  size === "bar" ? "h-8 w-8" : "h-6 w-6";
const iconClasses = (size: McpAppButtonSize) =>
  size === "bar" ? "h-4 w-4" : "h-3.5 w-3.5";

function McpAppIconButton({
  icon: Icon,
  label,
  onClick,
  size = "sm",
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  size?: McpAppButtonSize;
}) {
  return (
    <Button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      variant="ghost"
      size="icon"
      className={cn("text-muted-foreground", sizeClasses(size))}
    >
      <Icon className={iconClasses(size)} />
    </Button>
  );
}

export function McpAppRefreshButton({
  onClick,
  size = "sm",
}: {
  onClick: () => void;
  size?: McpAppButtonSize;
}) {
  return (
    <McpAppIconButton
      icon={RefreshCw}
      label="Reload app"
      onClick={onClick}
      size={size}
    />
  );
}

export function McpAppSettingsButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      type="button"
      onClick={onClick}
      variant="ghost"
      size="sm"
      className={LABELED_BUTTON_CLASS}
    >
      <Settings className="h-3.5 w-3.5" />
      Settings
    </Button>
  );
}

export function McpAppFullscreenExitButton({
  onClick,
}: {
  onClick: () => void;
}) {
  return (
    <McpAppIconButton
      icon={Minimize2}
      label="Exit fullscreen"
      onClick={onClick}
    />
  );
}

export function McpAppStandaloneButton({ appId }: { appId: string }) {
  return (
    <Button
      asChild
      aria-label="Open in new tab"
      variant="ghost"
      size="sm"
      className={LABELED_BUTTON_CLASS}
    >
      <Link href={`/a/${appId}`} target="_blank" rel="noreferrer">
        <SquareArrowOutUpRight className="h-3.5 w-3.5" />
        Open in new tab
      </Link>
    </Button>
  );
}

/**
 * Interactive app-icon pill shown next to a tool-call circle in the chat, and
 * the toggle for the app's inline render — like a tool-call pill toggles its
 * content. `pressed` means the app is visible inline (its content is expanded
 * under the pill). It reads unpressed while the app is hosted in the right panel
 * (you're looking at the panel copy). `hasError` shows a red status dot for a
 * runtime error, matching the tool-call circles.
 */
export function McpAppMarkerCircle({
  label,
  pressed = false,
  hasError = false,
  onClick,
}: {
  /** Tooltip text — the app name. */
  label: string;
  /** Pressed = the app's inline render is expanded under the pill. */
  pressed?: boolean;
  /** Show a red status dot for an app runtime error. */
  hasError?: boolean;
  onClick: () => void;
}) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onClick}
            aria-label={label}
            aria-pressed={pressed}
            className={cn(
              "relative inline-flex size-8 items-center justify-center rounded-full border transition-all hover:border-accent-foreground/20 hover:bg-accent hover:text-foreground",
              pressed
                ? "border-accent-foreground/20 bg-accent text-foreground ring-2 ring-primary/20"
                : "bg-background text-muted-foreground",
            )}
          >
            <AppWindow className="h-4 w-4" />
            {hasError ? (
              <span className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-background bg-destructive" />
            ) : null}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
