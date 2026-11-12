import { Laptop } from "lucide-react";
import Link from "next/link";
import { DESKTOP_MCP_COPY, DEVICES_HREF } from "@/lib/mcp/desktop-mcp";
import { cn } from "@/lib/utils/tailwind";

/**
 * A desktop MCP server the user added that waits for their computer: the MCP
 * bridge has not reported the server in operation yet. The Devices tab says
 * why, so the status links there.
 */
export function DesktopMcpWaitingStatus({ className }: { className?: string }) {
  return (
    <Link
      href={DEVICES_HREF}
      className={cn(
        "inline-flex items-center gap-1.5 underline-offset-2 hover:underline",
        className,
      )}
    >
      <Laptop className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{DESKTOP_MCP_COPY.waiting}</span>
    </Link>
  );
}

/** A desktop MCP server on the user's computer, its tools read. */
export function DesktopMcpAddedStatus({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <Laptop className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{DESKTOP_MCP_COPY.added}</span>
    </span>
  );
}
