"use client";

import { StandardDialog } from "@/components/standard-dialog";
import { AppToolsEditor } from "./app-tools-editor";

export function AppManageToolsDialog({
  appId,
  open,
  onOpenChange,
}: {
  appId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <StandardDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Manage tools"
      description="Choose which MCP tools this app can call, grouped by server."
      size="medium"
      bodyClassName="overflow-y-auto"
    >
      <AppToolsEditor appId={appId} />
    </StandardDialog>
  );
}
