"use client";

import { Laptop } from "lucide-react";
import Link from "next/link";
import { openMcpBridgeSetup } from "@/components/mcp-bridge-setup";
import { badgeVariants } from "@/components/ui/badge";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { DESKTOP_MCP_COPY, DEVICES_HREF } from "@/lib/mcp/desktop-mcp";
import { cn } from "@/lib/utils/tailwind";

type StatusProps = {
  className?: string;
  /** A pill, like the other statuses of the registry table. */
  badge?: boolean;
};

/** The look of a status: a line with a laptop, or a pill in the table. */
function statusClass({ className, badge }: StatusProps): string {
  return badge
    ? cn(
        badgeVariants({ variant: "outline" }),
        "hover:bg-accent hover:text-accent-foreground",
        className,
      )
    : cn(
        "inline-flex items-center gap-1.5 underline-offset-2 hover:underline",
        className,
      );
}

function StatusIcon({ badge }: { badge?: boolean }) {
  return (
    <Laptop
      className={badge ? "shrink-0" : "h-3.5 w-3.5 shrink-0"}
      aria-hidden="true"
    />
  );
}

/**
 * A desktop MCP server the user linked that waits for their device: the MCP
 * bridge has not reported the server in operation yet. The Device tab says
 * why, so the status links there.
 */
export function DesktopMcpWaitingStatus(props: StatusProps) {
  return (
    <Link href={DEVICES_HREF} className={statusClass(props)}>
      <StatusIcon badge={props.badge} />
      <span>{DESKTOP_MCP_COPY.waiting}</span>
    </Link>
  );
}

/**
 * A desktop MCP server the user linked while no device of theirs runs the
 * MCP bridge: they unlinked it, or never set it up. It opens the MCP bridge
 * setup, the app-wide one: this status goes away once the device is linked,
 * and the dialog stays to say so.
 */
export function DesktopMcpNoDeviceStatus(props: StatusProps) {
  return (
    <UnstyledButton
      type="button"
      onClick={openMcpBridgeSetup}
      className={statusClass(props)}
    >
      <StatusIcon badge={props.badge} />
      <span>{DESKTOP_MCP_COPY.noDevice}</span>
    </UnstyledButton>
  );
}

/** A desktop MCP server on the user's device, its tools read. */
export function DesktopMcpAddedStatus({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <Laptop className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{DESKTOP_MCP_COPY.addedFromDevice}</span>
    </span>
  );
}
