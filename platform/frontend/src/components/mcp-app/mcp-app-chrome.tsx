import * as SelectPrimitive from "@radix-ui/react-select";
import {
  AppWindow,
  ArrowLeft,
  ChevronDown,
  type LucideIcon,
  Minimize2,
  PanelRight,
  RefreshCw,
  Settings,
  SquareArrowOutUpRight,
} from "lucide-react";
import Link from "next/link";
import type React from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem } from "@/components/ui/select";
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

const ICON_BUTTON_PROPS = {
  variant: "ghost",
  size: "icon",
  className: "h-6 w-6 text-muted-foreground",
} as const;

function McpAppIconButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      {...ICON_BUTTON_PROPS}
    >
      <Icon className="h-3.5 w-3.5" />
    </Button>
  );
}

export function McpAppPanelButton({ onClick }: { onClick: () => void }) {
  return (
    <McpAppIconButton
      icon={PanelRight}
      label="Show in panel"
      onClick={onClick}
    />
  );
}

export function McpAppRefreshButton({ onClick }: { onClick: () => void }) {
  return (
    <McpAppIconButton icon={RefreshCw} label="Reload app" onClick={onClick} />
  );
}

// Sized to match the panel header's collapse button (h-8 w-8 / h-4 w-4) rather
// than the smaller in-pill icons, so the gear's center lines up vertically with
// the collapse button directly above it.
export function McpAppSettingsButton({ onClick }: { onClick: () => void }) {
  return (
    <SettingsBarButton icon={Settings} label="App settings" onClick={onClick} />
  );
}

// Settings mode's left control: cancel and return to the live app.
export function McpAppBackButton({ onClick }: { onClick: () => void }) {
  return (
    <SettingsBarButton icon={ArrowLeft} label="Back to app" onClick={onClick} />
  );
}

// Settings mode's right control: submits the settings form (associated by id, so
// it can live in the top bar outside the form).
export function McpAppSaveButton({
  formId,
  disabled,
  saving,
}: {
  formId: string;
  disabled?: boolean;
  saving?: boolean;
}) {
  return (
    <Button
      type="submit"
      form={formId}
      disabled={disabled}
      aria-label="Save settings"
      size="sm"
      className="h-7 px-3 text-xs font-medium"
    >
      {saving ? "Saving…" : "Save"}
    </Button>
  );
}

function SettingsBarButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      variant="ghost"
      size="icon"
      className="h-8 w-8 text-muted-foreground"
    >
      <Icon className="h-4 w-4" />
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
      title="Open in new tab"
      {...ICON_BUTTON_PROPS}
    >
      <Link href={`/a/${appId}`} target="_blank" rel="noreferrer">
        <SquareArrowOutUpRight className="h-3.5 w-3.5" />
      </Link>
    </Button>
  );
}

/**
 * Compact, non-interactive changelog row for a superseded owned-app render — an
 * earlier render the conversation has since replaced with a newer one. Reuses
 * the address-pill look but is static: it marks the version this render produced
 * ("Dashboard · v2 · Updated") without mounting a live iframe. Only the latest
 * render of an app stays live.
 */
export function McpAppChangelogPill({
  appName,
  version,
  verb,
}: {
  appName: string | null;
  version: number | null;
  verb: string | null;
}) {
  return (
    <div className={cn(PILL_CLASS, "text-xs text-muted-foreground")}>
      <AppWindow className="mx-1 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate px-1">
        {appName ?? "App"}
        {version != null && ` · v${version}`}
        {verb && ` · ${verb}`}
      </span>
    </div>
  );
}
