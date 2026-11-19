"use client";

import { useHasPermissions } from "@/lib/auth/auth.query";
import { useOrganization } from "@/lib/organization.query";

/** Keep the sidebar, search and onboarding dots on the same visibility rule. */
export function useConnectNavigation() {
  const { data: organization } = useOrganization();
  const { data: canReadLlmProxy } = useHasPermissions({ llmProxy: ["read"] });
  const { data: canReadMcpGateway } = useHasPermissions({
    mcpGateway: ["read"],
  });
  // Wait for settings so a hidden page does not flash into navigation on load.
  const ready =
    !!organization &&
    canReadLlmProxy !== undefined &&
    canReadMcpGateway !== undefined;

  return {
    ready,
    visible:
      ready &&
      !organization.connectionPageHidden &&
      (canReadMcpGateway === true || canReadLlmProxy === true),
  };
}
