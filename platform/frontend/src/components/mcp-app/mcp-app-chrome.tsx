import * as SelectPrimitive from "@radix-ui/react-select";
import {
  AppWindow,
  ChevronDown,
  type LucideIcon,
  Minimize2,
  RefreshCw,
  Settings,
  SquareArrowOutUpRight,
} from "lucide-react";
import Link from "next/link";
import type React from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem } from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const PILL_CLASS =
  "flex h-7 w-80 @max-lg:w-64 @max-md:w-full min-w-0 max-w-full items-center gap-1 rounded-md border border-border/60 bg-background px-1";

/**
 * Pure-layout browser-style top bar for an {@link McpAppCard}: a fixed-height row
 * with a centered pill (`children`) flanked by free `left` / `right` zones. The
 * fixed height keeps the bar from shrinking when a surface renders fewer
 * controls. The center pill is composed by the caller — a static
 * {@link McpAppAddressPill} or an {@link McpAppSwitcher} — so the bar itself
 * carries no app-switching knowledge.
 */
export function McpAppTopBar({
  left,
  children,
  right,
}: {
  left?: React.ReactNode;
  children?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="@container relative z-10 grid h-9 shrink-0 grid-cols-[1fr_auto_1fr] @max-md:grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-2 shadow-[0_1px_2px_-1px_rgb(0_0_0/0.08)]">
      <div className="flex min-w-0 items-center justify-start gap-0.5">
        {left}
      </div>
      {children}
      <div className="flex min-w-0 items-center justify-end gap-0.5">
        {right}
      </div>
    </div>
  );
}

// z-10 keeps the action buttons above the switcher's dropdown trigger overlay so
// their own clicks fire instead of opening the dropdown.
function PillActions({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <div className="relative z-10 flex shrink-0 items-center gap-0.5">
      {children}
    </div>
  );
}

/** Static address pill: the app name with optional inline action buttons. */
export function McpAppAddressPill({
  label,
  leading,
  actions,
  className,
}: {
  label?: React.ReactNode;
  leading?: React.ReactNode;
  actions?: React.ReactNode;
  /** Overrides the pill's default fixed width (e.g. `w-full` in a narrow panel). */
  className?: string;
}) {
  return (
    <div className={cn(PILL_CLASS, className)}>
      {leading ? (
        <div className="relative z-10 flex shrink-0 items-center">
          {leading}
        </div>
      ) : null}
      <span className="pointer-events-none min-w-0 flex-1 truncate px-1 text-xs text-muted-foreground">
        {label}
      </span>
      <PillActions>{actions}</PillActions>
    </div>
  );
}

/**
 * Address pill that doubles as an app-switcher dropdown: the whole pill is a
 * Select trigger (chevron on the far right) while inline `actions` stay clickable
 * above it. Consumers that host several apps (e.g. the side panel) drop this into
 * an {@link McpAppTopBar} in place of {@link McpAppAddressPill}.
 */
export function McpAppSwitcher({
  value,
  options,
  onChange,
  leading,
  actions,
  className,
}: {
  value: string | null;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  leading?: React.ReactNode;
  actions?: React.ReactNode;
  /** Overrides the pill's default fixed width (e.g. `w-full` in a narrow panel). */
  className?: string;
}) {
  const selectedLabel = options.find((o) => o.value === value)?.label;
  return (
    <Select value={value ?? undefined} onValueChange={onChange}>
      <div className={cn(PILL_CLASS, "relative cursor-pointer", className)}>
        {/* Transparent trigger fills the pill so clicking the name/icon
            (pointer-events-none) opens the dropdown; the leading/action buttons
            above it (z-10) keep their own clicks. */}
        <SelectPrimitive.Trigger
          aria-label="Switch app"
          className="absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="sr-only">
            <SelectPrimitive.Value />
          </span>
        </SelectPrimitive.Trigger>
        {leading ? (
          <div className="relative z-10 flex shrink-0 items-center">
            {leading}
          </div>
        ) : null}
        <span className="pointer-events-none min-w-0 flex-1 truncate px-1 text-xs text-muted-foreground">
          {selectedLabel}
        </span>
        <PillActions>{actions}</PillActions>
        <ChevronDown className="pointer-events-none mr-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </div>
      <SelectContent
        position="popper"
        className="w-[var(--radix-select-trigger-width)]"
      >
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            <span className="truncate">{option.label}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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
    <McpAppIconButton
      icon={Settings}
      label="App settings"
      onClick={onClick}
      size="bar"
    />
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

export function McpAppStandaloneButton({
  appId,
  size = "sm",
}: {
  appId: string;
  size?: McpAppButtonSize;
}) {
  return (
    <Button
      asChild
      aria-label="Open in new tab"
      title="Open in new tab"
      variant="ghost"
      size="icon"
      className={cn("text-muted-foreground", sizeClasses(size))}
    >
      <Link href={`/a/${appId}`} target="_blank" rel="noreferrer">
        <SquareArrowOutUpRight className={iconClasses(size)} />
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
