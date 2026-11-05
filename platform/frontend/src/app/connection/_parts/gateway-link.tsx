"use client";

import Link from "next/link";
import { agentDetailHref } from "@/components/agent-pages/agent-page-config";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { cn } from "@/lib/utils/tailwind";

/**
 * A gateway's name, linked to its page when the viewer can open it. Without
 * read access the page would only refuse them, so the name stays plain text.
 */
export function GatewayLink({
  gateway,
  className,
}: {
  gateway: { id: string; name: string };
  className?: string;
}) {
  const { data: canRead } = useHasPermissions(
    { mcpGateway: ["read"] },
    gateway.id,
  );
  if (!canRead) return <span className={className}>{gateway.name}</span>;
  return (
    <Link
      href={agentDetailHref("mcp_gateway", gateway.id)}
      className={cn(
        "underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-foreground",
        className,
      )}
    >
      {gateway.name}
    </Link>
  );
}
