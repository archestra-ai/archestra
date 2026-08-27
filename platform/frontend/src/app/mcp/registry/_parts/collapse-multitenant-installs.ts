import type {
  McpDeploymentStatusEntry,
  ResourceVisibilityScope,
} from "@archestra/shared";

interface CollapsibleInstall {
  id: string;
  name: string;
  ownerEmail?: string | null;
  teamDetails?: { teamId: string; name: string } | null;
  scope?: ResourceVisibilityScope | null;
  canUseCredential?: boolean;
}

/**
 * A multi-tenant catalog runs ONE shared deployment for every install, so the
 * diagnostics panel shows a single row labelled by the catalog rather than one
 * row per member.
 *
 * Which install backs that row matters twice over. Pod diagnostics need one
 * that actually reports the shared deployment's status, and the Inspector
 * authenticates as it — so among the rows that report a pod, the viewer's own
 * connection wins. Without that preference the collapsed row could be a
 * colleague's connection, and inspecting it would either borrow their
 * credential or fail as forbidden.
 */
export function collapseMultitenantInstalls<
  T extends CollapsibleInstall,
>(params: {
  installs: T[];
  deploymentStatuses: Record<string, McpDeploymentStatusEntry>;
  catalogName: string;
}): T[] {
  const { installs, deploymentStatuses, catalogName } = params;
  const reportsPod = (install: T) => !!deploymentStatuses[install.id]?.podName;

  const backing =
    installs.find((i) => i.canUseCredential !== false && reportsPod(i)) ??
    installs.find(reportsPod) ??
    installs.find((i) => i.canUseCredential !== false) ??
    installs[0];

  if (!backing) return [];

  return [
    {
      ...backing,
      name: catalogName,
      ownerEmail: null,
      teamDetails: null,
      scope: null,
    },
  ];
}
