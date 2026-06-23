import * as SelectPrimitive from "@radix-ui/react-select";
import {
  AppWindow,
  ChevronDown,
  Minimize,
  PanelRight,
  RefreshCw,
  SquareArrowOutUpRight,
} from "lucide-react";
import Link from "next/link";
import type React from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** App-switcher config for the address pill: when set, the whole pill becomes a
 * dropdown (chevron on the far right) that switches between the chat's apps. */
export type McpAppSwitcher = {
  value: string | null;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
};

const PILL_CLASS =
  "flex h-7 w-80 min-w-0 max-w-full items-center gap-1 rounded-md border border-border/60 bg-background px-1";

/**
 * Browser-style top bar for an {@link McpAppCard}: a fixed-height row with a
 * centered, input-like address pill flanked by free `left` / `right` zones for
 * surface-specific actions. Inside the pill, `label` (the app name) sits at the
 * left like a URL and `actions` (refresh, open-in-panel, …) sit on the right.
 * When `switcher` is provided the whole pill acts as an app-switcher dropdown —
 * a chevron renders on the far right and clicking anywhere on the pill (except
 * the action buttons) opens it. The fixed height keeps the bar from shrinking
 * when a surface renders fewer controls.
 */
export function McpAppTopBar({
  left,
  label,
  actions,
  right,
  switcher,
}: {
  /** Actions to the left of the address pill. */
  left?: React.ReactNode;
  /** Address-pill content: a string renders as the app name, a node as-is. */
  label?: React.ReactNode;
  /** Icons inside the address pill, on the right. */
  actions?: React.ReactNode;
  /** Actions to the right of the address pill. */
  right?: React.ReactNode;
  /** When set, the pill becomes an app-switcher dropdown. */
  switcher?: McpAppSwitcher;
}) {
  const labelNode =
    typeof label === "string" ? (
      <span className="pointer-events-none min-w-0 flex-1 truncate px-1 text-xs text-muted-foreground">
        {label}
      </span>
    ) : (
      <div className="pointer-events-none flex min-w-0 flex-1 items-center px-1">
        {label}
      </div>
    );

  const pillBody = (
    <>
      {labelNode}
      {actions && (
        // z-10 keeps the buttons above the dropdown trigger overlay so their
        // own clicks fire instead of opening the switcher.
        <div className="relative z-10 flex shrink-0 items-center gap-0.5">
          {actions}
        </div>
      )}
      {switcher && (
        <ChevronDown className="pointer-events-none mr-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
    </>
  );

  return (
    <div className="grid h-9 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 border-b px-2">
      <div className="flex min-w-0 items-center justify-start gap-0.5">
        {left}
      </div>
      {switcher ? (
        <Select
          value={switcher.value ?? undefined}
          onValueChange={switcher.onChange}
        >
          <div className={cn(PILL_CLASS, "relative cursor-pointer")}>
            {/* Transparent trigger fills the pill so clicking the name/icon
                (pointer-events-none) opens the dropdown; the action buttons
                above it (z-10) keep their own clicks. */}
            <SelectPrimitive.Trigger
              aria-label="Switch app"
              className="absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="sr-only">
                <SelectPrimitive.Value />
              </span>
            </SelectPrimitive.Trigger>
            {pillBody}
          </div>
          <SelectContent>
            {switcher.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                <span className="truncate">{option.label}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <div className={PILL_CLASS}>{pillBody}</div>
      )}
      <div className="flex min-w-0 items-center justify-end gap-0.5">
        {right}
      </div>
    </div>
  );
}

/** Top-bar control that opens the right panel and shows this app there. */
export function McpAppSidebarButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-6 w-6 text-muted-foreground"
      onClick={onClick}
      aria-label="Show in sidebar"
      title="Show in sidebar"
    >
      <PanelRight className="h-3.5 w-3.5" />
    </Button>
  );
}

/** Reload (refresh) icon button for the address pill. */
export function McpAppRefreshButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-6 w-6 text-muted-foreground"
      onClick={onClick}
      aria-label="Reload app"
      title="Reload app"
    >
      <RefreshCw className="h-3.5 w-3.5" />
    </Button>
  );
}

/** Exit-fullscreen icon for the address pill; render only while fullscreen. */
export function McpAppFullscreenExitButton({
  onClick,
}: {
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-6 w-6 text-muted-foreground"
      onClick={onClick}
      aria-label="Exit fullscreen"
      title="Exit fullscreen"
    >
      <Minimize className="h-3.5 w-3.5" />
    </Button>
  );
}

/** Opens the owned app's standalone run page in a new tab. */
export function McpAppStandaloneButton({ appId }: { appId: string }) {
  return (
    <Button
      asChild
      variant="ghost"
      size="icon"
      className="h-6 w-6 text-muted-foreground"
      aria-label="Open standalone"
      title="Open standalone"
    >
      <Link href={`/apps/${appId}/run`} target="_blank" rel="noreferrer">
        <SquareArrowOutUpRight className="h-3.5 w-3.5" />
      </Link>
    </Button>
  );
}

/** Links to the owned app's detail page. */
export function McpAppAppsPageButton({ appId }: { appId: string }) {
  return (
    <Button
      asChild
      variant="ghost"
      size="icon"
      className="h-6 w-6 text-muted-foreground"
      aria-label="Go to Apps page"
      title="Go to Apps page"
    >
      <Link href={`/apps/${appId}`}>
        <AppWindow className="h-3.5 w-3.5" />
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

/** Bottom bar linking an owned app's version to its page. */
export function McpAppVersionBar({
  appId,
  version,
}: {
  appId: string;
  version: number;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center border-t px-2">
      <Button
        asChild
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs text-muted-foreground"
      >
        <Link href={`/apps/${appId}`}>Version {version}</Link>
      </Button>
    </div>
  );
}
