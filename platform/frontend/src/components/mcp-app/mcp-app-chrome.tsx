import { RefreshCw } from "lucide-react";
import Link from "next/link";
import type React from "react";
import { Button } from "@/components/ui/button";

/**
 * Top-bar frame for an {@link McpAppCard}: a fixed-height 3-column grid
 * (left · center · right). The fixed height keeps the bar from shrinking when a
 * surface renders fewer controls. A string `center` renders as the app name; a
 * node renders as-is (e.g. an app-switcher select).
 */
export function McpAppTopBar({
  left,
  center,
  right,
}: {
  left?: React.ReactNode;
  center?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="grid h-9 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 border-b px-2">
      <div className="flex items-center justify-start">{left}</div>
      {typeof center === "string" ? (
        <span className="truncate text-center text-xs font-medium text-foreground">
          {center}
        </span>
      ) : (
        <div className="flex min-w-0 justify-center">{center}</div>
      )}
      <div className="flex items-center justify-end gap-0.5">{right}</div>
    </div>
  );
}

/** Reload (refresh) icon button for the top bar's left slot. */
export function McpAppRefreshButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-7 w-7 text-muted-foreground"
      onClick={onClick}
      aria-label="Reload app"
      title="Reload app"
    >
      <RefreshCw className="h-3.5 w-3.5" />
    </Button>
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
