// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import { CopyableCode } from "@/components/copyable-code";
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
    >
      <CopyableCode
        value={`${typeof window === "undefined" ? "" : window.location.origin}/chat/runs/${taskId}`}
        toastMessage="Session link copied"
      />
    </ResourcePermissionsDialog>
  );
}
