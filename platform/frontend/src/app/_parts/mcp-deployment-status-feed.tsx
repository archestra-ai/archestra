"use client";

import {
  useMcpDeploymentFeedDriver,
  useMcpDeploymentStatuses,
} from "@/lib/mcp/mcp-server.query";

/**
 * Holds the shared MCP deployment-status subscription open for as long as the
 * signed-in app chrome is on screen. The feed itself is module-level and
 * reference counted, so every reader already sees the same statuses; mounting
 * it here is what keeps that one source alive while the user moves between
 * pages, instead of tearing the subscription down and replaying "loading" each
 * time the last page-level reader unmounts.
 *
 * It belongs inside the authenticated shell rather than at the root: the feed
 * is per-user, so there is nothing for it to subscribe to on the sign-in pages.
 *
 * Renders nothing—consumers read the feed through `useMcpDeploymentStatuses`.
 */
export function McpDeploymentStatusFeed() {
  useMcpDeploymentStatuses();
  useMcpDeploymentFeedDriver();

  return null;
}
