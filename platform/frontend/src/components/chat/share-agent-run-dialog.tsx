// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import { ShareLink } from "@/components/chat/share-link";
import { ResourcePermissionsDialog } from "@/components/resource-permissions";

export function ShareAgentRunDialog({
  taskId,
  open,
  onOpenChange,
}: {
  taskId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <ResourcePermissionsDialog
      resource="agentRun"
      scope={taskId}
      title="Session permissions"
      description="Share a read-only view of this session's output. Only its owner can use its live terminal or continue the session."
      open={open}
      onOpenChange={onOpenChange}
      lead={
        <ShareLink
          path={`/chat/runs/${taskId}`}
          label="Session link"
          toastMessage="Session link copied"
        />
      }
    />
  );
}
