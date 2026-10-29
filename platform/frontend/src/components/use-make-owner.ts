// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import {
  ARCHESTRA_MCP_CATALOG_ID,
  type ResourcePermissionAction,
  type ScopedResource,
} from "@archestra/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useTransferAgentOwnership } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  type TransferResourceKind,
  useTransferResourceOwnership,
} from "@/lib/resource-ownership.query";

/**
 * "Make owner" for one object's access block: whether the viewer may hand the
 * object to another person, and the call that does it. The server gives the
 * new owner Full access and keeps the previous owner's grant.
 */
export function useMakeOwner({
  resource,
  scope,
  effectiveActions,
}: {
  resource: ScopedResource;
  scope: string;
  effectiveActions: readonly ResourcePermissionAction[];
}) {
  const kind = transferKinds[resource];
  const queryClient = useQueryClient();
  const agent = useTransferAgentOwnership();
  const other = useTransferResourceOwnership(
    kind === "agent" || !kind ? "skill" : kind,
  );
  // Plugins still transfer by role: only someone who manages every plugin.
  const { data: managesEveryPlugin } = useHasPermissions(
    { plugin: ["update"] },
    "*",
  );
  const mutation = kind === "agent" ? agent : other;
  const allowed =
    kind === "plugin"
      ? !!managesEveryPlugin
      : effectiveActions.includes("update") &&
        effectiveActions.includes("manage-permissions");
  const supported =
    !!kind &&
    scope !== "*" &&
    !(resource === "mcpRegistry" && scope === ARCHESTRA_MCP_CATALOG_ID);
  return {
    available: supported && allowed,
    isPending: mutation.isPending,
    makeOwner: async (ownerId: string) => {
      await mutation.mutateAsync({ id: scope, ownerId });
      await queryClient.invalidateQueries({
        queryKey: ["resource-permissions"],
      });
    },
  };
}

const transferKinds: Partial<
  Record<ScopedResource, TransferResourceKind | "agent">
> = {
  agent: "agent",
  mcpGateway: "agent",
  mcpRegistry: "catalog",
  app: "app",
  plugin: "plugin",
  project: "project",
  skill: "skill",
  externalAgent: "remoteAgent",
};
